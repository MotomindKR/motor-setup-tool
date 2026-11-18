'use strict';
// CI-only entry point in a disposable installation. The real packaged GUI,
// preload, IPC, electron-updater provider, download, checksum, and installer run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { app } = require('electron');
const config = JSON.parse(fs.readFileSync(process.env.MOTOMIND_UPDATE_TEST_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
delete process.env.MOTOMIND_UPDATE_TEST_CONFIG;
delete process.env.MOTOMIND_SMOKE_PATH;
app.setPath('userData', config.directory);
assert.equal(app.isPackaged, true);
const manifestFile = path.join(__dirname, '..', 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
manifest.main = 'electron/main.js';
fs.writeFileSync(manifestFile, JSON.stringify(manifest));
const extension = path.extname(config.installer);
const name = `installer${extension}`;
const bytes = fs.readFileSync(config.installer);
const sha512 = createHash('sha512').update(config.badChecksum ? 'incorrect payload' : bytes).digest('base64');
const update = { version: config.version, files: [{ url: name, sha512, size: bytes.length }], path: name, sha512, releaseDate: new Date().toISOString() };
const server = http.createServer((request, response) => {
  if (request.url.split('?')[0].endsWith('.yml')) {
    response.end(JSON.stringify(update));
  } else if (request.url.split('?')[0] === `/${name}`) {
    response.setHeader('Content-Length', bytes.length);
    fs.createReadStream(config.installer).pipe(response);
  } else { response.writeHead(404); response.end(); }
});
server.listen(0, '127.0.0.1', () => {
  // Supply the same installed metadata builder creates, using the local CI
  // server. Older installations predate this configuration and dependency.
  fs.writeFileSync(path.join(process.resourcesPath, 'app-update.yml'), JSON.stringify({
    provider: 'generic', url: `http://127.0.0.1:${server.address().port}`,
    updaterCacheDirName: `motomind-updater-test-${process.pid}`,
  }));
  const native = require('electron-updater').autoUpdater;
  native.disableDifferentialDownload = true;
  native.on('update-downloaded', () => fs.writeFileSync(config.handoff, JSON.stringify({
    version: app.getVersion(), target: config.version, updater: native.constructor.name,
    electron: process.versions.electron, executable: app.getPath('exe'), pid: process.pid,
  })));
  app.on('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (process.platform !== 'win32') {
            process.env.MOTOMIND_SMOKE_PATH = config.screenshot;
            process.env.MOTOMIND_SMOKE_TAB = 'setup';
          }
          await window.webContents.executeJavaScript(`(async () => {
            const update = await window.motorApp.checkUpdate();
            if (!update.installable) throw new Error('The packaged app did not offer installation');
            await window.motorApp.installUpdate();
          })()`);
          assert.equal(Boolean(config.badChecksum), false, 'A corrupt download was accepted');
        } catch (error) {
          if (config.badChecksum && /checksum mismatch/i.test(error.message)) {
            await new Promise(resolve => setTimeout(resolve, 200));
            const visible = await window.webContents.executeJavaScript(`document.querySelector('[role="dialog"]')?.textContent || ""`);
            assert.match(visible, /checksum mismatch/i);
            assert.equal(fs.existsSync(path.join(config.directory, 'pending-update.json')), false);
            fs.writeFileSync(config.screenshot, (await window.webContents.capturePage()).toPNG());
            fs.writeFileSync(`${config.screenshot}.json`, JSON.stringify({ version: app.getVersion(), updateError: error.message, settingsOpen: true }));
            fs.writeFileSync(config.handoff, JSON.stringify({ rejected: true, updater: native.constructor.name }));
            app.exit(0);
          } else {
            fs.writeFileSync(config.handoff, JSON.stringify({ error: error.message }));
            console.error(error);
            app.exit(1);
          }
        }
      }, 1000);
    });
  });
  require('./main');
});
