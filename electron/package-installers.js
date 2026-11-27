'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = require('./package.json');
const { installRuntimeDependencies } = require('./runtime-dependencies');
const platform = process.platform;
const arch = process.arch;
if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error('Unsupported desktop platform');
const unpackedOnly = process.argv.includes('--dir');
if (!unpackedOnly && platform === 'darwin' && arch !== 'arm64') throw new Error('macOS releases require ARM64');
if (!unpackedOnly && platform === 'win32' && arch !== 'x64') throw new Error('Windows releases require x64');

const dist = path.join(root, 'dist-electron');
const platformArch = `${platform}-${arch}`;
const staging = path.join(dist, `stage-${platformArch}`);
const installers = path.join(dist, unpackedOnly ? `unpacked-${platformArch}` : 'installers');
const app = path.join(staging, 'app');
const backend = path.join(staging, 'backend');
const dxl = path.join(staging, 'dxl');
const backendName = platform === 'win32' ? 'motor-setup-tool.exe' : 'motor-setup-tool';
const dxlName = platform === 'win32' ? 'dxl-worker.exe' : 'dxl-worker';

fs.rmSync(staging, { recursive: true, force: true });
fs.rmSync(installers, { recursive: true, force: true });
const sourceBinary = process.env.MOTOMIND_BACKEND || path.join(root, 'target', 'release', backendName);
const sourceDxl = path.join(root, '.tools', 'dxl', 'dxl-worker');
const mujocoVersion = '3.17.0';
const sdkDir = process.env.MUJOCO_DYNAMIC_LINK_DIR || path.join(root, '.tools', 'mujoco', `mujoco-${mujocoVersion}`, 'lib');
const mujocoName = platform === 'darwin' ? `libmujoco.${mujocoVersion}.dylib` : platform === 'win32' ? 'mujoco.dll' : `libmujoco.so.${mujocoVersion}`;
const mujoco = process.platform === 'win32' ? path.join(path.dirname(sdkDir), 'bin', mujocoName) : path.join(sdkDir, mujocoName);
execFileSync(process.execPath, [path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js'), 'build'], { cwd: __dirname, stdio: 'inherit' });

for (const source of [sourceBinary, mujoco]) {
  if (!fs.existsSync(source)) throw new Error(`Missing ${source}. Build the release backend and install the pinned MuJoCo SDK first.`);
}
if (!fs.existsSync(path.join(sourceDxl, dxlName))) throw new Error('Build the DXL worker with python dxl/build.py before packaging.');

fs.mkdirSync(path.join(app, 'electron'), { recursive: true });
for (const name of ['main.js', 'i18n.js', 'preload.js', 'backend.js', 'dxl.js', 'worker-exit.js', 'register-catalog.json', 'motor-models.json', 'recordings.js', 'updater.js']) {
  fs.copyFileSync(path.join(__dirname, name), path.join(app, 'electron', name));
}
fs.cpSync(path.join(__dirname, 'locales'), path.join(app, 'electron', 'locales'), { recursive: true });
fs.cpSync(sourceDxl, dxl, { recursive: true, verbatimSymlinks: true });
fs.mkdirSync(path.join(app, 'src'), { recursive: true });
fs.copyFileSync(path.join(root, 'src', 'firmware_catalog.json'), path.join(app, 'src', 'firmware_catalog.json'));
fs.cpSync(path.join(__dirname, 'ui-dist'), path.join(app, 'electron', 'ui-dist'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'node_modules', '@motomindkr', 'ui', 'THIRD_PARTY_NOTICES.md'), path.join(app, 'electron', 'ui-dist', 'THIRD_PARTY_NOTICES.md'));
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: 'electron/main.js', desktopName: pkg.desktopName, description: pkg.description, author: pkg.author, homepage: pkg.homepage, dependencies: pkg.dependencies }, null, 2));
installRuntimeDependencies(app);
for (const relative of ['icons/256.png', 'icons/motor-setup-tool.ico', 'fonts/OFL.txt', 'milly/LICENSE', 'README.md']) {
  const target = path.join(app, 'assets', relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, 'assets', relative), target);
}
fs.mkdirSync(path.join(backend, 'lib'), { recursive: true });
fs.copyFileSync(sourceBinary, path.join(backend, backendName));
if (process.platform !== 'win32') fs.chmodSync(path.join(backend, backendName), 0o755);
fs.copyFileSync(mujoco, path.join(backend, 'lib', mujocoName));
fs.cpSync(path.join(root, 'packaging', 'licenses'), path.join(backend, 'licenses'), { recursive: true });
const sdkRoot = path.dirname(sdkDir);
const notices = platform === 'win32' ? 'THIRD_PARTY_NOTICES.txt' : 'THIRD_PARTY_NOTICES';
fs.copyFileSync(path.join(sdkRoot, 'LICENSE'), path.join(backend, 'LICENSE'));
fs.copyFileSync(path.join(sdkRoot, notices), path.join(backend, 'THIRD_PARTY_NOTICES'));

