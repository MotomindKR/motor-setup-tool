'use strict';
// Test entry point installed alongside the packaged main process in a disposable app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const config = JSON.parse(fs.readFileSync(process.env.MOTOMIND_UPDATE_TEST_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
delete process.env.MOTOMIND_UPDATE_TEST_CONFIG;
delete process.env.MOTOMIND_SMOKE_PATH;
app.setPath('userData', config.directory);
assert.equal(app.isPackaged, true);
const manifestFile = path.join(__dirname, '..', 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
manifest.main = config.entry;
fs.writeFileSync(manifestFile, JSON.stringify(manifest));

async function waitFor(check, reason) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(reason);
    await delay(100);
  }
}

async function serve() {
  const name = `installer${path.extname(config.installer)}`;
  const hash = createHash('sha512');
  if (config.badChecksum) hash.update('incorrect payload');
  else for await (const chunk of fs.createReadStream(config.installer)) hash.update(chunk);
  const file = { url: name, sha512: hash.digest('base64'), size: fs.statSync(config.installer).size };
  const update = { version: config.version, files: [file], path: name, sha512: file.sha512, releaseDate: new Date().toISOString() };
  let installRequested = false;
  let earlyDownload = false;
  const server = http.createServer((request, response) => {
    const url = request.url.split('?')[0];
    if (url.endsWith('.yml')) response.end(JSON.stringify(update));
    else if (url === `/${name}`) {
      if (!installRequested) earlyDownload = true;
      response.setHeader('Content-Length', file.size);
      fs.createReadStream(config.installer).pipe(response);
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const native = require('electron-updater').autoUpdater;
  native.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${server.address().port}` });
  native.disableDifferentialDownload = true;
  native.on('update-downloaded', info => fs.writeFileSync(config.handoff, JSON.stringify({
    version: app.getVersion(), target: info.version,
  })));

  async function exercise(window) {
    const evaluate = source => window.webContents.executeJavaScript(source);
    await waitFor(() => evaluate(`document.querySelector('button[aria-label="Refresh adapters"]')?.disabled === false`), 'Startup did not finish');
    const offer = config.badChecksum
      ? await waitFor(() => evaluate('(async () => { const { updateResult } = await window.motorApp.updateInfo(); return updateResult?.available && updateResult })()'), 'The background check did not offer an update')
      : await evaluate('window.motorApp.checkUpdate()');
    assert.equal(offer.available, true);
    assert.equal(offer.version, config.version);
    const install = () => evaluate(`window.motorApp.installUpdate(${JSON.stringify(offer.version)})`);
    assert.equal(earlyDownload, false, 'Checking for an update downloaded the installer');
    installRequested = true;
    if (!config.badChecksum) {
      if (process.platform !== 'win32') process.env.MOTOMIND_SMOKE_PATH = config.screenshot;
      await install();
      return;
    }
    await assert.rejects(install(), /checksum mismatch/i);
    assert.equal(fs.existsSync(config.handoff), false, 'The updater accepted the corrupt download');
    const visibleError = await waitFor(async () => {
      const text = await evaluate(`document.querySelector('[role="dialog"]')?.innerText || ""`);
      return /Settings/i.test(text) && /checksum mismatch/i.test(text) && text;
    }, 'Checksum failure was not visible in Settings');
    fs.writeFileSync(config.screenshot, (await window.webContents.capturePage()).toPNG());
    fs.writeFileSync(`${config.screenshot}.json`, JSON.stringify({ version: app.getVersion(), updateError: visibleError }));
    app.exit(0);
  }
  app.once('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', () => exercise(window).catch(fail));
  });
  require(path.resolve(path.dirname(manifestFile), config.entry));
}

function fail(error) {
  fs.writeFileSync(config.handoff, JSON.stringify({ error: error.message }));
  console.error(error);
  app.exit(1);
}

serve().catch(fail);
