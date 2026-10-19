'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { check, isNewer } = require('./updater');

test('version comparison accepts only newer numeric releases', () => {
  assert.equal(isNewer('v0.1.6', '0.1.5'), true);
  assert.equal(isNewer('0.2.0', '0.1.9'), true);
  assert.equal(isNewer('0.1.5', '0.1.5'), false);
  assert.equal(isNewer('0.1.4', '0.1.5'), false);
  assert.equal(isNewer('not-a-version', '0.1.5'), false);
});

test('GitHub update check requires an Electron archive and checksum for this platform', async () => {
  const originalFetch = global.fetch;
  const name = `motor-setup-tool-electron-${process.platform}-${process.arch}.tar.gz`;
  const assets = [name, `${name}.sha256`].map(file => ({ name: file, browser_download_url: `https://github.com/MotomindKR/motor-setup-tool/releases/download/v0.1.6/${file}` }));
  global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ tag_name: 'v0.1.6', assets }) });
  try {
    assert.deepEqual(await check('0.1.5').then(({ available, version, installable }) => ({ available, version, installable })), { available: true, version: '0.1.6', installable: true });
    assets.pop();
    assert.equal((await check('0.1.5')).installable, false);
  } finally { global.fetch = originalFetch; }
});
