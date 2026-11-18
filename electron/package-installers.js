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
if (platform === 'win32') {
  // NSIS shortcuts target PRODUCT_FILENAME.exe; productName is the default filename.
  const config = require('./builder.json');
  const shortcutTarget = `${config.win.executableName || config.executableName || config.productName}.exe`;
  if (!fs.existsSync(path.join(staged, shortcutTarget))) {
    throw new Error(`Windows launcher ${shortcutTarget} is missing; NSIS shortcuts would be broken`);
  }
}

const resources = platform === 'darwin' ? path.join(prepackaged, 'Contents', 'Resources') : path.join(prepackaged, 'resources');
const config = structuredClone(require('./builder.json'));
config.directories.app = path.join(resources, 'app');
config.extraResources = [{ from: path.join(resources, 'backend'), to: 'backend' }];
config.electronVersion = require('electron/package.json').version;
if (platform === 'linux') {
  // FPM expands ${arch} as amd64/x86_64/aarch64 depending on package format.
  // Set the public architecture once so metadata and existing clients agree.
  config.linux.artifactName = 'motor-setup-tool-${version}-linux-' + arch + '.${ext}';
  // Own the rule in the system rules directory instead of leaving it under
  // /opt. Keep builder's desktop/sandbox/AppArmor hooks and append our reload.
  const packageOptions = { fpm: [path.join(root, 'packaging', '70-motomind-gsusb.rules') + '=/usr/lib/udev/rules.d/70-motomind-gsusb.rules'] };
  const templates = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates', 'linux');
  for (const [option, name] of [['afterInstall', 'after-install'], ['afterRemove', 'after-remove']]) {
    const script = path.join(root, 'dist-electron', `linux-${name}.sh`);
    fs.writeFileSync(script, fs.readFileSync(path.join(templates, `${name}.tpl`), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'packaging', 'linux-udev.sh'), 'utf8'));
    packageOptions[option] = script;
  }
  for (const target of ['deb', 'rpm']) config[target] = { ...config[target], ...packageOptions };
}
const buildEnv = { ...process.env };
// GitHub expands missing secrets to empty strings; builder otherwise treats
// an empty CSC_LINK as the current directory rather than "no certificate".
for (const name of ['CSC_LINK', 'CSC_NAME', 'WIN_CSC_LINK']) {
  if (!buildEnv[name]) delete buildEnv[name];
}
if (platform === 'darwin' && process.env.MOTOMIND_REQUIRE_SIGNING === '1') {
  for (const name of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    if (!process.env[name]) throw new Error(`macOS release auto-updates require Developer ID signing and notarization. Missing ${name}; see packaging/README.md.`);
  }
  config.forceCodeSigning = true;
  config.mac.notarize = true;
} else if (platform === 'darwin' && !buildEnv.CSC_LINK && !buildEnv.CSC_NAME) {
  config.mac.identity = '-';
  // Ad-hoc test signatures have no Team ID for hardened library validation.
  // Signed production builds keep the hardened runtime enabled.
  config.mac.hardenedRuntime = false;
}
const configFile = path.join(root, 'dist-electron', 'installer-config.json');
fs.writeFileSync(configFile, JSON.stringify(config));
// A normal builder pack is required: --prepackaged skips signing and the
// app-update.yml/elevation resources needed by the maintained updaters.
const targets = platform === 'linux' ? ['--linux', 'deb', 'rpm'] : platform === 'darwin' ? ['--mac', 'dmg', 'zip'] : ['--win', 'nsis'];
execFileSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--config', configFile, ...targets, `--${arch}`, '--publish', 'never'], { cwd: __dirname, env: buildEnv, stdio: 'inherit' });

if (platform === 'darwin') {
  const finalApp = path.join(installers, `mac-${arch}`, 'Motor Setup Tool.app');
  const finalBackend = path.join(finalApp, 'Contents', 'Resources', 'backend');
  for (const binary of [finalApp, path.join(finalBackend, 'motor-setup-tool'), path.join(finalBackend, 'lib', 'libmujoco.3.12.0.dylib')]) {
    execFileSync('codesign', ['--verify', '--strict', binary]);
  }
  const runtimeEnv = { ...process.env };
  delete runtimeEnv.DYLD_LIBRARY_PATH;
  const result = JSON.parse(execFileSync(path.join(finalBackend, 'motor-setup-tool'), ['self-check'], { env: runtimeEnv, encoding: 'utf8', timeout: 30_000 }));
  if (result.version !== pkg.version || result.mujoco !== '3.12.0') throw new Error('Final signed macOS backend self-check failed');
}

const extensions = platform === 'linux' ? ['deb', 'rpm'] : platform === 'darwin' ? ['dmg', 'zip'] : ['exe'];
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
for (const name of fs.readdirSync(installers).filter(name => name.endsWith('.yml') || name.endsWith('.blockmap'))) {
  fs.copyFileSync(path.join(installers, name), path.join(root, 'dist-electron', name));
}
const metadata = platform === 'darwin' ? 'latest-mac.yml' : platform === 'win32' ? 'latest.yml' : `latest-linux${arch === 'x64' ? '' : `-${arch}`}.yml`;
require('./update-metadata').verifyMetadata(path.join(root, 'dist-electron'), [metadata], pkg.version);
