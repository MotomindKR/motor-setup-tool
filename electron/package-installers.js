'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = require('./package.json');
const platform = process.platform;
const arch = process.arch;
if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error('Unsupported desktop platform');
if (platform === 'darwin' && arch !== 'arm64') throw new Error('macOS releases require ARM64');
if (platform === 'win32' && arch !== 'x64') throw new Error('Windows releases require x64');

const staged = path.join(root, 'dist-electron', `motor-setup-tool-electron-${platform}-${arch}`);
const prepackaged = platform === 'darwin' ? path.join(staged, 'Motor Setup Tool.app') : staged;
const installers = path.join(root, 'dist-electron', 'installers');
fs.rmSync(installers, { recursive: true, force: true });
execFileSync(process.execPath, [path.join(__dirname, 'package-desktop.js')], { stdio: 'inherit' });

const targets = platform === 'linux' ? ['--linux', 'deb', 'rpm'] : platform === 'darwin' ? ['--mac', 'dmg'] : ['--win', 'nsis'];
execFileSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--prepackaged', prepackaged, '--config', path.join(__dirname, 'builder.json'), ...targets, `--${arch}`, '--publish', 'never'], { cwd: __dirname, stdio: 'inherit' });

const extensions = platform === 'linux' ? ['deb', 'rpm'] : platform === 'darwin' ? ['dmg'] : ['exe'];
for (const extension of extensions) {
  const matches = fs.readdirSync(installers).filter(name => name.endsWith(`.${extension}`));
  if (matches.length !== 1) throw new Error(`Expected one ${extension} installer, found ${matches.length}`);
  const name = `motor-setup-tool-${pkg.version}-${platform}-${arch}.${extension}`;
  const destination = path.join(root, 'dist-electron', name);
  fs.rmSync(destination, { force: true });
  fs.renameSync(path.join(installers, matches[0]), destination);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
  fs.writeFileSync(`${destination}.sha256`, `${digest}  ${name}\n`);
  console.log(`Release installer ${destination}`);
}
