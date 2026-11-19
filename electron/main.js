'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, session, Menu, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Backend, backendPath } = require('./backend');
const { DxlWorker, grantPortAccess } = require('./dxl');
const updater = require('./updater');
const recordings = require('./recordings');

if (process.platform === 'linux') app.setDesktopName('motor-setup-tool.desktop');
if (!app.isPackaged && process.env.MOTOMIND_TEST_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.MOTOMIND_TEST_USER_DATA));
}

const root = path.resolve(__dirname, '..');
const titleBarHeight = 40;
const updateCheckInterval = 4 * 60 * 60 * 1000;
// Leave the header's bottom border below the opaque native window controls.
const titleBarOverlayHeight = process.platform === 'darwin' ? titleBarHeight : titleBarHeight - 1;
const knownRuns = new Set();
let selectedOutput = null;
const recentPathFile = () => path.join(app.getPath('userData'), 'recent-calibrations.json');
const referenceFile = () => path.join(app.getPath('userData'), 'motor-references.json');
function uuidKey(value) {
  if (!Array.isArray(value) || value.length !== 8 || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error('Select a motor with a valid UUID');
  return Buffer.from(value).toString('hex');
}
async function readSettings(file, initial) {
  let contents;
  try { contents = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return initial; throw error; }
  const value = JSON.parse(contents);
  if (!value || typeof value !== 'object' || Array.isArray(value) !== Array.isArray(initial)) {
    throw new Error(`Invalid settings in ${file}`);
  }
  return value;
}

async function recentPaths() {
  const paths = await readSettings(recentPathFile(), []);
  return paths.filter(value => typeof value === 'string' && path.isAbsolute(value));
}

let recentWrite = Promise.resolve();
function updateRecent(directory, add) {
  if (path.dirname(directory) === dataDirectory()) return;
  recentWrite = recentWrite.then(async () => {
    const recent = await recentPaths();
    const next = recent.filter(value => value !== directory);
    if (add) next.unshift(directory);
    else if (recent.length === next.length) return;
    const file = recentPathFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(next.slice(0, 50)));
    await fs.rename(temporary, file);
  }).catch(error => console.error('Could not update recent calibration folders:', error));
  return recentWrite;
}

function rememberRun(directory) {
  knownRuns.add(directory);
  return updateRecent(directory, true);
}

let window;
let backend;
let backendError;
let quitting = false;
let checkedUpdate = null;
let updateCheck = null;
let installingUpdate = false;
let updateError = null;
let managedUpdater = null;
let recordingOperation = false;
let dxl;
let dxlDialog = false;

const dxlBackupDir = () => path.join(app.getPath('userData'), 'dxl-backups');

function send(event) {
  if (event.type === 'recordingCreated') {
    rememberRun(event.directory);
    return;
  }
  if (window && !window.isDestroyed()) window.webContents.send('backend:event', event);
  if (quitting && event.type === 'finish') app.quit();
}

function requireIdleForUpdate() {
  if (backend?.active) throw new Error('Stop the motor operation before installing an update');
  if (dxl.active || dxlDialog) throw new Error('Finish the current DXL operation before updating');
  if (recordingOperation) throw new Error('Wait for the recording file operation to finish');
}

function checkForUpdate() {
  updateCheck ??= managedUpdater.check().then(result => {
    checkedUpdate = result;
    send({ type: 'updateChecked', result });
    return result;
  }).finally(() => { updateCheck = null; });
  return updateCheck;
}

function handle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Invalid app window');
    }
    return handler(...args);
  });
}

function handleRecordingWrite(channel, handler) {
  handle(channel, async (directory, ...args) => {
    requireKnownRun(directory);
    if (backendError) throw backendError;
    if (backend?.active || installingUpdate || recordingOperation) throw new Error('Finish the current operation first');
    recordingOperation = true;
    try { return await handler(directory, ...args); }
    finally { recordingOperation = false; }
  });
}

