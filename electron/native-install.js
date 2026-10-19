'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const linuxLauncher = '/opt/Motor Setup Tool/motor-setup-tool';

function mode(app, platform = process.platform, executable = process.execPath) {
  if (!app.isPackaged) return null;
  if (platform === 'linux' && executable === linuxLauncher) return 'linux';
  if (platform === 'win32' && path.win32.basename(executable).toLowerCase() === 'motor setup tool.exe') return 'windows';
  if (platform === 'darwin') return 'mac-dmg';
  return null;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed (${signal || code}). The app was not updated.`)));
  });
}

async function installLinux(app, installer, progress) {
  const command = installer.endsWith('.rpm') ? '/usr/bin/rpm' : '/usr/bin/dpkg';
  const args = installer.endsWith('.rpm') ? ['-Uvh', installer] : ['-i', installer];
  await fs.access('/usr/bin/pkexec');
  await fs.access(command);
  progress('Waiting for system authorization…');
  await run('/usr/bin/pkexec', [command, ...args]);
  progress('Installed. Restarting…');
  app.relaunch();
  app.quit();
}

async function installWindows(app, installer, version, progress) {
  const directory = app.getPath('userData');
  const helper = path.join(directory, 'install-update.ps1');
  const readyFile = path.join(directory, `update-ready-${process.pid}.txt`);
  const pendingFile = path.join(directory, 'pending-update.json');
  const resultFile = path.join(directory, 'update-error.txt');
  await fs.mkdir(directory, { recursive: true });
  await fs.copyFile(path.join(__dirname, 'install-windows.ps1'), helper);
  await fs.rm(readyFile, { force: true });
  await fs.rm(resultFile, { force: true });
  await fs.writeFile(pendingFile, JSON.stringify({ version, previousVersion: app.getVersion(), executable: app.getPath('exe') }));
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-ParentPid', String(process.pid), '-Installer', installer, '-AppExe', app.getPath('exe'),
    '-ExpectedVersion', version, '-ResultFile', resultFile, '-ReadyFile', readyFile];
  const child = spawn('powershell.exe', args, { cwd: directory, detached: true, stdio: 'ignore', windowsHide: true });
  let launchError;
  child.once('error', error => { launchError = error; });
  try {
    const deadline = Date.now() + 15_000;
    while (true) {
      if (launchError) throw launchError;
      try { await fs.access(readyFile); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (child.exitCode !== null || Date.now() >= deadline) {
        const detail = await fs.readFile(resultFile, 'utf8').catch(() => 'The Windows update helper did not start.');
        throw new Error(detail);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } catch (error) {
    child.kill();
    await fs.rm(pendingFile, { force: true });
    throw error;
  }
  child.unref();
  progress('Installing update. The app will restart…');
  setTimeout(() => app.quit(), 100);
}

async function readUpdateError(app) {
  const directory = app.getPath('userData');
  const errorFile = path.join(directory, 'update-error.txt');
  let error = await fs.readFile(errorFile, 'utf8').catch(() => null);
  const pendingFile = path.join(directory, 'pending-update.json');
  let pending;
  try { pending = JSON.parse(await fs.readFile(pendingFile, 'utf8')); }
  catch (failure) { if (failure.code !== 'ENOENT') error ||= 'The previous update could not be verified. Please install the latest release again.'; }
  if (pending?.version) {
    if (pending.version === app.getVersion()) {
      if (!error) await fs.rm(errorFile, { force: true });
    } else {
      error ||= `Update to ${pending.version} did not complete. This app is still ${app.getVersion()}. Please run the downloaded installer again. Details: ${path.join(directory, 'update.log')}`;
      await fs.writeFile(errorFile, error);
    }
    await fs.rm(pendingFile, { force: true });
  }
  return error;
}

async function install(app, installer, version, progress, openPath) {
  const target = mode(app);
  if (target === 'linux') return installLinux(app, installer, progress);
  if (target === 'windows') return installWindows(app, installer, version, progress);
  if (target === 'mac-dmg') {
    const error = await openPath(installer);
    if (error) throw new Error(`Could not open disk image: ${error}`);
    progress('Disk image opened. Drag Motor Setup Tool to Applications.');
    return;
  }
  throw new Error('Install a packaged copy of Motor Setup Tool to update from the app');
}

module.exports = { install, installWindows, mode, readUpdateError };
