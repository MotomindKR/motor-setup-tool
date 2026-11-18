'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const yaml = require('js-yaml');

function verifyMetadata(directory, names, version) {
  for (const name of names) {
    const info = yaml.load(fs.readFileSync(path.join(directory, name), 'utf8'));
    if (info.version !== version || !Array.isArray(info.files) || !info.files.length) throw new Error(`Invalid update metadata: ${name}`);
    for (const file of info.files) {
      if (!/^[A-Za-z0-9._-]+$/.test(file.url) || !file.url.includes(version)) throw new Error(`Invalid update asset: ${file.url}`);
      const bytes = fs.readFileSync(path.join(directory, file.url));
      if (file.size !== bytes.length || file.sha512 !== createHash('sha512').update(bytes).digest('base64')) throw new Error(`Update metadata does not match ${file.url}`);
    }
  }
}

if (require.main === module) {
  const directory = path.resolve(process.argv[2]);
  const names = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml'];
  verifyMetadata(directory, names, require('./package.json').version);
  console.log('Verified all updater manifests against their release payloads.');
}
module.exports = { verifyMetadata };
