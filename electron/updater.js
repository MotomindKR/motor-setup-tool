'use strict';

const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const releaseApi = 'https://api.github.com/repos/MotomindKR/motor-setup-tool/releases/latest';
const releasePrefix = 'https://github.com/MotomindKR/motor-setup-tool/releases/download/';
const versionParts = version => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);

function isNewer(remote, local) {
  const a = versionParts(remote), b = versionParts(local);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

async function installerExtension() {
  if (process.platform === 'darwin') return 'dmg';
  if (process.platform === 'win32') return 'exe';
  if (process.platform !== 'linux') return null;
  const info = await fs.readFile('/etc/os-release', 'utf8').catch(() => '');
  return /^(ID|ID_LIKE)=.*\b(fedora|rhel|centos|suse|rocky|almalinux)\b/m.test(info) ? 'rpm' : 'deb';
}

async function installerName(version) {
  const extension = await installerExtension();
  return extension ? `motor-setup-tool-${version}-${process.platform}-${process.arch}.${extension}` : null;
}

async function get(url, limit) {
  const response = await fetch(url, { headers: { 'User-Agent': 'motomind-motor-setup-tool', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    if (response.status === 404 && url === releaseApi) throw new Error('No public GitHub release is available yet');
    throw new Error(`GitHub request failed (${response.status})`);
  }
  const content = await response.text();
  if (Buffer.byteLength(content) > limit) throw new Error('GitHub response is too large');
  return content;
}

async function check(currentVersion) {
  const release = JSON.parse(await get(releaseApi, 2_000_000));
  const version = release.tag_name?.replace(/^v/, '');
  if (!versionParts(version)) throw new Error('GitHub release has an invalid version');
  const available = isNewer(version, currentVersion);
  const filename = await installerName(version);
  const installer = release.assets?.find(asset => asset.name === filename);
  const checksum = release.assets?.find(asset => asset.name === 'SHA256SUMS');
  const validAsset = asset => asset && typeof asset.browser_download_url === 'string' && asset.browser_download_url.startsWith(releasePrefix);
  return {
    available, version, filename,
    installable: Boolean(available && filename && validAsset(installer) && validAsset(checksum)),
    installerUrl: validAsset(installer) ? installer.browser_download_url : null,
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

async function install(app, release, progress, installFile) {
  if (!release?.installable || !release.filename) throw new Error('Check for an available installer first');
  const checksumText = await get(release.checksumUrl, 64_000);
  const checksums = new Map(checksumText.trim().split(/\r?\n/).map(line => {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/i.exec(line);
    if (!match) throw new Error('Release checksum list is invalid');
    return [match[2], match[1].toLowerCase()];
  }));
  const expected = checksums.get(release.filename);
  if (!expected) throw new Error('Release installer checksum is missing');
  const downloads = path.join(app.getPath('userData'), 'installers');
  const destination = path.join(downloads, release.filename);
  await fs.mkdir(downloads, { recursive: true });
  await fs.rm(destination, { force: true });
  try {
    progress('Downloading installer…');
    await download(release.installerUrl, destination, expected, progress);
  } catch (error) {
    await fs.rm(destination, { force: true });
    throw error;
  }
  progress('Installing verified update…');
  await installFile(destination);
}

module.exports = { check, install, installerName, isNewer };
