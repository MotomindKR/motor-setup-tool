'use strict';

// Windows integration fixture: keep a real installed Electron app running
// while the normal updater hands off to its detached PowerShell helper.
const path = require('node:path');
const { spawn } = require('node:child_process');
const { installWindows } = require('./native-install');

const [installer, version, executable, directory, screenshot] = process.argv.slice(2);
const previousVersion = require(path.join(path.dirname(executable), 'resources', 'app', 'package.json')).version;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MOTOMIND_SMOKE_PATH;
const runningApp = spawn(executable, [], { cwd: path.dirname(executable), env, detached: true, stdio: 'ignore' });
runningApp.once('error', error => { console.error(error); process.exit(1); });
runningApp.unref();
process.env.MOTOMIND_SMOKE_PATH = screenshot;
process.env.MOTOMIND_SMOKE_TAB = 'setup';
const app = {
  getVersion: () => previousVersion,
  getPath: name => name === 'exe' ? executable : directory,
  quit: () => {
    const closing = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$running = Get-Process -Id ${runningApp.pid} -ErrorAction SilentlyContinue; if ($running) { $null = $running.CloseMainWindow() }`],
    { windowsHide: true, stdio: 'ignore' });
    closing.once('error', error => { console.error(error); process.exit(1); });
    closing.once('exit', code => process.exit(code || 0));
  },
};
setTimeout(() => installWindows(app, installer, version, () => {}).catch(error => {
  console.error(error);
  process.exit(1);
}), 2000);
