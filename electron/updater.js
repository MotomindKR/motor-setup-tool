'use strict';

const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const exec = promisify(execFile);
const releaseApi = 'https://api.github.com/repos/MotomindKR/motor-setup-tool/releases/latest';
const releasePrefix = 'https://github.com/MotomindKR/motor-setup-tool/releases/download/';
const archiveName = () => `motor-setup-tool-electron-${process.platform}-${process.arch}.tar.gz`;
const versionParts = version => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);

function isNewer(remote, local) {
  const a = versionParts(remote), b = versionParts(local);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

function executable(root) {
  if (process.platform === 'darwin') return path.join(root, 'Motor Setup Tool.app', 'Contents', 'MacOS', 'Motor Setup Tool');
  return path.join(root, process.platform === 'win32' ? 'motor-setup-tool.exe' : 'motor-setup-tool');
}

async function get(url, limit) {
  const response = await fetch(url, { headers: { 'User-Agent': 'motomind-motor-setup-tool', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    if (response.status === 404 && url === releaseApi) throw new Error('No public GitHub release is available yet');
    throw new Error(`GitHub request failed (${response.status})`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > limit) throw new Error('GitHub response is too large');
  return text;
}

async function check(currentVersion) {
  const release = JSON.parse(await get(releaseApi, 2_000_000));
  const version = release.tag_name?.replace(/^v/, '');
  if (!versionParts(version)) throw new Error('GitHub release has an invalid version');
  const available = isNewer(version, currentVersion);
  const archive = release.assets?.find(asset => asset.name === archiveName());
  const checksum = release.assets?.find(asset => asset.name === `${archiveName()}.sha256`);
  const validAsset = asset => asset && typeof asset.browser_download_url === 'string' && asset.browser_download_url.startsWith(releasePrefix);
  return {
    available, version, installable: Boolean(available && validAsset(archive) && validAsset(checksum)),
    archiveUrl: validAsset(archive) ? archive.browser_download_url : null,
    checksumUrl: validAsset(checksum) ? checksum.browser_download_url : null,
  };
}

async function download(url, destination, expected, progress) {
  const response = await fetch(url, { headers: { 'User-Agent': 'motomind-motor-setup-tool' }, signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Update download failed (${response.status})`);
  const hash = createHash('sha256');
  let size = 0, lastProgress = 0;
  const total = Number(response.headers.get('content-length')) || 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > 1_000_000_000) return callback(new Error('Update is too large'));
      hash.update(chunk);
      if (total && Date.now() - lastProgress > 500) {
        lastProgress = Date.now();
        progress(`Downloading update · ${Math.min(100, Math.round(size / total * 100))}%`);
      }
      callback(null, chunk);
    },
  }), createWriteStream(destination, { flags: 'wx' }));
  if (hash.digest('hex') !== expected) throw new Error('Update checksum does not match the release');
}

async function install(app, release, progress) {
  if (!release?.installable) throw new Error('Check for an available Electron update first');
  const checksumText = await get(release.checksumUrl, 4096);
  const checksumFields = checksumText.trim().split(/\s+/);
  if (checksumFields.length !== 2 || !/^[a-f0-9]{64}$/i.test(checksumFields[0]) || checksumFields[1] !== archiveName()) {
    throw new Error('Release checksum is missing or invalid');
  }
  const checksum = checksumFields[0];
  const parent = path.join(app.getPath('userData'), 'installed');
  const destination = path.join(parent, release.version);
  const staged = path.join(parent, `.staging-${process.pid}-${Date.now()}`);
  const archive = path.join(parent, `.download-${process.pid}.tar.gz`);
  await fs.mkdir(parent, { recursive: true });
  try {
    progress('Downloading update…');
    await download(release.archiveUrl, archive, checksum.toLowerCase(), progress);
    progress('Installing update…');
    const { stdout } = await exec('tar', ['-tzf', archive], { maxBuffer: 8_000_000 });
    for (const name of stdout.split(/\r?\n/).filter(Boolean)) {
      const parts = name.replace(/\/$/, '').split('/');
      if (path.isAbsolute(name) || parts.includes('..') || name.includes('\\')) throw new Error('Update archive contains an invalid path');
    }
    await fs.mkdir(staged);
    await exec('tar', ['-xzf', archive, '-C', staged]);
    await fs.access(executable(staged));
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(staged, destination);
    await fs.writeFile(path.join(parent, 'latest.json'), JSON.stringify({ version: release.version }));
    progress('Update installed. Restarting…');
    launch(executable(destination));
    return true;
  } finally {
    await fs.rm(archive, { force: true });
    await fs.rm(staged, { recursive: true, force: true });
  }
}

function launch(binary) {
  const child = spawn(binary, [], { detached: true, stdio: 'ignore', cwd: path.dirname(binary) });
  child.unref();
}

async function launchInstalledIfNewer(app) {
  try {
    const parent = path.join(app.getPath('userData'), 'installed');
    const { version } = JSON.parse(await fs.readFile(path.join(parent, 'latest.json'), 'utf8'));
    if (!versionParts(version) || !isNewer(version, app.getVersion())) return false;
    const binary = executable(path.join(parent, version));
    await fs.access(binary);
    launch(binary);
    return true;
  } catch { return false; }
}

module.exports = { check, install, isNewer, launchInstalledIfNewer };
