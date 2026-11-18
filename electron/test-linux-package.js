'use strict';
// Inspect the real DEB/RPM payloads and lifecycle scripts on a Linux builder.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const [deb, rpm] = process.argv.slice(2);
const rule = '/usr/lib/udev/rules.d/70-motomind-gsusb.rules';
const bytes = fs.readFileSync(path.join(__dirname, '..', 'packaging', path.basename(rule)));
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 4_000_000 });
const listing = run('dpkg-deb', ['--contents', deb]);
assert.match(listing.split('\n').find(line => line.endsWith(`.${rule}`)) || '', /^-rw-r--r--\s+(root\/root|0\/0)\s/);
const controls = fs.mkdtempSync(path.join(os.tmpdir(), 'motor-deb-controls-'));
try {
  run('dpkg-deb', ['--control', deb, controls]);
  for (const name of ['postinst', 'postrm']) {
    const script = fs.readFileSync(path.join(controls, name), 'utf8');
    assert.match(script, /udevadm control --reload-rules/);
    assert.match(script, /update-alternatives/);
    assert.match(script, /apparmor/);
  }
} finally { fs.rmSync(controls, { recursive: true, force: true }); }
const files = run('rpm', ['-qp', '--qf', '[%{FILENAMES}\t%{FILEMODES:octal}\n]', rpm]);
const entry = files.split('\n').map(line => line.split('\t')).find(([name]) => name === rule);
assert.ok(entry, 'RPM must own the USB permission rule');
const payload = execFileSync('bash', ['-o', 'pipefail', '-c', 'rpm2cpio "$1" | cpio --quiet -i --to-stdout "./usr/lib/udev/rules.d/70-motomind-gsusb.rules" "usr/lib/udev/rules.d/70-motomind-gsusb.rules"', 'rpm-rule', rpm]);
assert.deepEqual(payload, bytes, 'RPM rule bytes must match the source rule');
assert.equal(Number.parseInt(entry[1], 8) & 0o777, 0o644);
assert.equal(run('rpm', ['-qp', '--scripts', rpm]).match(/udevadm control --reload-rules/g)?.length, 2);
console.log('DEB/RPM own the USB rule and preserve desktop hooks with udev reloads.');
