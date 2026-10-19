'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { check, install, installerName, isNewer } = require('./updater');
const { mode, readUpdateError } = require('./native-install');

test('a helper failure cannot silently restart the previous version', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'motomind-update-state-'));
  const pending = path.join(directory, 'pending-update.json');
  const result = path.join(directory, 'update-error.txt');
  const app = { getPath: () => directory, getVersion: () => '0.1.14' };
  try {
    await fs.writeFile(pending, JSON.stringify({ version: '0.1.15' }));
    assert.match(await readUpdateError(app), /Update to 0\.1\.15 did not complete.*still 0\.1\.14/);
    assert.match(await readUpdateError(app), /Update to 0\.1\.15 did not complete/);
    await fs.rm(result);
    await fs.writeFile(pending, JSON.stringify({ version: '0.1.15' }));
    assert.equal(await readUpdateError({ ...app, getVersion: () => '0.1.15' }), null);
    await assert.rejects(fs.access(pending), { code: 'ENOENT' });
    await fs.writeFile(result, 'Update failed: launcher version mismatch');
    await fs.writeFile(pending, JSON.stringify({ version: '0.1.15' }));
    assert.match(await readUpdateError({ ...app, getVersion: () => '0.1.15' }), /launcher version mismatch/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('direct installation is offered only from supported packaged launchers', () => {
  assert.equal(mode({ isPackaged: false }, 'linux', '/opt/Motor Setup Tool/motor-setup-tool'), null);
  assert.equal(mode({ isPackaged: true }, 'linux', '/opt/Motor Setup Tool/motor-setup-tool'), 'linux');
  assert.equal(mode({ isPackaged: true }, 'win32', 'C:\\Users\\Me\\AppData\\Local\\Programs\\Motor Setup Tool\\Motor Setup Tool.exe'), 'windows');
  assert.equal(mode({ isPackaged: true }, 'darwin', '/Applications/Motor Setup Tool.app/Contents/MacOS/Motor Setup Tool'), 'mac-dmg');
});

test('version comparison accepts only newer numeric releases', () => {
  assert.equal(isNewer('v0.1.6', '0.1.5'), true);
  assert.equal(isNewer('0.2.0', '0.1.9'), true);
  assert.equal(isNewer('0.1.5', '0.1.5'), false);
  assert.equal(isNewer('0.1.4', '0.1.5'), false);
  assert.equal(isNewer('not-a-version', '0.1.5'), false);
});

test('installer is run only after its downloaded bytes match SHA256SUMS', async () => {
  const originalFetch = global.fetch;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'motomind-update-'));
  const filename = await installerName('0.1.7');
  const bytes = Buffer.from('installer test payload');
  const digest = createHash('sha256').update(bytes).digest('hex');
  let installed = false;
  global.fetch = async url => url.endsWith('SHA256SUMS')
    ? new Response(`${digest}  ${filename}\n`)
    : new Response(bytes);
  const candidate = { installable: true, filename, installerUrl: 'https://example.test/installer', checksumUrl: 'https://example.test/SHA256SUMS' };
  try {
    await install({ getPath: () => directory }, candidate, () => {}, async file => {
      assert.deepEqual(await fs.readFile(file), bytes);
      installed = true;
    });
    assert.equal(installed, true);
    installed = false;
    global.fetch = async url => url.endsWith('SHA256SUMS')
      ? new Response(`${'0'.repeat(64)}  ${filename}\n`)
      : new Response(bytes);
    await assert.rejects(install({ getPath: () => directory }, candidate, () => {}, async () => { installed = true; }), /checksum/);
    assert.equal(installed, false);
  } finally {
    global.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('GitHub update check requires an installer and checksum list for this platform', async () => {
  const originalFetch = global.fetch;
  const name = await installerName('0.1.6');
  const assets = [name, 'SHA256SUMS'].map(file => ({ name: file, browser_download_url: `https://github.com/MotomindKR/motor-setup-tool/releases/download/v0.1.6/${file}` }));
  global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ tag_name: 'v0.1.6', assets }) });
  try {
    assert.deepEqual(await check('0.1.5').then(({ available, version, installable }) => ({ available, version, installable })), { available: true, version: '0.1.6', installable: true });
    assets.pop();
    assert.equal((await check('0.1.5')).installable, false);
  } finally { global.fetch = originalFetch; }
});
