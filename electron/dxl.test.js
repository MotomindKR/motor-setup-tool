'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DxlWorker } = require('./dxl');

const demo = { demo: true, port: '', baud: 1_000_000 };

async function withWorker(t) {
  const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motor-dxl-test-'));
  const worker = new DxlWorker({ root: path.resolve(__dirname, '..'), backupDir });
  t.after(async () => {
    await worker.close();
    await fs.rm(backupDir, { recursive: true, force: true });
  });
  return worker;
}

async function run(worker, operation, params) {
  const reply = await worker.run(operation, params);
  assert.equal(reply.error, undefined);
  return reply.result;
}

test('serial ports can be listed before connecting to a motor', async t => {
  const worker = await withWorker(t);
  const reply = await worker.run('ports');
  assert.equal(reply.error, undefined);
  assert.equal(reply.connected, false);
  assert.ok(Array.isArray(reply.result.ports));
});

test('DXL demo saves the verified 2048-pulse zero with one command', async t => {
  const worker = await withWorker(t);
  const { motors: [discovered] } = await run(worker, 'connect', demo);
  const ids = [discovered.motor_id];
  const { path: backup } = await run(worker, 'saveZero', { ids });
  const journal = JSON.parse(await fs.readFile(backup, 'utf8'));
  assert.equal(journal.status, 'verified');
  assert.equal(journal.simulated, true);
  assert.equal(journal.motors[0].motor_id, discovered.motor_id);
  const { motors: [motor] } = await run(worker, 'poll', { ids });
  assert.equal(motor.position, 2048);
  assert.equal(motor.joint_radians, 0);
});

test('Mode 5 writes only changed motors and returns verified modes before zero is saved', async t => {
  const worker = await withWorker(t);
  await run(worker, 'connect', demo);
  const result = await run(worker, 'setMode5', { ids: [30, 36] });
  assert.deepEqual(result.motors.map(motor => motor.operating_mode), [5, 5]);
  assert.ok(result.motors.every(motor => motor.torque === 0));
  const journal = JSON.parse(await fs.readFile(result.path, 'utf8'));
  assert.equal(journal.status, 'verified');
  assert.equal(journal.changes.length, 1);
  const [change] = journal.changes;
  assert.deepEqual([change.motor_id, change.address, change.before.operating_mode, change.readback], [36, 11, 3, 5]);

  const unchanged = await run(worker, 'setMode5', { ids: [36] });
  assert.equal(unchanged.path, null);
  await run(worker, 'saveZero', { ids: [36] });
  const { motors: [calibrated] } = await run(worker, 'poll', { ids: [36] });
  assert.equal(calibrated.operating_mode, 5);
  assert.equal(calibrated.position, 2048);
});

test('a verified ID change queues after one poll and allows saving zero at the new ID', async t => {
  const worker = await withWorker(t);
  await run(worker, 'connect', demo);
  const poll = run(worker, 'poll', { ids: [30] });
  const change = run(worker, 'setId', { ids: [30], newId: 45 });
  await assert.rejects(worker.run('poll', { ids: [30] }), /current DXL operation/);
  assert.equal((await poll).motors[0].motor_id, 30);
  assert.equal((await change).motor.motor_id, 45);
  await run(worker, 'saveZero', { ids: [45] });
  const { motors: [calibrated] } = await run(worker, 'poll', { ids: [45] });
  assert.equal(calibrated.motor_id, 45);
  assert.equal(calibrated.position, 2048);
});

test('the worker switches to the verified one-megabit bus and keeps polling the selected motor', async t => {
  const worker = await withWorker(t);
  const initial = await run(worker, 'connect', demo);
  assert.equal(initial.baud, 57_600);
  assert.ok(initial.motors.every(motor => motor.baud_rate === 57_600));
  assert.match((await worker.run('set1Mbps', { ids: [30, 31] })).error, /Select one motor/);
  const result = await run(worker, 'set1Mbps', { ids: [30] });
  assert.equal(result.baud, 1_000_000);
  assert.deepEqual(result.motors.map(motor => motor.motor_id), [30]);
  assert.equal(result.motors[0].baud_rate, 1_000_000);
  assert.deepEqual((await run(worker, 'poll', { ids: [30] })).motors, result.motors);
  assert.deepEqual((await run(worker, 'scan')).motors, result.motors);
});

test('worker waits for pending writes before closing and starts a fresh session', async t => {
  const worker = await withWorker(t);
  await run(worker, 'connect', demo);
  const save = run(worker, 'direction', { ids: [30], reverse: true });
  const closed = worker.close();
  await assert.rejects(worker.run('connect', demo), /closing/);
  const { path: backup } = await save;
  await closed;
  assert.equal(JSON.parse(await fs.readFile(backup, 'utf8')).changes[0].readback, 1);
  const second = await run(worker, 'connect', demo);
  assert.equal(second.motors[0].reverse, false);
});

test('invalid hardware connection reports failure without starting demo motors', async t => {
  const worker = await withWorker(t);
  const reply = await worker.run('connect', { baud: 1_000_000, port: '' });
  assert.equal(reply.connected, false);
  assert.ok(reply.error);
  assert.equal((await run(worker, 'connect', demo)).demo, true);
});

test('the active worker reports errors in the selected language without reconnecting', async t => {
  const { i18n } = require('./i18n.js');
  const worker = await withWorker(t);
  await run(worker, 'connect', demo);
  t.after(() => i18n.changeLanguage('en'));
  await i18n.changeLanguage('ko');
  const korean = await worker.run('setId', { ids: [30], newId: 31 });
  assert.equal(korean.connected, true);
  assert.match(korean.error, /ID 31.*사용 중/);
  await i18n.changeLanguage('en');
  const english = await worker.run('setId', { ids: [30], newId: 31 });
  assert.equal(english.connected, true);
  assert.match(english.error, /ID 31 is already in use/);
});
