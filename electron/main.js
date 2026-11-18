'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, session, Menu, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { Backend, backendPath } = require('./backend');
const updater = require('./updater');
const recordings = require('./recordings');

if (process.platform === 'linux') app.setDesktopName('motor-setup-tool.desktop');

const root = path.resolve(__dirname, '..');
const titleBarHeight = 40;
// Leave the header's bottom border below the opaque native window controls.
const titleBarOverlayHeight = process.platform === 'darwin' ? titleBarHeight : titleBarHeight - 1;
const knownRuns = new Set();
const selectedOutputs = new Set();
const recentPathFile = () => path.join(app.getPath('userData'), 'recent-calibrations.json');
const referenceFile = () => path.join(app.getPath('userData'), 'motor-references.json');
function uuidKey(value) {
  if (!Array.isArray(value) || value.length !== 8 || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error('Select a motor with a valid UUID');
  return value.map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function references() {
  try {
    const result = JSON.parse(await fs.readFile(referenceFile(), 'utf8'));
    return result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  } catch { return {}; }
}
let window;
let backend;
let backendError;
let quitting = false;
let checkedUpdate = null;
let installingUpdate = false;
let updateError = null;
let managedUpdater = null;
let recordingOperation = false;

function send(event) {
  if (window && !window.isDestroyed()) window.webContents.send('backend:event', event);
  if (quitting && event.type === 'finish') app.quit();
}

function assertSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Invalid app window');
  }
}

function dataDirectory() {
  const base = process.platform === 'linux'
    ? process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
    : app.getPath('appData');
  return path.join(base, 'motomind-motor-calib', 'runs');
}

async function loadRun(directory) {
  if (!knownRuns.has(directory)) throw new Error('Select a saved run first');
  return recordings.loadRun(directory);
}

