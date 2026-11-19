'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const yaml = require('js-yaml');

function verifyMetadata(directory, names, version) {
  const assets = new Set();
  for (const name of names) {
    const info = yaml.load(fs.readFileSync(path.join(directory, name), 'utf8'));
    if (info.version !== version || !Array.isArray(info.files) || !info.files.length) throw new Error(`Invalid update metadata: ${name}`);
    if (name === 'latest-mac.yml' && !info.files.some(file => file.url?.endsWith('.zip'))) throw new Error('The macOS updater requires a ZIP in its manifest');
    for (const file of info.files) {
      if (!/^[A-Za-z0-9._-]+$/.test(file.url) || !file.url.includes(version)) throw new Error(`Invalid update asset: ${file.url}`);
      const bytes = fs.readFileSync(path.join(directory, file.url));
      if (file.size !== bytes.length || file.sha512 !== createHash('sha512').update(bytes).digest('base64')) throw new Error(`Update metadata does not match ${file.url}`);
      assets.add(file.url);
    }
  }
  return assets;
}

if (require.main === module) {
  const directory = path.resolve(process.argv[2]);
  const names = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml'];
  const assets = verifyMetadata(directory, names, require('./package.json').version);
  for (const name of names) console.log(name);
  for (const name of assets) {
    console.log(name);
    if (fs.existsSync(path.join(directory, name + '.blockmap'))) console.log(name + '.blockmap');
  }
}
module.exports = { verifyMetadata };
