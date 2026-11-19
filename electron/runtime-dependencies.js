'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function installRuntimeDependencies(app) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'motor-runtime-'));
  try {
    for (const name of ['package.json', 'package-lock.json']) {
      fs.copyFileSync(path.join(__dirname, name), path.join(staging, name));
    }
    execFileSync(process.execPath, [process.env.npm_execpath, 'ci', '--omit=dev', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'], {
      cwd: staging, stdio: 'inherit',
    });
    fs.cpSync(path.join(staging, 'node_modules'), path.join(app, 'node_modules'), {
      recursive: true, verbatimSymlinks: true,
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (require.main === module) installRuntimeDependencies(process.argv[2]);

module.exports = { installRuntimeDependencies };
