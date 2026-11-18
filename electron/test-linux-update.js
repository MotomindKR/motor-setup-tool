'use strict';
// Run in an isolated CI runner as root under Xvfb. Only disposable packaged
// installations are used; no motor commands are issued.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { copyRuntimeDependencies } = require('./runtime-dependencies');

(async () => {
  assert.equal(process.getuid(), 0);
  const [oldInstaller, installer] = process.argv.slice(2);
  const version = require('./package.json').version;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'motor-linux-updater-'));
  const executable = '/opt/Motor Setup Tool/motor-setup-tool';
  const appRoot = path.join(path.dirname(executable), 'resources', 'app');
  const userData = path.join(directory, 'state');
  await fs.mkdir(userData);
  execFileSync('dpkg', ['-i', oldInstaller], { stdio: 'inherit' });
  for (const badChecksum of [false, true]) {
    const caseDirectory = path.join(directory, badChecksum ? 'checksum-failure' : 'upgrade');
    await fs.mkdir(caseDirectory);
    for (const file of ['main.js', 'preload.js', 'updater.js', 'packaged-update-worker.js']) {
      await fs.copyFile(path.join(__dirname, file), path.join(appRoot, 'electron', file));
    }
    copyRuntimeDependencies(appRoot);
    const manifestFile = path.join(appRoot, 'package.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.main = 'electron/packaged-update-worker.js';
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    const screenshot = path.join(caseDirectory, 'restarted.png');
    const handoff = path.join(caseDirectory, 'handoff.json');
    const configFile = path.join(caseDirectory, 'request.json');
    await fs.writeFile(configFile, JSON.stringify({ installer, version: badChecksum ? '99.0.0' : version, directory: userData, screenshot, handoff, badChecksum }));
    const log = await fs.open(path.join(caseDirectory, 'app.log'), 'w');
    const child = spawn(executable, ['--no-sandbox'], {
      env: { ...process.env, MOTOMIND_UPDATE_TEST_CONFIG: configFile }, stdio: ['ignore', log.fd, log.fd],
    });
    await log.close();
    const timer = setTimeout(() => child.kill(), 60_000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timer);
    assert.equal(code, 0, `Packaged update handoff failed; see ${caseDirectory}`);
    const deadline = Date.now() + 30_000;
    let runtime;
    while (Date.now() < deadline) {
      try { runtime = JSON.parse(await fs.readFile(`${screenshot}.json`, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(runtime?.version, version, `Updated app did not restart; see ${caseDirectory}`);
    const source = JSON.parse(await fs.readFile(handoff, 'utf8'));
    assert.equal(source.updater, 'DebUpdater');
    if (badChecksum) {
      assert.equal(source.rejected, true);
      assert.match(runtime.updateError, /checksum mismatch/i);
    } else {
      assert.equal(runtime.backendReady, true);
      assert.equal(runtime.updateError, null);
    }
    console.log(`Passed ${badChecksum ? 'checksum rejection' : 'installed DEB upgrade'}: ${version}`);
  }
  console.log(`Updater diagnostics: ${directory}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
