'use strict';

const fs = require('node:fs');
const path = require('node:path');
const png2icons = require('png2icons');

const icons = path.resolve(__dirname, '..', 'assets', 'icons');
const image = fs.readFileSync(path.join(icons, '512.png'));
const formats = [
  ['motor-setup-tool.icns', png2icons.createICNS(image, png2icons.BICUBIC, 0)],
  ['motor-setup-tool.ico', png2icons.createICO(image, png2icons.BICUBIC2, 0, false, true)],
];
for (const [name, contents] of formats) {
  if (!contents) throw new Error(`Could not generate ${name}`);
  fs.writeFileSync(path.join(icons, name), contents);
}
