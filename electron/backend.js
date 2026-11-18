'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const registerCatalog = require('./register-catalog.json');

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
  return false;
}

function target(params) {
  const can = params.can;
  if (!validCan(can)) {
    throw new Error('Select a valid CAN interface');
  }
  return ['--can', can, '--host-id', integer(params.hostId ?? 253, 'Host ID'), '--id', integer(params.id, 'Motor ID')];
}

function setupRegister(value, writable = false, model) {
  if (!/^(?:RS-0[0-6]|RS-10P)$/.test(model)) throw new Error('Select a supported motor model');
  const index = Number(value);
  const base = registerCatalog.find(item => Number(item.index) === index);
  const item = base ? { ...base, ...base.overrides?.[model] } : null;
  if (!Number.isInteger(index) || !item?.readable || (writable && (!item.writable || !item.editable || item.persistence !== 'save_to_flash'))) {
    throw new Error('Select a documented register allowed for this operation');
  }
  return item;
}

function argsFor(operation, params = {}) {
  switch (operation) {
    case 'interfaces': return ['can', 'list'];
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
    case 'plan': {
      if (!/^(?:RS-0[0-6]|RS-10P)$/.test(params.model)) throw new Error('Unknown motor model');
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
    case 'manual': {
      if (!params.config || typeof params.config !== 'object') throw new Error('Manual configuration missing');
      return ['manual-session', ...target(params)];
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
    case 'firmwarePrepare': return ['firmware', 'prepare', ...target(params)];
    case 'firmwareUpdate': {
      if (params.confirmed !== true) throw new Error('Confirm firmware update and stable power first');
      return ['firmware', 'update', ...target(params), '--yes'];
    }
    case 'registerList': {
      if (!/^(?:RS-0[0-6]|RS-10P)$/.test(params.model)) throw new Error('Select a supported motor model');
      return ['register', 'list', '--model', params.model];
    }
    case 'registerRead': return ['register', 'read', ...target(params), '--index', setupRegister(params.index, false, params.model).index];
    case 'registerWrite': {
      if (params.confirmed !== true) throw new Error('Confirm the persistent register change first');
      const item = setupRegister(params.index, true, params.model);
      const value = number(params.value, 'Register value', item.min, item.max);
      if (typeof params.uuid !== 'string' || !/^[a-fA-F0-9]{16}$/.test(params.uuid)) throw new Error('Read the motor identity again');
      if (typeof params.expectedRaw !== 'string' || !/^[a-fA-F0-9]{8}$/.test(params.expectedRaw)) throw new Error('Read the register again');
      return ['register', 'write', ...target(params), '--index', item.index, '--value', value, '--uuid', params.uuid, '--expected-raw', params.expectedRaw, '--yes'];
    }
    default: throw new Error('Unknown operation');
  }
}

function backendPath(root, resourcesPath = null, override = process.env.MOTOMIND_BACKEND) {
  const binary = process.platform === 'win32' ? 'motor-setup-tool.exe' : 'motor-setup-tool';
  if (resourcesPath) {
    const bundled = path.join(resourcesPath, 'backend', binary);
    if (!fs.existsSync(bundled)) throw new Error(`Bundled Rust backend missing: ${bundled}`);
    return bundled;
  }
  if (override) {
    if (fs.existsSync(override)) return path.resolve(override);
    throw new Error(`Rust backend missing: ${override}`);
  }
  const release = path.join(root, 'target', 'release', binary);
  if (fs.existsSync(release)) return release;
  throw new Error('Rust backend missing. Build it with cargo build --release.');
}

function exitError(code, signal, stderr, name = 'Backend') {
  const detail = stderr.trim();
  if (signal) return new Error(`${name} terminated by ${signal}${detail ? `\n${detail}` : ''}`);
  return new Error(detail || `${name} exited with status ${code}`);
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
        if (operation === 'manual') {
          lines += text;
          let index;
          while ((index = lines.indexOf('\n')) >= 0) {
            const line = lines.slice(0, index);
            lines = lines.slice(index + 1);
            try { this.emit({ type: 'manualStatus', value: JSON.parse(line) }); } catch { /* partial or malformed line */ }
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
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        this.active = null;
        this.emit({ type: 'finish', operation, ok: code === 0, cancelled: job.cancelRequested });
        if (job.cancelRequested) return resolve({ cancelled: true });
        if (code !== 0) {
          reject(exitError(code, signal, stderr));
          return;
        }
        if (operation === 'manual') return resolve(null);
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
      child.on('close', (code, signal) => {
        if (code !== 0) return reject(exitError(code, signal, stderr, 'Preview backend'));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid preview result')); }
      });
    });
  }
}

module.exports = { Backend, argsFor, backendPath };
