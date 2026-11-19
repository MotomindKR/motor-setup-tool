'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { argsFor, Backend, backendPath } = require('./backend');

const selectedMotor = { can: 'can0', id: 1, expectedUuid: '0102030405060708' };

test('motor operations use the selected actuator and require the appropriate approval', () => {
  for (const [operation, options] of [
    ['calibrate', { config: {}, reviewed: true }],
    ['manual', { config: {} }],
    ['zero', { confirmed: true }],
    ['setId', { newId: 2, confirmed: true }],
  ]) {
    const params = { ...selectedMotor, ...options };
    const args = argsFor(operation, params);
    assert.equal(args[args.indexOf('--expected-uuid') + 1], selectedMotor.expectedUuid);
    assert.throws(() => argsFor(operation, { ...params, expectedUuid: '' }), /UUID/);
    if (operation !== 'manual') {
      assert.throws(() => argsFor(operation, { ...params, confirmed: false, reviewed: false }), /Review|Confirm/);
    }
  }
  assert.throws(() => argsFor('firmwareUpdate', selectedMotor), /Confirm/);
  assert.throws(() => argsFor('setId', { ...selectedMotor, confirmed: true, newId: 255 }), /New motor ID/);
});

test('discovery accepts valid CAN targets and rejects unsupported addresses', () => {
  for (const can of ['can0', 'gsusb:303033:79', 'gsusb:00:79']) {
    assert.doesNotThrow(() => argsFor('scan', { can }));
  }
  for (const can of ['invalid interface', 'gsusb:0:79', 'gsusb:303033:999', 'serial:1234']) {
    assert.throws(() => argsFor('scan', { can }), /CAN interface/);
  }
});

test('register writes require an editable setting, a valid value and a prior reading', () => {
  const params = {
    ...selectedMotor, model: 'RS-00', index: 0x702B, value: -1.25,
    confirmed: true, uuid: selectedMotor.expectedUuid, expectedRaw: '00000000',
  };
  const args = argsFor('registerWrite', params);
  assert.equal(args[args.indexOf('--uuid') + 1], params.uuid);
  assert.equal(args[args.indexOf('--expected-raw') + 1], params.expectedRaw);
  for (const invalid of [{ confirmed: false }, { model: 'RS-01' }, { value: NaN }, { expectedRaw: '' }, { index: 0x7006 }]) {
    assert.throws(() => argsFor('registerWrite', { ...params, ...invalid }));
  }
});

test('manual control forwards a reviewed jog within the allowed speed range', { skip: process.platform === 'win32' }, async t => {
  const backend = worker(t, `read -r config
read -r intent
printf '{"type":"result","value":%s}\n' "$intent"`);
  const job = backend.run('manual', { ...selectedMotor, config: {} });
  const intent = { enabled: true, reviewed: true, direction: -1, speed: 0.5 };
  assert.throws(() => backend.manualIntent({ ...intent, direction: 2 }), /Invalid manual intent/);
  assert.throws(() => backend.manualIntent({ ...intent, speed: 2 }), /Invalid manual intent/);
  backend.manualIntent(intent);
  assert.deepEqual(await job, { type: 'intent', ...intent });
});

test('a second process cannot start while one is active', async () => {
  const backend = new Backend(process.execPath, () => {});
  const first = backend.run('interfaces');
  assert.throws(() => backend.run('interfaces'), /Finish or stop/);
  await assert.rejects(first);
  await assert.rejects(backend.run('interfaces'));
});

test('backend selection never falls back from a missing bundle or release to another binary', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'motor-backend-path-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binary = process.platform === 'win32' ? 'motor-setup-tool.exe' : 'motor-setup-tool';
  const release = path.join(directory, 'target', 'release', binary);
  const debug = path.join(directory, 'target', 'debug', binary);
  const resources = path.join(directory, 'resources');
  const bundled = path.join(resources, 'backend', binary);
  for (const filename of [release, debug]) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, 'test backend');
  }
  assert.equal(backendPath(directory, null, ''), release);
  assert.throws(() => backendPath(directory, resources, debug), /Bundled Rust backend missing/);
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.writeFileSync(bundled, 'test bundle');
  assert.equal(backendPath(directory, resources, debug), bundled);
  fs.unlinkSync(release);
  assert.throws(() => backendPath(directory, null, ''), /cargo build --release/);
  assert.equal(backendPath(directory, null, debug), debug);
  assert.throws(() => backendPath(directory, null, release), /Rust backend missing/);
});

function worker(t, script, emit = () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'motor-worker-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'backend');
  fs.writeFileSync(binary, '#!/bin/sh\n' + script, { mode: 0o755 });
  return new Backend(binary, emit);
}

test('worker errors include the termination signal and diagnostic', { skip: process.platform === 'win32' }, async t => {
  const backend = worker(t, "echo 'fixture error' >&2\nkill -TERM $$");
  await assert.rejects(backend.run('interfaces'), /SIGTERM[\s\S]*fixture error/);
  await assert.rejects(backend.preview({}), /SIGTERM[\s\S]*fixture error/);
});

test('a cancelled job finishes before another can start', { skip: process.platform === 'win32' }, async t => {
  const backend = worker(t, `cat >/dev/null
echo '{"type":"result","value":{"cancelled":true}}'`);
  const result = backend.run('interfaces');
  assert.equal(backend.cancel(), true);
  assert.throws(() => backend.run('interfaces'), /Finish or stop/);
  assert.deepEqual(await result, { cancelled: true });
  assert.equal(backend.cancel(), false);
});

test('a job delivers progress and reports its failure to the caller', { skip: process.platform === 'win32' }, async t => {
  const events = [];
  const backend = worker(t, `echo '{"type":"progress","message":"측정","percent":7}'
echo 'CAN connection lost' >&2
exit 1`, event => events.push(event));
  await assert.rejects(backend.run('interfaces'), /CAN connection lost/);
  assert.ok(events.some(event => event.type === 'progress' && event.message === '측정' && event.percent === 7));
});