async function listRuns() {
  const base = dataDirectory();
  let entries;
  try { entries = await fs.readdir(base, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') entries = []; else throw error; }
  let custom = [];
  try { custom = JSON.parse(await fs.readFile(recentPathFile(), 'utf8')); }
  catch { /* No custom locations saved yet. */ }
  if (!Array.isArray(custom)) custom = [];
  const directories = [...new Set([...entries.filter(entry => entry.isDirectory()).map(entry => path.join(base, entry.name)), ...custom.filter(value => typeof value === 'string' && path.isAbsolute(value))])];
  const runs = await Promise.all(directories.map(async directory => {
    try {
      const run = await recordings.inspectRun(directory);
      knownRuns.add(directory);
      return run;
    } catch { return null; }
  }));
  return runs.filter(Boolean).sort((a, b) => b.timestamp - a.timestamp);
}

function createWindow() {
  const background = nativeTheme.shouldUseDarkColors ? '#121212' : '#ffffff';
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 720,
    minHeight: 600,
    title: 'Motor Setup Tool · Motomind',
    icon: path.join(root, 'assets', 'icons', process.platform === 'win32' ? 'motor-setup-tool.ico' : '256.png'),
    backgroundColor: background,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: {
      height: titleBarOverlayHeight,
      color: background,
      symbolColor: nativeTheme.shouldUseDarkColors ? '#fafafa' : '#171717',
    },
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 20, y: 13 } } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  if (process.platform === 'linux') window.setMenuBarVisibility(false);
  window.loadFile(path.join(__dirname, 'ui-dist', 'index.html'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => { try { backend?.cancel(); } catch { /* Firmware transfer finishes before exit. */ } });
  window.webContents.on('did-finish-load', () => {
    if (backendError) send({ type: 'error', message: backendError.message });
    if (updateError) send({ type: 'updateFailure', message: updateError, version: app.getVersion() });
    if (process.env.MOTOMIND_SMOKE_PATH) {
      setTimeout(async () => {
        try {
          if (process.env.MOTOMIND_SMOKE_REPORT) {
            const directory = process.env.MOTOMIND_SMOKE_REPORT;
            knownRuns.add(directory);
            await window.webContents.executeJavaScript(`window.motorSmoke.actions.openRun(${JSON.stringify(directory)})`);
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          if (['calibrate', 'test', 'setup', 'files'].includes(process.env.MOTOMIND_SMOKE_TAB)) {
            await window.webContents.executeJavaScript(`window.motorSmoke.actions.setTab(${JSON.stringify(process.env.MOTOMIND_SMOKE_TAB)})`);
            await new Promise(resolve => setTimeout(resolve, 400));
          }
          if (process.env.MOTOMIND_SMOKE_TRANSPORT === 'gsusb') {
            await window.webContents.executeJavaScript(`window.motorSmoke.actions.changeConnection('transport', ${JSON.stringify(process.env.MOTOMIND_SMOKE_TRANSPORT)})`);
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          if (['system', 'light', 'dark'].includes(process.env.MOTOMIND_SMOKE_THEME)) {
            await window.webContents.executeJavaScript(`window.motorSmoke.setTheme(${JSON.stringify(process.env.MOTOMIND_SMOKE_THEME)})`);
          }
          if (process.env.MOTOMIND_SMOKE_COLLAPSE === '1') {
            await window.webContents.executeJavaScript('window.motorSmoke.actions.toggleConnection()');
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (process.env.MOTOMIND_SMOKE_SETTINGS === '1') {
            await window.webContents.executeJavaScript('window.motorSmoke.actions.openSettings()');
          }
          await new Promise(resolve => setTimeout(resolve, 200));
          const details = await window.webContents.executeJavaScript('({title:document.title,bridge:typeof window.motorApp,can:document.querySelector(".connection-meta")?.textContent,logo:Boolean(document.querySelector("[data-slot=motomind-logo]")),tab:window.motorSmoke.getSnapshot().tab,theme:document.documentElement.dataset.theme,connectionOpen:window.motorSmoke.getSnapshot().connectionOpen})');
          details.version = app.getVersion();
          details.backendReady = !backendError;
          details.updateError = updateError;
          details.settingsOpen = await window.webContents.executeJavaScript('window.motorSmoke.getSnapshot().settingsOpen');
          await fs.writeFile(process.env.MOTOMIND_SMOKE_PATH, (await window.webContents.capturePage()).toPNG());
          await fs.writeFile(`${process.env.MOTOMIND_SMOKE_PATH}.json`, JSON.stringify(details));
          console.log(JSON.stringify(details));
          app.quit();
        } catch (error) { console.error(error); app.exit(1); }
      }, 800);
    }
  });
  window.on('closed', () => { window = null; });
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.motomind.MotorSetup');
  if (process.platform === 'linux') Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  try {
    updateError = await updater.readUpdateError(app);
  } catch { /* No previous update error. */ }
  managedUpdater = updater.createUpdater(app, error => {
    installingUpdate = false;
    send({ type: 'updateFailure', message: error.message, version: app.getVersion() });
  });
  try {
    backend = new Backend(backendPath(root, app.isPackaged ? process.resourcesPath : null), send);
  } catch (error) { backendError = error; }

  ipcMain.handle('backend:run', async (event, operation, params) => {
    assertSender(event);
    if (installingUpdate) throw new Error('Wait for the update to finish');
    if (backendError) throw backendError;
    if (recordingOperation) throw new Error('Wait for the recording file operation to finish');
    if (operation === 'analyze' && !knownRuns.has(params?.directory)) throw new Error('Select a saved run first');
    if (operation === 'calibrate' && params?.output && !selectedOutputs.has(params.output)) throw new Error('Choose the calibration folder with the file picker');
    const result = await backend.run(operation, params);
    if (operation === 'calibrate' && params?.output) selectedOutputs.delete(params.output);
    if (operation === 'calibrate' && result?.directory) {
      knownRuns.add(result.directory);
      if (params?.output) {
        try {
          let recent = [];
          try { recent = JSON.parse(await fs.readFile(recentPathFile(), 'utf8')); } catch {}
          if (!Array.isArray(recent)) recent = [];
          await fs.mkdir(path.dirname(recentPathFile()), { recursive: true });
          await fs.writeFile(recentPathFile(), JSON.stringify([params.output, ...recent.filter(value => value !== params.output)].slice(0, 50)));
        } catch (error) { console.error('Could not remember calibration folder:', error); }
      }
    }
    return result;
  });
  ipcMain.handle('backend:cancel', event => {
    assertSender(event);
    return backend?.cancel() ?? false;
  });
  ipcMain.handle('backend:manualIntent', (event, value) => {
    assertSender(event);
    if (installingUpdate) throw new Error('Wait for the update to finish');
    if (backendError) throw backendError;
    backend.manualIntent(value);
  });
  ipcMain.handle('window:setTheme', (event, theme) => {
    assertSender(event);
    if (!['system', 'light', 'dark'].includes(theme)) throw new Error('Unknown appearance');
    nativeTheme.themeSource = theme;
    const dark = nativeTheme.shouldUseDarkColors;
    const background = dark ? '#121212' : '#ffffff';
    window.setBackgroundColor(background);
    if (process.platform !== 'darwin') window.setTitleBarOverlay({
      color: background,
      symbolColor: dark ? '#fafafa' : '#171717',
      height: titleBarOverlayHeight,
    });
  });
  ipcMain.handle('backend:preview', (event, config) => {
    assertSender(event);
    if (backendError) throw backendError;
    return backend.preview(config);
  });
  ipcMain.handle('calibration:pickOutput', async event => {
    assertSender(event);
    if (backend?.active) throw new Error('Finish the current operation first');
    const base = dataDirectory();
    await fs.mkdir(base, { recursive: true });
    const suggested = `calibration-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const result = await dialog.showSaveDialog(window, { title: 'Choose new calibration folder', defaultPath: path.join(base, suggested), buttonLabel: 'Choose folder' });
    if (result.canceled || !result.filePath) return null;
    try { await fs.access(result.filePath); throw new Error('Choose a new folder name; this path already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    selectedOutputs.add(result.filePath);
    return result.filePath;
  });
  ipcMain.handle('reference:get', async (event, uuid) => {
    assertSender(event);
    return Number((await references())[uuidKey(uuid)]) || 0;
  });
  ipcMain.handle('reference:set', async (event, uuid, angle) => {
    assertSender(event);
    if (!Number.isFinite(angle) || Math.abs(angle) > 100) throw new Error('Reference angle must be within ±100 rad');
    const map = await references();
    map[uuidKey(uuid)] = angle;
    await fs.mkdir(path.dirname(referenceFile()), { recursive: true });
    const temp = `${referenceFile()}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(map));
    await fs.rename(temp, referenceFile());
  });
  ipcMain.handle('updates:info', event => {
    assertSender(event);
    return { version: app.getVersion(), updateError };
  });
  ipcMain.handle('updates:check', async event => {
    assertSender(event);
    if (recordingOperation) throw new Error('Wait for the recording file operation to finish');
    if (installingUpdate) throw new Error('Update already in progress');
    if (!managedUpdater) throw new Error('Install a packaged copy of Motor Setup Tool to update from the app');
    checkedUpdate = await managedUpdater.check();
    return checkedUpdate;
  });
  ipcMain.handle('updates:install', async event => {
    assertSender(event);
    if (backend?.active) throw new Error('Stop the motor operation before installing an update');
    if (!checkedUpdate?.installable) throw new Error('Check for an available update first');
    if (!managedUpdater) throw new Error('Install a packaged copy of Motor Setup Tool to update from the app');
    if (recordingOperation) throw new Error('Wait for the recording file operation to finish');
    if (installingUpdate) throw new Error('Update already in progress');
    installingUpdate = true;
    const release = checkedUpdate;
    const progress = message => window?.webContents.send('updates:progress', message);
    let handedOff = false;
    try {
      await managedUpdater.install(release.version, progress, () => {
        if (backend?.active) throw new Error('Stop the motor operation before installing an update');
        if (recordingOperation) throw new Error('Wait for the recording file operation to finish');
      });
      handedOff = true;
    } finally { if (!handedOff) installingUpdate = false; }
  });
  ipcMain.handle('runs:list', async event => { assertSender(event); return listRuns(); });
  ipcMain.handle('runs:pick', async event => {
    assertSender(event);
    const selection = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: 'Open motor recording' });
    if (selection.canceled || !selection.filePaths.length) return null;
    const directory = selection.filePaths[0];
    knownRuns.add(directory);
    return loadRun(directory);
  });
  ipcMain.handle('runs:load', async (event, directory) => {
    assertSender(event);
    return loadRun(directory);
  });
  ipcMain.handle('runs:export', async (event, directory, file = null) => {
    assertSender(event);
    if (!knownRuns.has(directory)) throw new Error('Select a saved run first');
    if (backend?.active || installingUpdate || recordingOperation) throw new Error('Finish the current operation first');
    recordingOperation = true;
    try {
      const run = await recordings.inspectRun(directory);
      if (file !== null && !['training.csv', 'validation.csv', 'calibration.json'].includes(file)) throw new Error('Choose an available recording file');
      if (file && !run.files.includes(file)) throw new Error('Recording file is missing');
      const extension = file ? path.extname(file).slice(1) : 'zip';
      const selection = await dialog.showSaveDialog(window, {
        title: file ? `Download ${file}` : 'Download calibration run',
        defaultPath: path.join(app.getPath('downloads'), recordings.exportName(run, file)),
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      });
      if (selection.canceled || !selection.filePath) return null;
      return await recordings.exportRun(directory, selection.filePath, file);
    } finally { recordingOperation = false; }
  });
  ipcMain.handle('runs:delete', async (event, directory) => {
    assertSender(event);
    if (!knownRuns.has(directory)) throw new Error('Select a saved run first');
    if (backend?.active || installingUpdate || recordingOperation) throw new Error('Finish the current operation first');
    recordingOperation = true;
    try {
      await recordings.deleteRun(directory);
      knownRuns.delete(directory);
      let recent = [];
      try { recent = JSON.parse(await fs.readFile(recentPathFile(), 'utf8')); } catch { /* No recent paths. */ }
      try { if (Array.isArray(recent)) await fs.writeFile(recentPathFile(), JSON.stringify(recent.filter(item => item !== directory))); }
      catch { /* Deletion succeeded; stale recent entries are ignored by listRuns. */ }
      return { directory };
    } finally { recordingOperation = false; }
  });
  ipcMain.handle('runs:show', async (event, directory) => {
    assertSender(event);
    if (!knownRuns.has(directory)) throw new Error('Select a saved run first');
    shell.showItemInFolder(path.join(directory, 'report.json'));
  });
  ipcMain.handle('runs:copyPath', async (event, directory) => {
    assertSender(event);
    if (!knownRuns.has(directory)) throw new Error('Select a saved run first');
    await clipboard.writeText(directory);
  });
  ipcMain.handle('links:firmwareRelease', async event => {
    assertSender(event);
    await shell.openExternal('https://github.com/RobStride/Product_Information/releases/tag/V26.05.19');
  });
  createWindow();
});

app.on('before-quit', event => {
  if (!backend?.active) return;
  event.preventDefault();
  quitting = true;
  try { backend.cancel(); }
  catch { send({ type: 'progress', message: 'Finishing firmware transfer before exit…' }); }
});

app.on('window-all-closed', () => app.quit());
