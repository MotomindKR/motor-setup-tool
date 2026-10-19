'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (!['linux', 'darwin', 'win32'].includes(process.platform)) throw new Error('Unsupported desktop platform');

const root = path.resolve(__dirname, '..');
const electronBinary = require('electron');
const runtime = process.platform === 'darwin'
  ? path.dirname(path.dirname(path.dirname(electronBinary)))
  : path.dirname(electronBinary);
const stem = `motor-setup-tool-electron-${process.platform}-${process.arch}`;
const output = path.join(root, 'dist-electron', stem);
const bundle = process.platform === 'darwin' ? path.join(output, 'Motor Setup Tool.app') : output;
const resources = process.platform === 'darwin' ? path.join(bundle, 'Contents', 'Resources') : path.join(bundle, 'resources');
const app = path.join(resources, 'app');
const backend = path.join(resources, 'backend');
const binaryName = process.platform === 'win32' ? 'motor-setup-tool.exe' : 'motor-setup-tool';
const sourceBinary = process.env.MOTOMIND_BACKEND || path.join(root, 'target', 'release', binaryName);
const sdkDir = process.env.MUJOCO_DYNAMIC_LINK_DIR || path.join(root, '.tools', 'mujoco', 'mujoco-3.12.0', 'lib');
const mujocoName = process.platform === 'darwin' ? 'libmujoco.3.12.0.dylib' : process.platform === 'win32' ? 'mujoco.dll' : 'libmujoco.so.3.12.0';
const mujoco = process.platform === 'win32' ? path.join(path.dirname(sdkDir), 'bin', mujocoName) : path.join(sdkDir, mujocoName);

for (const source of [sourceBinary, mujoco]) {
  if (!fs.existsSync(source)) throw new Error(`Missing ${source}. Build the release backend and install the pinned MuJoCo SDK first.`);
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.rmSync(output, { recursive: true, force: true });
if (process.platform === 'darwin') {
  fs.mkdirSync(output);
  // Electron frameworks use relative symlinks at their roots. Rebasing them
  // makes macOS reject the copied app as an invalid framework bundle.
  fs.cpSync(runtime, bundle, { recursive: true, verbatimSymlinks: true });
  const oldBinary = path.join(bundle, 'Contents', 'MacOS', 'Electron');
  fs.renameSync(oldBinary, path.join(bundle, 'Contents', 'MacOS', 'Motor Setup Tool'));
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  let info = fs.readFileSync(plist, 'utf8');
  info = info.replace(/(<key>CFBundleExecutable<\/key>\s*<string>)Electron(<\/string>)/, '$1Motor Setup Tool$2');
  info = info.replace(/(<key>CFBundleName<\/key>\s*<string>)Electron(<\/string>)/, '$1Motor Setup Tool$2');
  info = info.replace(/(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]+(<\/string>)/, '$1com.motomind.MotorSetup$2');
  fs.writeFileSync(plist, info);
} else {
  fs.cpSync(runtime, output, { recursive: true, verbatimSymlinks: true });
  fs.renameSync(path.join(output, process.platform === 'win32' ? 'electron.exe' : 'electron'), path.join(output, binaryName));
}
if (process.platform === 'linux') {
  const rules = path.join(output, 'packaging', '99-motomind-gsusb.rules');
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.copyFileSync(path.join(root, 'packaging', '99-motomind-gsusb.rules'), rules);
}

fs.mkdirSync(path.join(app, 'electron'), { recursive: true });
for (const name of ['main.js', 'preload.js', 'backend.js', 'updater.js', 'renderer.js', 'index.html', 'styles.css']) {
  fs.copyFileSync(path.join(__dirname, name), path.join(app, 'electron', name));
}
const pkg = require('./package.json');
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: 'electron/main.js' }, null, 2));
for (const relative of ['motomind-logo.svg', 'motor-setup-tool.svg', 'icons/256.png', 'fonts/Pretendard-Regular.otf', 'fonts/Pretendard-Bold.otf', 'fonts/MotomindNumbers-Bold.otf', 'fonts/OFL.txt', 'README.md']) {
  const target = path.join(app, 'assets', relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, 'assets', relative), target);
}
fs.mkdirSync(path.join(backend, 'lib'), { recursive: true });
fs.copyFileSync(sourceBinary, path.join(backend, binaryName));
if (process.platform !== 'win32') fs.chmodSync(path.join(backend, binaryName), 0o755);
fs.copyFileSync(mujoco, path.join(backend, 'lib', mujocoName));
fs.copyFileSync(path.join(root, 'vendor', 'gs_usb', 'LICENSE'), path.join(backend, 'gs_usb-LICENSE'));
fs.cpSync(path.join(root, 'packaging', 'licenses'), path.join(backend, 'licenses'), { recursive: true });
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES']) {
  const source = path.join(sdkDir, '..', name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(backend, name));
}
const libraryKey = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : process.platform === 'win32' ? 'PATH' : 'LD_LIBRARY_PATH';
const smokeEnv = { ...process.env, [libraryKey]: [path.join(backend, 'lib'), process.env[libraryKey]].filter(Boolean).join(path.delimiter) };
const selfCheck = JSON.parse(execFileSync(path.join(backend, binaryName), ['--self-check'], { env: smokeEnv, encoding: 'utf8', timeout: 30_000 }));
if (selfCheck.version !== pkg.version || selfCheck.mujoco !== '3.12.0') {
  throw new Error('Packaged backend self-check returned an unexpected version');
}
if (process.platform === 'darwin') execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', bundle]);

console.log(`Built ${output}`);