const config = structuredClone(require('./builder.json'));
config.directories.app = app;
config.directories.output = installers;
config.extraResources = [{ from: backend, to: 'backend' }, { from: dxl, to: 'dxl' }];
if (platform === 'darwin') {
  config.mac.binaries.push(`Contents/Resources/backend/lib/${mujocoName}`, `Contents/Resources/dxl/${dxlName}`);
}
config.electronVersion = require('electron/package.json').version;
if (platform === 'linux') {
  // FPM expands ${arch} as amd64/x86_64/aarch64 depending on package format.
  // Set the public architecture once so metadata and existing clients agree.
  config.linux.artifactName = config.linux.artifactName.replace('${arch}', arch);
  // Append the udev reload to builder's own desktop and sandbox hooks.
  const packageOptions = { fpm: [path.join(root, 'packaging', '70-motomind-gsusb.rules') + '=/usr/lib/udev/rules.d/70-motomind-gsusb.rules'] };
  const templates = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates', 'linux');
  for (const [option, name] of [['afterInstall', 'after-install'], ['afterRemove', 'after-remove']]) {
    const script = path.join(staging, `linux-${name}.sh`);
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
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    if (!process.env[name]) throw new Error(`macOS release auto-updates require Developer ID signing and notarization. Missing ${name}; see packaging/README.md.`);
  }
  config.forceCodeSigning = true;
  config.mac.notarize = true;
} else if (platform === 'darwin' && !buildEnv.CSC_LINK && !buildEnv.CSC_NAME) {
  config.mac.identity = '-';
  config.mac.notarize = false;
  config.extraMetadata = { disableUpdates: true };
  // Ad-hoc test signatures have no Team ID for hardened library validation.
  // Signed production builds keep the hardened runtime enabled.
  config.mac.hardenedRuntime = false;
}
const configFile = path.join(staging, 'builder.json');
fs.writeFileSync(configFile, JSON.stringify(config));
const targets = unpackedOnly ? ['--dir'] : [];
execFileSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--config', configFile, ...targets, `--${arch}`, '--publish', 'never'], { cwd: __dirname, env: buildEnv, stdio: 'inherit' });

const platformName = { darwin: 'mac', win32: 'win', linux: 'linux' }[platform];
const unpacked = path.join(installers, platformName + (arch === 'x64' ? '' : `-${arch}`) + (platform === 'darwin' ? '' : '-unpacked'));
const bundle = path.join(unpacked, config.productName + '.app');
const resources = platform === 'darwin' ? path.join(bundle, 'Contents', 'Resources') : path.join(unpacked, 'resources');
const executable = path.join(resources, 'backend', backendName);
const library = path.join(resources, 'backend', 'lib');
const runtimeEnv = { ...process.env };
if (platform === 'darwin') {
  delete runtimeEnv.DYLD_LIBRARY_PATH;
  if (config.mac.notarize) execFileSync('xcrun', ['stapler', 'validate', bundle], { stdio: 'inherit' });
  for (const binary of [bundle, executable, path.join(library, mujocoName), path.join(resources, 'dxl', dxlName)]) {
    execFileSync('codesign', ['--verify', '--strict', binary]);
  }
} else if (platform === 'win32') {
  runtimeEnv.PATH = library + path.delimiter + process.env.PATH;
  fs.accessSync(path.join(unpacked, config.productName + '.exe'));
} else {
  delete runtimeEnv.LD_LIBRARY_PATH;
}
const result = JSON.parse(execFileSync(executable, ['self-check'], { env: runtimeEnv, encoding: 'utf8', timeout: 30_000 }));
if (result.version !== pkg.version || result.mujoco !== mujocoVersion) throw new Error('Packaged backend self-check failed');
const requests = [
  { operation: 'ports', params: {} },
  { operation: 'connect', params: { demo: true, port: '', baud: 1_000_000 } },
];
const replies = execFileSync(path.join(resources, 'dxl', dxlName), [os.tmpdir()], {
  input: requests.map(request => JSON.stringify(request)).join('\n') + '\n',
  encoding: 'utf8', timeout: 30_000,
}).trim().split('\n').map(line => JSON.parse(line));
const discovered = replies[1]?.result;
if (!Array.isArray(replies[0]?.result?.ports) || !discovered?.motors?.length ||
    !discovered.motors.every(motor => motor.baud_rate === discovered.baud && Number.isInteger(motor.position))) {
  throw new Error('Packaged DXL worker self-check failed');
}

if (unpackedOnly) {
  if (platform === 'linux') {
    const rules = '70-motomind-gsusb.rules';
    fs.mkdirSync(path.join(unpacked, 'packaging'), { recursive: true });
    fs.copyFileSync(path.join(root, 'packaging', rules), path.join(unpacked, 'packaging', rules));
  }
  const destination = path.join(dist, `motor-setup-tool-electron-${platformArch}`);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(unpacked, destination);
  console.log(`Built ${destination}`);
} else {
  const metadata = platform === 'darwin' ? 'latest-mac.yml' : platform === 'win32' ? 'latest.yml' : `latest-linux${arch === 'x64' ? '' : `-${arch}`}.yml`;
  const assets = require('./update-metadata').verifyMetadata(installers, [metadata], pkg.version);
  for (const name of assets) {
    const destination = path.join(dist, name);
    fs.renameSync(path.join(installers, name), destination);
    const digest = crypto.hash('sha256', fs.readFileSync(destination), 'hex');
    fs.writeFileSync(`${destination}.sha256`, `${digest}  ${name}\n`);
    const blockmap = name + '.blockmap';
    if (fs.existsSync(path.join(installers, blockmap))) {
      fs.copyFileSync(path.join(installers, blockmap), path.join(dist, blockmap));
    } else {
      fs.rmSync(path.join(dist, blockmap), { force: true });
    }
    console.log(`Release installer ${destination}`);
  }
  fs.copyFileSync(path.join(installers, metadata), path.join(dist, metadata));
}
