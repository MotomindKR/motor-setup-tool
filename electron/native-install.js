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
  const helper = path.join(app.getPath('userData'), 'install-update.ps1');
  await fs.mkdir(path.dirname(helper), { recursive: true });
  await fs.copyFile(path.join(__dirname, 'install-windows.ps1'), helper);
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-ParentPid', String(process.pid), '-Installer', installer, '-AppExe', process.execPath,
    '-ExpectedVersion', version,
    '-ResultFile', path.join(app.getPath('userData'), 'update-error.txt')];
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  progress('Installing update. The app will restart…');
  setTimeout(() => app.quit(), 100);
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

module.exports = { install, mode };
