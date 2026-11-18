'use strict';

const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { format } = require('node:util');

class ManagedUpdater {
  constructor(native, app, onError = () => {}) {
    this.native = native;
    this.app = app;
    this.candidate = null;
    this.failure = null;
    native.autoDownload = false;
    native.autoInstallOnAppQuit = false;
    native.allowDowngrade = false;
    native.allowPrerelease = false;
    native.disableWebInstaller = true;
    if (process.platform === 'win32') native.installDirectory = path.dirname(app.getPath('exe'));
    const logFile = path.join(app.getPath('userData'), 'update.log');
    const log = (...args) => {
      try {
        syncFs.mkdirSync(path.dirname(logFile), { recursive: true });
        syncFs.appendFileSync(logFile, `${new Date().toISOString()} ${format(...args)}\n`);
      } catch (error) { console.error(error); }
    };
    native.logger = { info: log, warn: log, error: log, debug: log };
    native.on('error', error => {
      this.failure = error;
      log(error);
      onError(error);
    });
  }

  async check() {
    const result = await this.native.checkForUpdates();
    if (!result) throw new Error('Install a packaged copy of Motor Setup Tool to update from the app');
    const available = result.isUpdateAvailable;
    const version = result.updateInfo.version;
    this.candidate = available ? version : null;
    return { available, version, installable: available };
  }

  async install(version, progress, ensureIdle) {
    if (!this.candidate || version !== this.candidate) throw new Error('Check for an available update first');
    ensureIdle();
    this.failure = null;
    const onProgress = value => progress(`Downloading update · ${Math.min(100, Math.round(value.percent))}%`);
    this.native.on('download-progress', onProgress);
    try {
      progress('Downloading update…');
      await this.native.downloadUpdate();
      // A download may take minutes. Recheck before the vendor updater can quit
      // the app; never install automatically on an ordinary app exit.
      ensureIdle();
      const pending = path.join(this.app.getPath('userData'), 'pending-update.json');
      await fs.writeFile(pending, JSON.stringify({ version, previousVersion: this.app.getVersion() }));
      progress('Installing update. The app will restart…');
      this.native.quitAndInstall(true, true);
      if (this.failure) {
        await fs.rm(pending, { force: true });
        throw this.failure;
      }
    } finally {
      this.native.removeListener('download-progress', onProgress);
    }
  }
}

function createUpdater(app, onError) {
  if (!app.isPackaged) return null;
  // electron-builder supplies app-update.yml and Linux's package-type marker.
  // The library selects NsisUpdater, MacUpdater, DebUpdater, or RpmUpdater.
  return new ManagedUpdater(require('electron-updater').autoUpdater, app, onError);
}

async function readUpdateError(app) {
  const directory = app.getPath('userData');
  const errorFile = path.join(directory, 'update-error.txt');
  let error = await fs.readFile(errorFile, 'utf8').catch(() => null);
  const pendingFile = path.join(directory, 'pending-update.json');
  let pending;
  try { pending = JSON.parse(await fs.readFile(pendingFile, 'utf8')); }
  catch (failure) {
    if (failure.code !== 'ENOENT') error ||= 'The previous update could not be verified. Please install the latest release again.';
  }
  if (pending?.version) {
    if (pending.version !== app.getVersion()) {
      error ||= `Update to ${pending.version} did not complete. This app is still ${app.getVersion()}. Details: ${path.join(directory, 'update.log')}`;
    }
    await fs.rm(pendingFile, { force: true });
  }
  await fs.rm(errorFile, { force: true });
  return error;
}

module.exports = { ManagedUpdater, createUpdater, readUpdateError };
