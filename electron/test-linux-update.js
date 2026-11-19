'use strict';
// Run in an isolated CI runner as root under Xvfb. Only disposable packaged
// installations are used; no motor commands are issued.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

(async () => {
  assert.equal(process.getuid(), 0);
  const [oldInstaller, installer] = process.argv.slice(2);
  const version = execFileSync('dpkg-deb', ['--field', installer, 'Version'], { encoding: 'utf8' }).trim();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'motor-linux-updater-'));
  const executable = '/opt/Motor Setup Tool/motor-setup-tool';
  const appRoot = path.join(path.dirname(executable), 'resources', 'app');
  const userData = path.join(directory, 'state');
  await fs.mkdir(userData);
  execFileSync('dpkg', ['-i', oldInstaller], { stdio: 'inherit' });
  for (const badChecksum of [false, true]) {
    const caseDirectory = path.join(directory, badChecksum ? 'checksum-failure' : 'upgrade');
    await fs.mkdir(caseDirectory);
    await fs.copyFile(path.join(__dirname, 'packaged-update-worker.js'), path.join(appRoot, 'electron', 'packaged-update-worker.js'));
    const manifestFile = path.join(appRoot, 'package.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    const entry = manifest.main;
    manifest.main = 'electron/packaged-update-worker.js';
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    const screenshot = path.join(caseDirectory, 'restarted.png');
    const handoff = path.join(caseDirectory, 'handoff.json');
    const configFile = path.join(caseDirectory, 'request.json');
    await fs.writeFile(configFile, JSON.stringify({ installer, entry, version: badChecksum ? '99.0.0' : version, directory: userData, screenshot, handoff, badChecksum }));
    const log = await fs.open(path.join(caseDirectory, 'app.log'), 'w');
    const child = spawn(executable, ['--no-sandbox', `--user-data-dir=${userData}`], {
      env: { ...process.env, MOTOMIND_UPDATE_TEST_CONFIG: configFile }, stdio: ['ignore', log.fd, log.fd],
    });
    await log.close();
    const timer = setTimeout(() => child.kill(), 60_000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timer);
    if (code !== 0) console.error(await fs.readFile(path.join(caseDirectory, 'app.log'), 'utf8'));
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
      assert.notEqual(source.version, version);
      assert.equal(source.target, version);
      assert.equal(runtime.backendReady, true);
      assert.equal(runtime.updateError, null);
      assert.equal((await fs.readFile(path.join(path.dirname(executable), 'resources', 'package-type'), 'utf8')).trim(), 'deb');
      const rule = '/usr/lib/udev/rules.d/70-motomind-gsusb.rules';
      assert.deepEqual(await fs.readFile(rule), await fs.readFile(path.join(__dirname, '..', 'packaging', path.basename(rule))));
      const stat = await fs.stat(rule);
      assert.equal(stat.uid, 0);
      assert.equal(stat.mode & 0o777, 0o644);
      await assert.rejects(fs.access(path.join(userData, 'pending-update.json')), { code: 'ENOENT' });
    }
    console.log(`Passed ${badChecksum ? 'checksum rejection' : 'installed DEB upgrade'}: ${version}`);
  }
  const packageName = execFileSync('dpkg-deb', ['--field', installer, 'Package'], { encoding: 'utf8' }).trim();
  execFileSync('dpkg', ['--remove', packageName], { stdio: 'inherit' });
  await assert.rejects(fs.access('/usr/lib/udev/rules.d/70-motomind-gsusb.rules'), { code: 'ENOENT' });
  console.log('USB rule installed by the update and removed with the package.');
  console.log(`Updater diagnostics: ${directory}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
