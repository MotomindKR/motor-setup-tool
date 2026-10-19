'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const os = require('node:os');
const path = require('node:path');
const { argsFor, Backend } = require('./backend');

test('hardware operations require explicit review and validated targets', () => {
  assert.throws(() => argsFor('calibrate', { can: 'can0', id: 1 }), /Review/);
  assert.throws(() => argsFor('calibrate', { can: 'can0', id: 1, reviewed: true }), /configuration missing/);
  assert.throws(() => argsFor('jog', { can: 'can0', id: 1, speed: 0.5, seconds: 2 }), /Confirm/);
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
  assert.deepEqual(argsFor('serialPorts'), ['can', 'serial-list']);
  assert.deepEqual(argsFor('usbAdapters'), ['can', 'usb-list']);
  assert.deepEqual(argsFor('registerList'), ['register', 'list']);
  assert.deepEqual(argsFor('registerRead', { can: 'can0', id: 1, index: 0x2012 }), ['register', 'read', '--can', 'can0', '--host-id', '253', '--id', '1', '--index', '0x2012']);
  assert.throws(() => argsFor('registerRead', { can: 'can0', id: 1, index: 0x7005 }), /documented persistent/);
  assert.throws(() => argsFor('registerWrite', { can: 'can0', id: 1, index: 0x2012 }), /Confirm/);
  assert.throws(() => argsFor('registerWrite', { can: 'can0', id: 1, index: 0x2018, value: 1, uuid: '0000000000000000', expectedRaw: '0000803F', confirmed: true }), /documented persistent/);
  assert.deepEqual(argsFor('registerWrite', { can: 'can0', id: 1, index: 0x2012, value: 2.5, uuid: '0000000000000000', expectedRaw: '0000803F', confirmed: true }), ['register', 'write', '--can', 'can0', '--host-id', '253', '--id', '1', '--index', '0x2012', '--value', '2.5', '--uuid', '0000000000000000', '--expected-raw', '0000803F', '--yes']);
  assert.deepEqual(argsFor('scan', { can: 'gsusb:303033:79', hostId: 253 }), ['scan', '--can', 'gsusb:303033:79', '--host-id', '253']);
  assert.deepEqual(argsFor('scan', { can: 'gsusb:00:79', hostId: 253 }), ['scan', '--can', 'gsusb:00:79', '--host-id', '253']);
  assert.throws(() => argsFor('scan', { can: 'gsusb:0:79' }), /CAN interface/);
  assert.throws(() => argsFor('scan', { can: 'gsusb:303033:999' }), /CAN interface/);
  if (process.platform !== 'win32') {
    assert.deepEqual(argsFor('scan', { can: 'slcan:canable:921600:/dev/ttyUSB0', hostId: 253 }), ['scan', '--can', 'slcan:canable:921600:/dev/ttyUSB0', '--host-id', '253']);
    assert.throws(() => argsFor('scan', { can: 'slcan:canable:921600:/dev/../ttyUSB0' }), /CAN interface/);
    assert.throws(() => argsFor('canUp', { can: 'slcan:canable:921600:/dev/ttyUSB0' }), /SocketCAN/);
  }
  assert.deepEqual(argsFor('calibrate', { can: 'can0', id: 1, reviewed: true, config: {}, output: path.join(os.tmpdir(), 'new-calibration') }), ['calibrate', '--can', 'can0', '--host-id', '253', '--id', '1', '--output', path.join(os.tmpdir(), 'new-calibration'), '--config-stdin', '--yes']);
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
    operation: 'monitor', transferStarted: false, cancelRequested: false,
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
