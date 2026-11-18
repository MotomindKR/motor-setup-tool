'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { argsFor, Backend, backendPath } = require('./backend');

test('hardware operations require explicit review and validated targets', () => {
  assert.throws(() => argsFor('calibrate', { can: 'can0', id: 1 }), /Review/);
  assert.throws(() => argsFor('calibrate', { can: 'can0', id: 1, reviewed: true }), /configuration missing/);
  for (const operation of ['info', 'monitor', 'jog', 'firmwareCheck']) assert.throws(() => argsFor(operation), /Unknown operation/);
  assert.throws(() => argsFor('zero', { can: 'can0', id: 1 }), /Confirm/);
  assert.throws(() => argsFor('firmwareUpdate', { can: 'can0', id: 1 }), /Confirm/);
  assert.throws(() => argsFor('stop', { can: 'can0;touch /tmp/pwned', id: 1 }), /CAN interface/);
  assert.throws(() => argsFor('setId', { can: 'can0', id: 1, newId: 255, confirmed: true }), /New motor ID/);
  assert.throws(() => argsFor('plan', { model: 'RS-99' }), /Unknown motor/);
  assert.deepEqual(argsFor('scan', { can: 'can0', hostId: 253 }), ['scan', '--can', 'can0', '--host-id', '253']);
  assert.deepEqual(argsFor('calibrate', { can: 'can0', id: 1, reviewed: true, config: {} }), ['calibrate', '--can', 'can0', '--host-id', '253', '--id', '1', '--config-stdin', '--yes']);
  assert.deepEqual(argsFor('manual', { can: 'can0', id: 1, config: {} }), ['manual-session', '--can', 'can0', '--host-id', '253', '--id', '1']);
  assert.deepEqual(argsFor('firmwarePrepare', { can: 'can0', id: 1 }), ['firmware', 'prepare', '--can', 'can0', '--host-id', '253', '--id', '1']);
  assert.deepEqual(argsFor('canRestart', { can: 'can0' }), ['can', 'restart', 'can0', '--auth', 'polkit']);
  assert.deepEqual(argsFor('usbAdapters'), ['can', 'usb-list']);
  assert.deepEqual(argsFor('registerList', { model: 'RS-00' }), ['register', 'list', '--model', 'RS-00']);
  assert.deepEqual(argsFor('registerRead', { can: 'can0', id: 1, model: 'RS-00', index: 0x7010 }), ['register', 'read', '--can', 'can0', '--host-id', '253', '--id', '1', '--index', '0x7010']);
  assert.throws(() => argsFor('registerRead', { can: 'can0', id: 1, model: 'RS-00', index: 0x7005 }), /documented register/);
  assert.throws(() => argsFor('registerWrite', { can: 'can0', id: 1, model: 'RS-00', index: 0x7010 }), /Confirm/);
  assert.throws(() => argsFor('registerWrite', { can: 'can0', id: 1, model: 'RS-00', index: 0x7017, value: 1, uuid: '0000000000000000', expectedRaw: '0000803F', confirmed: true }), /documented register/);
  assert.deepEqual(argsFor('registerWrite', { can: 'can0', id: 1, model: 'RS-00', index: 0x7010, value: 2.5, uuid: '0000000000000000', expectedRaw: '0000803F', confirmed: true }), ['register', 'write', '--can', 'can0', '--host-id', '253', '--id', '1', '--index', '0x7010', '--value', '2.5', '--uuid', '0000000000000000', '--expected-raw', '0000803F', '--yes']);
  assert.deepEqual(argsFor('scan', { can: 'gsusb:303033:79', hostId: 253 }), ['scan', '--can', 'gsusb:303033:79', '--host-id', '253']);
  assert.deepEqual(argsFor('scan', { can: 'gsusb:00:79', hostId: 253 }), ['scan', '--can', 'gsusb:00:79', '--host-id', '253']);
  assert.throws(() => argsFor('scan', { can: 'gsusb:0:79' }), /CAN interface/);
  assert.throws(() => argsFor('scan', { can: 'gsusb:303033:999' }), /CAN interface/);
  assert.throws(() => argsFor('scan', { can: 'slcan:canable:921600:/dev/ttyUSB0' }), /CAN interface/);
  assert.throws(() => argsFor('serialPorts'), /Unknown operation/);
  assert.deepEqual(argsFor('calibrate', { can: 'can0', id: 1, reviewed: true, config: {}, output: path.join(os.tmpdir(), 'new-calibration') }), ['calibrate', '--can', 'can0', '--host-id', '253', '--id', '1', '--output', path.join(os.tmpdir(), 'new-calibration'), '--config-stdin', '--yes']);
});

