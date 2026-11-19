'use strict';

const { i18n, t } = require('./i18n.js');

const { execFile, spawn } = require('node:child_process');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { promisify } = require('node:util');

const operations = new Set([
  'ports', 'connect', 'disconnect', 'scan', 'poll',
  'torqueOff', 'saveZero', 'direction', 'setMode5', 'set1Mbps', 'setId', 'export', 'restore',
]);

class DxlWorker {
  constructor({ root, resourcesPath, backupDir }) {
    const windows = process.platform === 'win32';
    const name = windows ? 'dxl-worker.exe' : 'dxl-worker';
    const python = process.env.MOTOMIND_DXL_PYTHON || (windows ? 'python' : 'python3');
    const entry = path.join(root, 'dxl', 'dxl_settings', 'worker.py');
    this.command = resourcesPath ? path.join(resourcesPath, 'dxl', name) : python;
    this.args = resourcesPath ? [backupDir] : [entry, backupDir];
    this.env = resourcesPath ? process.env : { ...process.env, PYTHONPATH: path.join(root, 'dxl') };
    this.pending = [];
    this.child = null;
    this.closing = false;
  }

  get active() {
    return this.pending.length > 0;
  }

  start() {
    const child = spawn(this.command, this.args, {
      env: this.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    let failure;
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => { failure = error; });
    child.stdin.on('error', error => { failure ||= error; });
    const output = createInterface({ input: child.stdout });
    output.on('line', line => {
      const request = this.pending[0];
      if (!request) return;
      try {
        if (failure) return;
        const reply = JSON.parse(line);
        if (typeof reply?.connected !== 'boolean' || typeof reply.faulted !== 'boolean') {
          throw new Error(t("Invalid DXL worker response"));
        }
        this.pending.shift();
        request.resolve(reply);
      } catch (error) {
        failure = error;
        // Let the current transaction finish and close on EOF.
        this.close();
      }
    });
    this.exited = new Promise(resolve => {
      child.once('close', code => {
        output.close();
        this.child = null;
        this.closing = false;
        const message = stderr.trim() || failure?.message || t("DXL worker exited ({{code}})", { code });
        for (const request of this.pending.splice(0)) {
          request.resolve({ connected: false, faulted: false, error: message });
        }
        resolve();
      });
    });
  }

  async run(operation, params = {}) {
    if (!operations.has(operation)) throw new Error(t("Unknown DXL operation"));
    if (this.closing) throw new Error(t("DXL worker is closing"));
    // A foreground operation can queue behind one status read.
    if (this.active && (operation === 'poll' || this.pending.length >= 2 || this.pending[0].operation !== 'poll')) {
      throw new Error(t("Wait for the current DXL operation"));
    }
    const line = JSON.stringify({ operation, params, language: i18n.language }) + '\n';
    if (!this.child) this.start();
    return new Promise(resolve => {
      this.pending.push({ operation, resolve });
      this.child.stdin.write(line);
    });
  }

  close() {
    if (!this.child) return Promise.resolve();
    if (!this.closing) {
      this.closing = true;
      this.child.stdin.end();
    }
    return this.exited;
  }
}

async function grantPortAccess(port) {
  if (process.platform !== 'linux') throw new Error(t("Port authorization is available on Linux"));
  if (typeof port !== 'string' || !/^\/dev\/tty(?:ACM|USB)[0-9]+$/.test(port)) {
    throw new Error(t("Choose a /dev/ttyACM or /dev/ttyUSB port"));
  }
  const device = await fs.lstat(port).catch(() => null);
  if (!device?.isCharacterDevice()) throw new Error(t("Connect the adapter and confirm that {{port}} exists", { port }));
  const flags = constants.R_OK | constants.W_OK;
  try {
    await fs.access(port, flags);
    return;
  } catch (error) {
    if (error.code !== 'EACCES') throw error;
  }
  const pkexec = '/usr/bin/pkexec';
  const setfacl = '/usr/bin/setfacl';
  try {
    await Promise.all([fs.access(pkexec, constants.X_OK), fs.access(setfacl, constants.X_OK)]);
  } catch {
    throw new Error(t("Install the acl and polkit packages to request serial port access"));
  }
  try {
    await promisify(execFile)(pkexec, ['--disable-internal-agent', setfacl, '-m',
      `u:${process.getuid()}:rw`, '--', port], { timeout: 120_000 });
  } catch (error) {
    if (error.code === 126) throw new Error(t("Administrator authorization was cancelled"));
    throw new Error(t("Could not authorize {{port}}. {{error}}", { port, error: error.stderr?.trim() || t("Check the desktop authentication agent.") }));
  }
  await fs.access(port, flags);
}

module.exports = { DxlWorker, grantPortAccess };
