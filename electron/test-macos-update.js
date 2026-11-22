'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron, expect } = require('@playwright/test');
const yaml = require('js-yaml');

async function main() {
  const [bundle, manifest, feed] = process.argv.slice(2);
  const target = yaml.load(fs.readFileSync(manifest, 'utf8')).version;
  const executablePath = path.join(bundle, 'Contents/MacOS/Motor Setup Tool');
  const application = await _electron.launch({ executablePath });
  const original = application.process();
  try {
    const page = await application.firstWindow();
    await page.locator('.app-header').waitFor();
    // Set the feed in memory so Squirrel validates the original signed bundle.
    const profile = await application.evaluate(({ app }, url) => {
      const load = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
      load('electron-updater').autoUpdater.setFeedURL({ provider: 'generic', url });
      return app.getPath('userData');
    }, feed);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(async () => {
      await page.getByRole('button', { name: 'Check for update' }).click();
      await expect(page.getByText(`Version ${target} is available.`)).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30000 });
    await page.getByRole('button', { name: 'Install update' }).click();

    await expect.poll(() => {
      const processes = execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' });
      return processes.split('\n').some(line => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        return match && Number(match[1]) !== original.pid && match[2] === executablePath;
      });
    }, { timeout: 90000, message: 'Squirrel did not relaunch the installed app' }).toBe(true);
    const version = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
    assert.equal(version, target);
    await expect.poll(() => fs.existsSync(path.join(profile, 'pending-update.json')), { timeout: 15000 }).toBe(false);
    execFileSync('spctl', ['--assess', '--type', 'execute', bundle], { stdio: 'inherit' });
    console.log(`Updated and relaunched Motor Setup Tool ${version}`);
  } finally {
    if (original.exitCode === null && original.signalCode === null) await application.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
