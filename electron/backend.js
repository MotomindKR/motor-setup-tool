'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function integer(value, name, min = 1, max = 254) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be ${min}–${max}`);
  return String(n);
}

function number(value, name, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be ${min}–${max}`);
  return String(n);
}

function validCan(value) {
  if (typeof value !== 'string') return false;
  if (/^[a-zA-Z0-9_.-]{1,15}$/.test(value)) return true;
  if (/^gsusb:(?:[0-9a-f]{2}){1,256}:(?:[1-9]|[1-9][0-9]{1,2})$/.test(value)) {
    return Number(value.slice(value.lastIndexOf(':') + 1)) <= 255;
  }
  const match = /^slcan:(lawicel|canable):(115200|460800|921600|1000000|2000000):(.{1,256})$/.exec(value);
  if (!match) return false;
  return process.platform === 'win32'
    ? /^COM[1-9][0-9]*$/i.test(match[3])
    : /^\/dev\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(match[3]);
}

function target(params) {
  const can = params.can;
  if (!validCan(can)) {
    throw new Error('Select a valid CAN interface');
  }
  return ['--can', can, '--host-id', integer(params.hostId ?? 253, 'Host ID'), '--id', integer(params.id, 'Motor ID')];
}

function registerIndex(value, writable = false) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0x2011 || index > (writable ? 0x2017 : 0x2019)) {
    throw new Error('Select a documented persistent register');
  }
  return `0x${index.toString(16)}`;
}

function argsFor(operation, params = {}) {
  switch (operation) {
    case 'interfaces': return ['can', 'list'];
    case 'serialPorts': return ['can', 'serial-list'];
    case 'usbAdapters': return ['can', 'usb-list'];
    case 'canUp': {
      const can = params.can;
      if (typeof can !== 'string' || !/^[a-zA-Z0-9_.-]{1,15}$/.test(can)) throw new Error('Select a valid SocketCAN interface');
      return ['can', 'up', can, '--auth', 'polkit'];
    }
    case 'canRestart': {
      const can = params.can;
      if (typeof can !== 'string' || !/^[a-zA-Z0-9_.-]{1,15}$/.test(can)) throw new Error('Select a valid SocketCAN interface');
      return ['can', 'restart', can, '--auth', 'polkit'];
    }
    case 'scan': {
      target({ ...params, id: 1 });
      return ['scan', '--can', params.can, '--host-id', integer(params.hostId ?? 253, 'Host ID')];
    }
    case 'info': return ['info', ...target(params)];
    case 'plan': {
      if (!/^RS-0[0-6]$/.test(params.model)) throw new Error('Unknown motor model');
      return ['plan', '--model', params.model];
    }
    case 'calibrate': {
      if (params.reviewed !== true) throw new Error('Review the motor limits and secure the motor first');
      if (!params.config || typeof params.config !== 'object') throw new Error('Calibration configuration missing');
      if (params.output != null && (typeof params.output !== 'string' || !path.isAbsolute(params.output))) throw new Error('Select a valid calibration folder');
      return ['calibrate', ...target(params), ...(params.output ? ['--output', params.output] : []), '--config-stdin', '--yes'];
    }
    case 'analyze': {
      if (typeof params.directory !== 'string' || !path.isAbsolute(params.directory)) throw new Error('Select a saved run');
      return ['analyze', params.directory];
    }
    case 'monitor': return ['monitor', ...target(params)];
    case 'manual': {
      if (!params.config || typeof params.config !== 'object') throw new Error('Manual configuration missing');
      return ['manual-session', ...target(params)];
    }
    case 'jog': {
      if (params.confirmed !== true) throw new Error('Confirm the jog conditions first');
      const speed = number(params.speed, 'Jog speed', -100, 100);
      if (Number(speed) === 0) throw new Error('Jog speed must be nonzero');
      return ['jog', ...target(params), '--speed', speed, '--seconds', number(params.seconds ?? 2, 'Jog duration', 0.05, 5), '--yes'];
    }
    case 'stop': return ['stop', ...target(params)];
    case 'zero': {
      if (params.confirmed !== true) throw new Error('Confirm the stationary motor first');
      return ['zero', ...target(params), '--yes'];
    }
    case 'setId': {
      if (params.confirmed !== true) throw new Error('Confirm the ID change first');
      return ['set-id', ...target(params), '--new-id', integer(params.newId, 'New motor ID'), '--yes'];
    }
    case 'firmwareCheck': return ['firmware', 'check', ...target(params)];
    case 'firmwarePrepare': return ['firmware', 'prepare', ...target(params)];
    case 'firmwareUpdate': {
      if (params.confirmed !== true) throw new Error('Confirm firmware update and stable power first');
      return ['firmware', 'update', ...target(params), '--yes'];
    }
    case 'registerList': return ['register', 'list'];
    case 'registerRead': return ['register', 'read', ...target(params), '--index', registerIndex(params.index)];
    case 'registerWrite': {
      if (params.confirmed !== true) throw new Error('Confirm the persistent register change first');
      const index = registerIndex(params.index, true);
      const value = number(params.value, 'Register value', 0, 200);
      if (typeof params.uuid !== 'string' || !/^[a-fA-F0-9]{16}$/.test(params.uuid)) throw new Error('Read the motor identity again');
      if (typeof params.expectedRaw !== 'string' || !/^[a-fA-F0-9]{8}$/.test(params.expectedRaw)) throw new Error('Read the register again');
      return ['register', 'write', ...target(params), '--index', index, '--value', value, '--uuid', params.uuid, '--expected-raw', params.expectedRaw, '--yes'];
    }
    default: throw new Error('Unknown operation');
  }
}

function backendPath(root, resourcesPath = null) {
  const binary = process.platform === 'win32' ? 'motor-setup-tool.exe' : 'motor-setup-tool';
  if (resourcesPath) {
    const bundled = path.join(resourcesPath, 'backend', binary);
    if (fs.existsSync(bundled)) return bundled;
  }
  if (process.env.MOTOMIND_BACKEND) {
    if (fs.existsSync(process.env.MOTOMIND_BACKEND)) return path.resolve(process.env.MOTOMIND_BACKEND);
    throw new Error(`Rust backend missing: ${process.env.MOTOMIND_BACKEND}`);
  }
  for (const candidate of [path.join(root, 'target', 'release', binary), path.join(root, 'target', 'debug', binary)]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Rust backend missing. Build it with cargo build --release.');
}

class Backend {
  constructor(binary, emit) {
    this.binary = binary;
    this.emit = emit;
    this.active = null;
    const bundledLib = path.join(path.dirname(binary), 'lib');
    const developmentLib = path.join(path.resolve(__dirname, '..'), '.tools', 'mujoco', 'mujoco-3.12.0', process.platform === 'win32' ? 'bin' : 'lib');
    this.environment = { ...process.env };
    const configuredLib = process.env.MUJOCO_DYNAMIC_LINK_DIR;
    const configuredRuntime = configuredLib && process.platform === 'win32' ? path.join(path.dirname(configuredLib), 'bin') : configuredLib;
    const libraryDir = fs.existsSync(bundledLib) ? bundledLib : configuredRuntime || (fs.existsSync(developmentLib) ? developmentLib : null);
    if (libraryDir) {
      const key = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : process.platform === 'win32' ? 'PATH' : 'LD_LIBRARY_PATH';
      this.environment[key] = [libraryDir, process.env[key]].filter(Boolean).join(path.delimiter);
    }
  }

  run(operation, params = {}) {
    if (this.active) throw new Error('Finish or stop the current operation first');
    const args = argsFor(operation, params);
    const input = operation === 'calibrate' || operation === 'manual' ? JSON.stringify(params.config) : null;
    if (input && input.length > 10_000) throw new Error('Configuration is too large');
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], shell: false, env: this.environment });
      const job = { child, operation, transferStarted: false, cancelRequested: false };
      this.active = job;
      this.emit({ type: 'start', operation });
      if (input) {
        child.stdin.on('error', () => {});
        child.stdin.write(`${input}\n`);
        if (operation === 'calibrate') child.stdin.end();
      }
      let stdout = '';
      let stderr = '';
      let lines = '';
      let settled = false;
      child.stdout.on('data', chunk => {
        const text = chunk.toString();
        if (operation === 'monitor' || operation === 'jog' || operation === 'manual') {
          lines += text;
          let index;
          while ((index = lines.indexOf('\n')) >= 0) {
            const line = lines.slice(0, index);
            lines = lines.slice(index + 1);
            try { this.emit({ type: operation === 'manual' ? 'manualStatus' : 'feedback', value: JSON.parse(line) }); } catch { /* partial or malformed line */ }
          }
        } else {
          stdout += text;
          if (stdout.length > 32_000_000) this.cancel();
        }
      });
      child.stderr.on('data', chunk => {
        const text = chunk.toString();
        stderr = (stderr + text).slice(-16_000);
        if (operation === 'firmwareUpdate' && stderr.includes('Firmware transfer starting.')) job.transferStarted = true;
        this.emit({ type: 'progress', message: text.trim(), transferStarted: job.transferStarted });
      });
      child.on('error', error => {
        if (settled) return;
        settled = true;
        this.active = null;
        this.emit({ type: 'finish', operation, ok: false });
        reject(error);
      });
      child.on('close', code => {
        if (settled) return;
        settled = true;
        this.active = null;
        this.emit({ type: 'finish', operation, ok: code === 0, cancelled: job.cancelRequested });
        if (job.cancelRequested) return resolve({ cancelled: true });
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Backend exited with status ${code}`));
          return;
        }
        if (operation === 'monitor' || operation === 'jog' || operation === 'manual') return resolve(null);
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Backend returned invalid JSON')); }
      });
    });
  }

  cancel() {
    if (!this.active) return false;
    if (this.active.transferStarted) throw new Error('Firmware transfer is in progress; wait for it to finish');
    this.active.cancelRequested = true;
    // A failed spawn has no PID. Its error event will clear the active job.
    if (this.active.child.pid != null) this.active.child.kill('SIGTERM');
    return true;
  }

  manualIntent(value) {
    if (this.active?.operation !== 'manual') throw new Error('Start monitoring first');
    const direction = Number(value.direction);
    const speed = Number(value.speed);
    if (typeof value.enabled !== 'boolean' || typeof value.reviewed !== 'boolean' || !Number.isInteger(direction) || direction < -1 || direction > 1 || !Number.isFinite(speed) || speed < 0.01 || speed > 1) {
      throw new Error('Invalid manual intent');
    }
    const input = this.active.child.stdin;
    if (input.destroyed || input.writableLength > 1024) {
      this.cancel();
      throw new Error('Manual control input stalled; motor is being disabled');
    }
    input.write(`${JSON.stringify({ type: 'intent', enabled: value.enabled, direction, speed, reviewed: value.reviewed })}\n`);
  }

  preview(config) {
    const input = JSON.stringify(config);
    if (!config || typeof config !== 'object' || input.length > 10_000) throw new Error('Invalid preview configuration');
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ['preview'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: this.environment });
      let stdout = '', stderr = '';
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) child.kill('SIGTERM'); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) return reject(new Error(stderr.trim() || 'Preview failed'));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid preview result')); }
      });
    });
  }
}

module.exports = { Backend, argsFor, backendPath };
