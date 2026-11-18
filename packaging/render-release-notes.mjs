import { readFileSync } from 'node:fs';

const [repo, tag, notesFile, checksumsFile] = process.argv.slice(2);
if (!repo || !tag || !notesFile || !checksumsFile) {
  throw new Error('Usage: node packaging/render-release-notes.mjs OWNER/REPO TAG NOTES_FILE SHA256SUMS');
}

const version = tag.slice(1);
const base = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`;
const checksums = readFileSync(checksumsFile, 'utf8');
const assets = new Set(Array.from(checksums.matchAll(/^[a-f0-9]{64} [ *]([^\r\n]+)$/gm), match => match[1]));

function installer(platform, extension, label) {
  const file = `motor-setup-tool-${version}-${platform}.${extension}`;
  if (!assets.has(file)) throw new Error(`Missing release installer: ${file}`);
  return `[${label}](${base}/${file})`;
}

const notes = readFileSync(notesFile, 'utf8').trim();
const title = `# Motor Setup Tool ${tag}`;
const changes = notes.split(/\r?\n/, 1)[0] === title ? notes.slice(title.length).trimStart() : notes;

process.stdout.write(`## Downloads

Choose one installer for your system and CPU.

| System | Intel or AMD (x64) | ARM64 |
| --- | --- | --- |
| Windows | ${installer('win32-x64', 'exe', 'Download EXE')} | — |
| macOS | — | ${installer('darwin-arm64', 'dmg', 'Download DMG (Apple silicon)')} |
| Ubuntu, Debian, Mint | ${installer('linux-x64', 'deb', 'Download DEB')} | ${installer('linux-arm64', 'deb', 'Download DEB')} |
| Fedora, RHEL, openSUSE | ${installer('linux-x64', 'rpm', 'Download RPM')} | ${installer('linux-arm64', 'rpm', 'Download RPM')} |

On Linux, run \`uname -m\` to check your CPU. \`x86_64\` means x64 and \`aarch64\` means ARM64.

[SHA256 checksums](${base}/SHA256SUMS) are available for verification. The macOS ZIP, update manifests, and blockmaps are used by the in-app updater.

## Changes

${changes}
`);
