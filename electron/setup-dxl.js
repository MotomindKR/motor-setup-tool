'use strict';

const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { developmentPython } = require('./dxl');

const root = path.resolve(__dirname, '..');
const python = developmentPython(root);
const options = { stdio: 'inherit' };

if (process.env.MOTOMIND_DXL_PYTHON) {
  execFileSync(python, ['-c', 'from serial.tools import list_ports; import dynamixel_sdk'], options);
} else {
  const pip = path.join(path.dirname(python), process.platform === 'win32' ? 'pip.exe' : 'pip');
  if (!existsSync(python) || !existsSync(pip)) {
    execFileSync(process.platform === 'win32' ? 'python' : 'python3',
      ['-m', 'venv', path.join(root, '.tools', 'dxl-venv')], options);
  }
  execFileSync(python, ['-m', 'pip', '--disable-pip-version-check', 'install', '-q',
    '-r', path.join(root, 'dxl', 'requirements.txt')], options);
}