test('persistent CAN aliases pass through the bridge while motion targets stay blocked', () => {
  const params = { model: 'RS-00', can: 'can0', id: 1, confirmed: true, uuid: '0102030405060708', expectedRaw: '00000000' };
  for (const [index, value] of [[0x7029, 1], [0x702B, -1.25]]) {
    const args = argsFor('registerWrite', { ...params, index, value });
    assert.equal(args[args.indexOf('--index') + 1], `0x${index.toString(16).toUpperCase()}`);
    assert.equal(args[args.indexOf('--value') + 1], String(value));
    assert.equal(argsFor('registerRead', { ...params, index }).at(-1), `0x${index.toString(16).toUpperCase()}`);
  }
  for (const index of [0x7005, 0x7006, 0x700A, 0x7016, 0x7028, 0x702D, 0xFFFF]) {
    assert.throws(() => argsFor('registerWrite', { ...params, index, value: 1 }), /documented register/);
  }
  assert.throws(() => argsFor('registerWrite', { ...params, index: 0x702B, value: NaN }), /Register value/);
});

test('manual intent sends the live reviewed direction and rejects invalid speed', () => {
  const sent = [];
  const backend = new Backend(process.execPath, () => {});
  backend.active = { operation: 'manual', child: { stdin: { destroyed: false, writableLength: 0, write: line => sent.push(JSON.parse(line)) } } };
  backend.manualIntent({ enabled: true, reviewed: true, direction: -1, speed: 0.5 });
  assert.deepEqual(sent, [{ type: 'intent', enabled: true, reviewed: true, direction: -1, speed: 0.5 }]);
  assert.throws(() => backend.manualIntent({ enabled: true, reviewed: true, direction: 2, speed: 0.5 }), /Invalid manual intent/);
  assert.throws(() => backend.manualIntent({ enabled: true, reviewed: true, direction: 0, speed: 2 }), /Invalid manual intent/);
});

test('RS-10P and model-specific register permissions pass through the bridge', () => {
  assert.deepEqual(argsFor('plan', { model: 'RS-10P' }), ['plan', '--model', 'RS-10P']);
  assert.deepEqual(argsFor('registerList', { model: 'RS-10P' }), ['register', 'list', '--model', 'RS-10P']);
  const p = { can: 'can0', id: 1, model: 'RS-10P', index: 0x701F };
  assert.equal(argsFor('registerRead', p).at(-1), '0x701F');
  assert.throws(() => argsFor('registerRead', { ...p, index: 0x2014 }), /documented register/);
  assert.throws(() => argsFor('registerRead', { ...p, model: 'RS-06', index: 0x7021 }), /documented register/);
  assert.throws(() => argsFor('registerRead', { ...p, model: 'RS-01', index: 0x702B }), /documented register/);
  assert.throws(() => argsFor('registerRead', { ...p, model: undefined }), /supported motor/);
});

test('a second process cannot start while one is active', async () => {
  const backend = new Backend(process.execPath, () => {});
  const first = backend.run('interfaces');
  assert.throws(() => backend.run('interfaces'), /Finish or stop/);
  await assert.rejects(first);
  assert.equal(backend.active, null);
});

test('firmware transfer cannot be cancelled after transfer starts', () => {
  const backend = new Backend(process.execPath, () => {});
  backend.active = { child: { kill() { throw new Error('must not be called'); } }, transferStarted: true };
  assert.throws(() => backend.cancel(), /wait for it to finish/);
});

test('cancellation retains the active job until the child exits', () => {
  const backend = new Backend(process.execPath, () => {});
  let signal;
  backend.active = {
    operation: 'manual', transferStarted: false, cancelRequested: false,
    child: { pid: 123, kill(value) { signal = value; return true; } },
  };
  assert.equal(backend.cancel(), true);
  assert.equal(signal, 'SIGTERM');
  assert.equal(backend.active.cancelRequested, true);
  assert.throws(() => backend.run('interfaces'), /Finish or stop/);
  backend.active = null;
  assert.equal(backend.cancel(), false);
});

test('cancellation handles a failed spawn without a PID', () => {
  const backend = new Backend(process.execPath, () => {});
  backend.active = { transferStarted: false, cancelRequested: false, child: { pid: undefined, kill() { throw new Error('must not be called'); } } };
  assert.equal(backend.cancel(), true);
  assert.equal(backend.active.cancelRequested, true);
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

test('backend signal exits report the signal and stderr instead of status null', { skip: process.platform === 'win32' }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'motor-backend-signal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'backend');
  fs.writeFileSync(binary, "#!/bin/sh\nprintf 'fixture error\\n' >&2\nkill -TERM $$\n", { mode: 0o755 });
  const backend = new Backend(binary, () => {});
  await assert.rejects(backend.run('interfaces'), /Backend terminated by SIGTERM[\s\S]*fixture error/);
  assert.equal(backend.active, null);
  await assert.rejects(backend.preview({}), /Preview backend terminated by SIGTERM[\s\S]*fixture error/);
});

test('requested cancellation remains a cancelled result after signal termination', { skip: process.platform === 'win32' }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'motor-backend-cancel-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'backend');
  fs.writeFileSync(binary, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const backend = new Backend(binary, () => {});
  const result = backend.run('interfaces');
  backend.cancel();
  assert.deepEqual(await result, { cancelled: true });
  assert.equal(backend.active, null);
});
