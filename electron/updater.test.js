'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ManagedUpdater, createUpdater, readUpdateError } = require('./updater');

async function fixture(t, onError) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'motomind-updater-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const native = new EventEmitter();
  const calls = [];
  const app = { getPath: name => name === 'exe' ? path.join(directory, 'Motor Setup Tool.exe') : directory, getVersion: () => '0.1.19' };
  native.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.1.20' } });
  native.downloadUpdate = async () => { calls.push('download'); native.emit('download-progress', { percent: 42.4 }); };
  native.quitAndInstall = () => calls.push('install');
  const updater = new ManagedUpdater(native, app, onError);
  return { directory, native, calls, app, updater, pending: path.join(directory, 'pending-update.json') };
}

test('development sessions do not create an updater', () => {
  assert.equal(createUpdater({ isPackaged: false }), null);
});

test('a release becomes unavailable when the app is ineligible for its rollout', async t => {
  const { native, updater } = await fixture(t);
  assert.equal((await updater.check()).available, true);
  native.checkForUpdates = async () => ({ isUpdateAvailable: false, updateInfo: { version: '0.1.20' } });
  assert.equal((await updater.check()).available, false);
  await assert.rejects(updater.install('0.1.20', () => {}, () => {}), /Check for an available update/);
});

test('only the offered release can be installed and its download reports progress', async t => {
  const { updater, calls, app } = await fixture(t);
  await assert.rejects(updater.install('0.1.20', () => {}, () => {}), /Check for an available update/);
  const offered = await updater.check();
  assert.equal(offered.version, '0.1.20');
  await assert.rejects(updater.install('0.1.21', () => {}, () => {}), /available update changed/);
  const progress = [];
  await updater.install(offered.version, value => progress.push(value), () => {});
  assert.deepEqual(calls, ['download', 'install']);
  assert.ok(progress.some(message => message.includes('42%')));
  assert.match(await readUpdateError(app), /Update to 0\.1\.20 did not complete/);
});

test('an active motor blocks installation before downloading and after a long download', async t => {
  const { updater, native, calls, app } = await fixture(t);
  await updater.check();
  const busy = () => { throw new Error('Motor operation active'); };
  await assert.rejects(updater.install('0.1.20', () => {}, busy), /Motor operation active/);
  assert.deepEqual(calls, []);
  let motorActive = false;
  native.downloadUpdate = async () => { calls.push('download'); motorActive = true; };
  await assert.rejects(updater.install('0.1.20', () => {}, () => { if (motorActive) busy(); }), /Motor operation active/);
  assert.deepEqual(calls, ['download']);
  assert.equal(await readUpdateError(app), null);
});

test('a failed download keeps the app running and a retry reports fresh progress', async t => {
  const { native, updater, calls, app } = await fixture(t);
  await updater.check();
  const download = native.downloadUpdate;
  const first = [];
  native.downloadUpdate = async () => { throw new Error('sha512 checksum mismatch'); };
  await assert.rejects(updater.install('0.1.20', value => first.push(value), () => {}), /checksum mismatch/);
  assert.deepEqual(calls, []);
  assert.equal(await readUpdateError(app), null);
  const beforeRetry = [...first];
  native.downloadUpdate = download;
  await updater.install('0.1.20', () => {}, () => {});
  assert.deepEqual(calls, ['download', 'install']);
  assert.deepEqual(first, beforeRetry);
});

test('native installation failures are logged and clear pending update state', async t => {
  const failures = [];
  const { native, updater, directory, app } = await fixture(t, error => failures.push(error.message));
  await updater.check();
  native.quitAndInstall = () => native.emit('error', new Error('Installation was denied'));
  await assert.rejects(updater.install('0.1.20', () => {}, () => {}), /Installation was denied/);
  assert.equal(await readUpdateError(app), null);
  assert.match(await fs.readFile(path.join(directory, 'update.log'), 'utf8'), /Installation was denied/);
  native.quitAndInstall = () => { throw new Error('Could not start installer'); };
  await assert.rejects(updater.install('0.1.20', () => {}, () => {}), /Could not start installer/);
  assert.equal(await readUpdateError(app), null);
  native.quitAndInstall = () => {};
  await updater.install('0.1.20', () => {}, () => {});
  await assert.rejects(updater.check(), /already in progress/);
  native.emit('error', new Error('Installer failed after handoff'));
  assert.deepEqual(failures, ['Installation was denied', 'Could not start installer', 'Installer failed after handoff']);
  assert.equal(await readUpdateError(app), null);
  await updater.install('0.1.20', () => {}, () => {});
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

test('a partial pending update marker is reported once on restart', async t => {
  const { app, pending } = await fixture(t);
  for (const contents of ['{"version":', '{}']) {
    await fs.writeFile(pending, contents);
    assert.match(await readUpdateError(app), /could not be verified/);
    assert.equal(await readUpdateError(app), null);
  }
});
