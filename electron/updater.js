'use strict';

const { t } = require('./i18n.js');

const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { format } = require('node:util');

class ManagedUpdater {
  constructor(native, app, onError = () => {}) {
    this.native = native;
    this.pendingFile = path.join(app.getPath('userData'), 'pending-update.json');
    this.onError = onError;
    this.offer = null;
    this.phase = 'idle';
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
      log(error);
      if (this.phase === 'handed-off') this.failInstall(error);
      else if (this.installing) this.nativeError = error;
    });
  }

  get installing() { return this.phase !== 'idle'; }

  failInstall(error) {
    try { syncFs.rmSync(this.pendingFile, { force: true }); }
    catch (cleanupError) { this.native.logger.error(cleanupError); }
    this.phase = 'idle';
    this.onError(error);
  }

  async check() {
    if (this.installing) throw new Error(t("Update already in progress"));
    const result = await this.native.checkForUpdates();
    if (!result) throw new Error(t("In-app updates are available in release builds."));
    const available = result.isUpdateAvailable;
    const version = result.updateInfo.version;
    this.offer = { available, version };
    return this.offer;
  }

  async install(version, progress, ensureIdle) {
    if (this.installing) throw new Error(t("Update already in progress"));
    if (!this.offer?.available) throw new Error(t("Check for an available update first"));
    if (this.offer.version !== version) throw new Error(t("The available update changed. Review the new version before installing."));
    ensureIdle();
    this.phase = 'installing';
    this.nativeError = null;
    const onProgress = value => progress(t("Downloading update · {{percent}}%", { percent: Math.min(100, Math.round(value.percent)) }));
    this.native.on('download-progress', onProgress);
    try {
      progress(t("Downloading update…"));
      await this.native.downloadUpdate();
      if (this.nativeError) throw this.nativeError;
      ensureIdle();
      syncFs.writeFileSync(this.pendingFile, JSON.stringify({ version }));
      progress(t("Installing update. The app will restart…"));
      this.native.quitAndInstall(true, true);
      if (this.nativeError) throw this.nativeError;
      this.phase = 'handed-off';
    } catch (error) {
      this.failInstall(error);
      throw error;
    } finally {
      this.native.removeListener('download-progress', onProgress);
    }
  }
}

function createUpdater(app, onError) {
  if (!app.isPackaged) return null;
  if (require(path.join(app.getAppPath(), 'package.json')).disableUpdates) return null;
  return new ManagedUpdater(require('electron-updater').autoUpdater, app, onError);
}

async function optionalText(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readUpdateError(app) {
  const directory = app.getPath('userData');
  const errorFile = path.join(directory, 'update-error.txt');
  const pendingFile = path.join(directory, 'pending-update.json');
  let error = await optionalText(errorFile);
  const pending = await optionalText(pendingFile);
  if (pending !== null) {
    let version;
    try { version = JSON.parse(pending)?.version; } catch (failure) {
      if (!(failure instanceof SyntaxError)) throw failure;
    }
    if (typeof version !== 'string' || !version) {
      error ||= t("The previous update could not be verified. Please install the latest release again.");
    } else if (version !== app.getVersion()) {
      error ||= t("Update to {{version}} did not complete. This app is still {{current}}. Details: {{path}}", { version, current: app.getVersion(), path: path.join(directory, 'update.log') });
    }
    await fs.rm(pendingFile, { force: true });
  }
  await fs.rm(errorFile, { force: true });
  return error;
}

module.exports = { ManagedUpdater, createUpdater, readUpdateError };
