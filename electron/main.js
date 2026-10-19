'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, session, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { Backend, backendPath } = require('./backend');
const updater = require('./updater');

const root = path.resolve(__dirname, '..');
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
  const stat = await fs.stat(path.join(directory, 'report.json'));
  if (stat.size > 32_000_000) throw new Error('Report is too large to display');
  const report = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8'));
  if (report.source !== 'hardware' || !Array.isArray(report.replays)) {
    throw new Error('Select a completed real motor recording');
  }
  return { directory, report };
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
    const name = path.basename(directory);
    try { await fs.access(path.join(directory, 'report.json')); }
    catch { return null; }
    let model = null;
    let motorId = null;
    try {
      const configPath = path.join(directory, 'config.json');
      if ((await fs.stat(configPath)).size <= 8192) {
        const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
        if (/^RS-0[0-6]$/.test(config.profile?.model) && Number.isInteger(config.motor_id)) {
          model = config.profile.model;
          motorId = config.motor_id;
        }
      }
    } catch { /* Older runs can still be opened by folder name. */ }
    knownRuns.add(directory);
    const timestamp = /^\d{13}(?=-|$)/.exec(name)?.[0];
    const modified = (await fs.stat(path.join(directory, 'report.json'))).mtimeMs;
    return { name, directory, model, motorId, timestamp: timestamp ? Number(timestamp) : modified };
  }));
  return runs.filter(Boolean).sort((a, b) => b.timestamp - a.timestamp);
}

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1060,
    minHeight: 700,
    title: 'Motor Setup Tool · Motomind',
    icon: path.join(root, 'assets', 'icons', '256.png'),
    backgroundColor: '#f4f5f7',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  if (process.platform === 'linux') window.setMenuBarVisibility(false);
  window.loadFile(path.join(__dirname, 'index.html'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => { try { backend?.cancel(); } catch { /* Firmware transfer finishes before exit. */ } });
  window.webContents.on('did-finish-load', () => {
    if (backendError) send({ type: 'error', message: backendError.message });
    if (process.env.MOTOMIND_SMOKE_PATH) {
      setTimeout(async () => {
        try {
          if (process.env.MOTOMIND_SMOKE_REPORT) {
            const directory = process.env.MOTOMIND_SMOKE_REPORT;
            knownRuns.add(directory);
            await window.webContents.executeJavaScript(`window.motorApp.loadRun(${JSON.stringify(directory)}).then(openReport)`);
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          if (['calibrate', 'test', 'setup', 'files'].includes(process.env.MOTOMIND_SMOKE_TAB)) {
            await window.webContents.executeJavaScript(`setTab(${JSON.stringify(process.env.MOTOMIND_SMOKE_TAB)})`);
            await new Promise(resolve => setTimeout(resolve, 400));
          }
          if (['slcan', 'gsusb'].includes(process.env.MOTOMIND_SMOKE_TRANSPORT)) {
            await window.webContents.executeJavaScript(`document.getElementById("transport-select").value = ${JSON.stringify(process.env.MOTOMIND_SMOKE_TRANSPORT)}; document.getElementById("transport-select").dispatchEvent(new Event("change"))`);
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          if (['system', 'light', 'dark'].includes(process.env.MOTOMIND_SMOKE_THEME)) {
            await window.webContents.executeJavaScript(`document.getElementById("theme-select").value = ${JSON.stringify(process.env.MOTOMIND_SMOKE_THEME)}; document.getElementById("theme-select").dispatchEvent(new Event("change"))`);
          }
          if (process.env.MOTOMIND_SMOKE_COLLAPSE === '1') {
            await window.webContents.executeJavaScript('document.getElementById("connection-panel").open = false');
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (process.env.MOTOMIND_SMOKE_SETTINGS === '1') {
            await window.webContents.executeJavaScript('document.getElementById("settings-dialog").showModal()');
          }
          const details = await window.webContents.executeJavaScript('({title:document.title,bridge:typeof window.motorApp,can:document.getElementById("can-state").textContent,logo:document.querySelector(".brand img").naturalWidth,tab:state.tab,actionsHidden:document.getElementById("top-actions").classList.contains("hidden"),theme:document.documentElement.dataset.theme,appearance:document.getElementById("theme-select").value,connectionOpen:document.getElementById("connection-panel").open})');
          await fs.writeFile(process.env.MOTOMIND_SMOKE_PATH, (await window.webContents.capturePage()).toPNG());
          console.log(JSON.stringify(details));
          app.quit();
        } catch (error) { console.error(error); app.exit(1); }
      }, 800);
    }
  });
  window.on('closed', () => { window = null; });
}

app.whenReady().then(async () => {
  if (await updater.launchInstalledIfNewer(app)) { app.quit(); return; }
  app.setAppUserModelId('com.motomind.MotorSetup');
  if (process.platform === 'linux') Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  try {
    backend = new Backend(backendPath(root, process.resourcesPath), send);
  } catch (error) { backendError = error; }

  ipcMain.handle('backend:run', async (event, operation, params) => {
    assertSender(event);
    if (backendError) throw backendError;
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
    if (backendError) throw backendError;
    backend.manualIntent(value);
  });
  ipcMain.handle('backend:preview', (event, config) => {
    assertSender(event);
    if (backendError) throw backendError;
    return backend.preview(config);
  });
  ipcMain.handle('calibration:pickOutput', async event => {
    assertSender(event);
    if (backend?.active) throw new Error('Finish the current operation first');
    const base = path.join(process.platform === 'linux' ? process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share') : app.getPath('appData'), 'motomind-motor-calib', 'runs');
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
  ipcMain.handle('updates:info', event => { assertSender(event); return { version: app.getVersion() }; });
  ipcMain.handle('updates:check', async event => {
    assertSender(event);
    checkedUpdate = await updater.check(app.getVersion());
    return { available: checkedUpdate.available, version: checkedUpdate.version, installable: checkedUpdate.installable };
  });
  ipcMain.handle('updates:install', async event => {
    assertSender(event);
    if (backend?.active) throw new Error('Stop the motor operation before installing an update');
    if (!checkedUpdate?.installable) throw new Error('Check for an available update first');
    await updater.install(app, checkedUpdate, message => window?.webContents.send('updates:progress', message));
    app.quit();
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
