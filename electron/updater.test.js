'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ManagedUpdater, createUpdater, readUpdateError } = require('./updater');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'motomind-updater-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const native = new EventEmitter();
  const calls = [];
  const app = { getPath: name => name === 'exe' ? path.join(directory, 'Motor Setup Tool.exe') : directory, getVersion: () => '0.1.19' };
  native.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.1.20' } });
  native.downloadUpdate = async () => { calls.push('download'); native.emit('download-progress', { percent: 42.4 }); };
  native.quitAndInstall = (...args) => calls.push(args);
  const updater = new ManagedUpdater(native, app);
  return { directory, native, calls, app, updater, pending: path.join(directory, 'pending-update.json') };
}

test('updates require a packaged app and never download or install on their own', async t => {
  assert.equal(createUpdater({ isPackaged: false }), null);
  const { native } = await fixture(t);
  assert.equal(native.autoDownload, false);
  assert.equal(native.autoInstallOnAppQuit, false);
  assert.equal(native.allowDowngrade, false);
  assert.equal(native.allowPrerelease, false);
  assert.equal(native.disableWebInstaller, true);
});

test('update availability follows the maintained updater, including rollout eligibility', async t => {
  const { native, updater } = await fixture(t);
  assert.deepEqual(await updater.check(), { available: true, version: '0.1.20', installable: true });
  native.checkForUpdates = async () => ({ isUpdateAvailable: false, updateInfo: { version: '0.1.20' } });
  assert.deepEqual(await updater.check(), { available: false, version: '0.1.20', installable: false });
  await assert.rejects(updater.install('0.1.20', () => {}, () => {}), /Check for an available update/);
});

test('only the checked release can be installed; progress and restart use the native updater', async t => {
  const { updater, native, calls, pending } = await fixture(t);
  await assert.rejects(updater.install('0.1.20', () => {}, () => {}), /Check for an available update/);
  await updater.check();
  await assert.rejects(updater.install('0.1.21', () => {}, () => {}), /Check for an available update/);
  const progress = [];
  let idleChecks = 0;
  await updater.install('0.1.20', value => progress.push(value), () => { idleChecks++; });
  assert.equal(idleChecks, 2);
  assert.deepEqual(calls, ['download', [true, true]]);
  assert.ok(progress.includes('Downloading update · 42%'));
  assert.equal(native.listenerCount('download-progress'), 0);
  assert.deepEqual(JSON.parse(await fs.readFile(pending, 'utf8')), { version: '0.1.20', previousVersion: '0.1.19' });
});

test('an active motor blocks installation before downloading and after a long download', async t => {
  const { updater, calls, pending } = await fixture(t);
  await updater.check();
  const busy = () => { throw new Error('Motor operation active'); };
  await assert.rejects(updater.install('0.1.20', () => {}, busy), /Motor operation active/);
  assert.deepEqual(calls, []);
  let checks = 0;
  await assert.rejects(updater.install('0.1.20', () => {}, () => { if (++checks === 2) busy(); }), /Motor operation active/);
  assert.deepEqual(calls, ['download']);
  await assert.rejects(fs.access(pending), { code: 'ENOENT' });
});

test('a checksum or download failure cannot quit the app or mark an update pending', async t => {
  const { native, updater, calls, pending } = await fixture(t);
  await updater.check();
  native.downloadUpdate = async () => { throw new Error('sha512 checksum mismatch'); };
  await assert.rejects(updater.install('0.1.20', () => {}, () => {}), /checksum mismatch/);
  assert.deepEqual(calls, []);
  assert.equal(native.listenerCount('download-progress'), 0);
  await assert.rejects(fs.access(pending), { code: 'ENOENT' });
});

test('native installation failures are logged and clear pending update state', async t => {
  const { native, updater, directory, pending } = await fixture(t);
  await updater.check();
  native.quitAndInstall = () => native.emit('error', new Error('Installation was denied'));
  await assert.rejects(updater.install('0.1.20', () => {}, () => {}), /Installation was denied/);
  await assert.rejects(fs.access(pending), { code: 'ENOENT' });
  assert.match(await fs.readFile(path.join(directory, 'update.log'), 'utf8'), /Installation was denied/);
});

test('restart verification reports an incomplete update once and consumes old helper errors', async t => {
  const { app, pending, directory } = await fixture(t);
  await fs.writeFile(pending, JSON.stringify({ version: '0.1.20' }));
  assert.match(await readUpdateError(app), /Update to 0\.1\.20 did not complete.*still 0\.1\.19/);
  assert.equal(await readUpdateError(app), null);
  await fs.writeFile(pending, JSON.stringify({ version: '0.1.20' }));
  assert.equal(await readUpdateError({ ...app, getVersion: () => '0.1.20' }), null);
  await fs.writeFile(path.join(directory, 'update-error.txt'), 'Previous Windows helper failure');
  assert.equal(await readUpdateError(app), 'Previous Windows helper failure');
  assert.equal(await readUpdateError(app), null);
});