function dataDirectory() {
  const base = process.platform === 'linux'
    ? process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
    : app.getPath('appData');
  return path.join(base, 'motomind-motor-calib', 'runs');
}

function requireKnownRun(directory) {
  if (!knownRuns.has(directory)) throw new Error('Select a saved run first');
  return directory;
}

async function listRuns() {
  const base = dataDirectory();
  let entries;
  try { entries = await fs.readdir(base, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') entries = []; else throw error; }
  const custom = await recentPaths().catch(error => {
    console.error('Could not read recent calibration folders:', error);
    return [];
  });
  const directories = [...new Set([...knownRuns, ...entries.filter(entry => entry.isDirectory()).map(entry => path.join(base, entry.name)), ...custom])];
  const runs = [];
  for (const directory of directories) {
    try {
      runs.push(await recordings.inspectRun(directory));
      knownRuns.add(directory);
    } catch {
      knownRuns.delete(directory);
    }
  }
  return runs.sort((a, b) => b.timestamp - a.timestamp);
}

async function captureStartup(destination) {
  const contents = window.webContents;
  const details = await contents.executeJavaScript(`(async () => {
    const deadline = performance.now() + 10000;
    while (!document.querySelector('.app-header')) {
      if (performance.now() >= deadline) throw new Error('Desktop UI did not render');
      await new Promise(requestAnimationFrame);
    }
    return { title: document.title, bridge: typeof window.motorApp };
  })()`);
  if (process.env.MOTOMIND_SMOKE_DXL === '1') {
    const reply = await contents.executeJavaScript(
      "window.motorApp.dxl('connect', { demo: true, port: '', baud: 1000000 })",
    );
    if (reply.error || reply.result?.motors.length !== 7) throw new Error(reply.error || 'DXL demo failed');
    details.dxlMotors = reply.result.motors.length;
  }
  if (backendError) throw backendError;
  const { stdout } = await promisify(execFile)(backend.binary, ['self-check'], { env: backend.environment, timeout: 15000 });
  await fs.writeFile(destination, (await contents.capturePage()).toPNG());
  await fs.writeFile(`${destination}.json`, JSON.stringify({
    ...details, version: app.getVersion(), backendVersion: JSON.parse(stdout).version, updateError,
  }));
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
  window.webContents.on('render-process-gone', () => {
    void dxl.close();
    backend?.cancel();
  });
  window.webContents.on('did-finish-load', () => {
    if (backendError) send({ type: 'error', message: backendError.message });
    if (updateError) send({ type: 'updateFailure', message: updateError, version: app.getVersion() });
    if (process.env.MOTOMIND_SMOKE_PATH) {
      captureStartup(process.env.MOTOMIND_SMOKE_PATH).then(() => app.quit()).catch(error => {
        console.error(error);
        app.exit(1);
      });
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
  } catch (error) { updateError = `Could not verify the previous update: ${error.message}`; }
  managedUpdater = updater.createUpdater(app, error => {
    if (!installingUpdate) return;
    installingUpdate = false;
    send({ type: 'updateFailure', message: error.message, version: app.getVersion() });
  });
  try {
    backend = new Backend(backendPath(root, app.isPackaged ? process.resourcesPath : null), send);
  } catch (error) { backendError = error; }
  dxl = new DxlWorker({ root, resourcesPath: app.isPackaged ? process.resourcesPath : null, backupDir: dxlBackupDir() });

  handle('dxl:run', async (operation, params) => {
    if (quitting || installingUpdate) throw new Error('Wait for the app to finish');
    if (dxlDialog && operation !== 'poll') throw new Error('Finish the current DXL operation');
    if (operation === 'disconnect') {
      await dxl.close();
      return { connected: false, faulted: false, result: {} };
    }
    const filters = [{ name: 'DXL settings', extensions: ['json'] }];
    if (operation === 'export' || operation === 'restore') {
      dxlDialog = true;
      try {
        const selection = operation === 'export'
          ? await dialog.showSaveDialog(window, { title: 'Export DXL settings', defaultPath: 'dxl-settings.json', filters })
          : await dialog.showOpenDialog(window, { title: 'Restore DXL zero and direction', defaultPath: dxlBackupDir(), filters, properties: ['openFile'] });
        if (selection.canceled || quitting) return null;
        return await dxl.run(operation, { ids: params.ids, path: selection.filePath || selection.filePaths[0] });
      } finally { dxlDialog = false; }
    }
    if (operation === 'authorize') {
      dxlDialog = true;
      try {
        await grantPortAccess(params.port);
        return { connected: false, faulted: false, result: {} };
      } finally { dxlDialog = false; }
    }
    return dxl.run(operation, params);
  });
  handle('dxl:backups', async () => {
    const directory = dxlBackupDir();
    await fs.mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });

  handle('backend:run', async (operation, params) => {
    if (installingUpdate) throw new Error('Wait for the update to finish');
    if (backendError) throw backendError;
    if (recordingOperation) throw new Error('Wait for the recording file operation to finish');
    if (operation === 'analyze') requireKnownRun(params?.directory);
    if (operation === 'calibrate' && params?.output) {
      if (params.output !== selectedOutput) throw new Error('Choose the calibration folder with the file picker');
      selectedOutput = null;
    }
    return backend.run(operation, params);
  });
  handle('backend:cancel', () => backend?.cancel() ?? false);
  handle('backend:manualIntent', (value) => {
    if (installingUpdate) throw new Error('Wait for the update to finish');
    if (backendError) throw backendError;
    backend.manualIntent(value);
  });
  handle('window:setTheme', (theme, caption) => {
    if (!['system', 'light', 'dark'].includes(theme)) throw new Error('Unknown appearance');
    if (caption !== undefined && (!caption || !/^#[0-9a-f]{6}$/i.test(caption.color) || !/^#[0-9a-f]{6}$/i.test(caption.symbolColor))) throw new Error('Invalid window colors');
    nativeTheme.themeSource = theme;
    const dark = nativeTheme.shouldUseDarkColors;
    const background = dark ? '#121212' : '#ffffff';
    window.setBackgroundColor(background);
    if (process.platform !== 'darwin') window.setTitleBarOverlay({
      color: caption?.color ?? background,
      symbolColor: caption?.symbolColor ?? (dark ? '#fafafa' : '#171717'),
      height: titleBarOverlayHeight,
    });
  });
  handle('backend:preview', (config) => {
    if (backendError) throw backendError;
    return backend.preview(config);
  });
  handle('calibration:pickOutput', async () => {
    if (backend?.active) throw new Error('Finish the current operation first');
    const base = dataDirectory();
    await fs.mkdir(base, { recursive: true });
    const suggested = `calibration-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const result = await dialog.showSaveDialog(window, { title: 'Choose new calibration folder', defaultPath: path.join(base, suggested), buttonLabel: 'Choose folder' });
    if (result.canceled || !result.filePath) return null;
    try { await fs.access(result.filePath); throw new Error('Choose a new folder name; this path already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    selectedOutput = result.filePath;
    return result.filePath;
  });
  handle('reference:get', async (uuid) => {
    return Number((await readSettings(referenceFile(), {}))[uuidKey(uuid)]) || 0;
  });
  handle('reference:set', async (uuid, angle) => {
    if (!Number.isFinite(angle) || Math.abs(angle) > 100) throw new Error('Reference angle must be within ±100 rad');
    const map = await readSettings(referenceFile(), {});
    map[uuidKey(uuid)] = angle;
    await fs.mkdir(path.dirname(referenceFile()), { recursive: true });
    const temp = `${referenceFile()}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(map));
    await fs.rename(temp, referenceFile());
  });
  handle('updates:info', () => {
    return { version: app.getVersion(), updateError, updateResult: checkedUpdate };
  });
  handle('updates:check', async () => {
    if (recordingOperation) throw new Error('Wait for the recording file operation to finish');
    if (installingUpdate) throw new Error('Update already in progress');
    if (!managedUpdater) throw new Error('Install a packaged copy of Motor Setup Tool to update from the app');
    return checkForUpdate();
  });
  handle('updates:install', async version => {
    // A check can change the updater's selected release. Let it finish before downloading.
    if (updateCheck) await updateCheck;
    requireIdleForUpdate();
    if (!checkedUpdate?.available) throw new Error('Check for an available update first');
    if (checkedUpdate.version !== version) throw new Error('The available update changed. Review the new version before installing.');
    if (!managedUpdater) throw new Error('Install a packaged copy of Motor Setup Tool to update from the app');
    if (installingUpdate) throw new Error('Update already in progress');
    if (checkedUpdate.releasePage) return shell.openExternal(checkedUpdate.releasePage);
    installingUpdate = true;
    const progress = message => window?.webContents.send('updates:progress', message);
    let handedOff = false;
    try {
      await managedUpdater.install(version, progress, requireIdleForUpdate);
      handedOff = true;
    } finally { if (!handedOff) installingUpdate = false; }
  });
  handle('runs:list', listRuns);
  handle('runs:pick', async () => {
    const selection = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: 'Open motor recording' });
    if (selection.canceled || !selection.filePaths.length) return null;
    const directory = selection.filePaths[0];
    const result = await recordings.loadRun(directory);
    await rememberRun(directory);
    return result;
  });
  handle('runs:load', directory => recordings.loadRun(requireKnownRun(directory)));
  handleRecordingWrite('runs:export', async (directory, file = null) => {
    const run = await recordings.inspectRun(directory);
    if (file !== null && !recordings.SINGLE_FILES.includes(file)) throw new Error('Choose an available recording file');
    if (file && !run.files.includes(file)) throw new Error('Recording file is missing');
    const extension = file ? path.extname(file).slice(1) : 'zip';
    const selection = await dialog.showSaveDialog(window, {
      title: file ? `Download ${file}` : 'Download calibration run',
      defaultPath: path.join(app.getPath('downloads'), recordings.exportName(run, file)),
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    return backend.withRecordingLock(directory, () => recordings.exportRun(directory, selection.filePath, file));
  });
  handleRecordingWrite('runs:delete', async (directory) => {
    await backend.withRecordingLock(directory, () => recordings.deleteRun(directory));
    knownRuns.delete(directory);
    await updateRecent(directory, false);
    return { directory };
  });
  handle('runs:show', async (directory) => {
    requireKnownRun(directory);
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });
  handle('runs:copyPath', directory => clipboard.writeText(requireKnownRun(directory)));
  handle('links:firmwareRelease', async (model) => {
    const release = require('../src/firmware_catalog.json').find(entry => entry.model === model);
    const page = release
      ? new URL('.', release.url).href.replace('/releases/download/', '/releases/tag/').replace(/\/$/, '')
      : 'https://github.com/RobStride/Product_Information/releases';
    await shell.openExternal(page);
  });
  createWindow();
  if (managedUpdater && !process.env.MOTOMIND_SMOKE_PATH) {
    const checkInBackground = () => {
      if (!installingUpdate && !quitting) checkForUpdate().catch(() => {});
    };
    checkInBackground();
    const timer = setInterval(checkInBackground, updateCheckInterval);
    app.once('will-quit', () => clearInterval(timer));
  }
});

app.on('before-quit', event => {
  if (dxl?.child) {
    event.preventDefault();
    quitting = true;
    void dxl.close().then(() => app.quit());
  }
  if (!backend?.active) return;
  event.preventDefault();
  quitting = true;
  backend.cancel();
});

app.on('window-all-closed', () => app.quit());
