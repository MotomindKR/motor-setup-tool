'use strict';

const { t } = require('./i18n.js');
const { exitError } = require('./worker-exit');

const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { promisify } = require('node:util');
const path = require('node:path');
const motorModels = require('./motor-models.json');
const fs = require('node:fs');
const registerCatalog = require('./register-catalog.json');

function integer(value, name, min = 1, max = 254) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(t("{{name}} must be {{min}}–{{max}}", { name, min, max }));
  return String(n);
}

function number(value, name, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(t("{{name}} must be {{min}}–{{max}}", { name, min, max }));
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

function busArgs(params) {
  const can = params.can;
  if (!validCan(can)) {
    throw new Error(t("Select a valid CAN interface"));
  }
  return ['--can', can, '--host-id', integer(params.hostId ?? 253, t("Host ID"))];
}

function target(params) {
  return [...busArgs(params), '--id', integer(params.id, t("Motor ID"))];
}

function selectedTarget(params) {
  if (!/^[a-f0-9]{16}$/i.test(params.expectedUuid)) throw new Error(t("Scan and select a motor with a valid UUID"));
  return [...target(params), '--expected-uuid', params.expectedUuid];
}

function setupRegister(value, writable = false, model) {
  if (typeof model !== 'string' || !Object.hasOwn(motorModels, model)) throw new Error(t("Select a supported motor model"));
  const index = Number(value);
  const base = registerCatalog.find(item => Number(item.index) === index);
  const item = base ? { ...base, ...base.overrides?.[model] } : null;
  if (!Number.isInteger(index) || !item?.readable || (writable && (!item.writable || !item.editable || item.persistence !== 'save_to_flash'))) {
    throw new Error(t("Select a documented register allowed for this operation"));
  }
  return item;
}

function argsFor(operation, params = {}) {
  switch (operation) {
    case 'interfaces': return ['can', 'list'];
    case 'usbAdapters': return ['can', 'usb-list'];
    case 'canUp':
    case 'canRestart': {
      const can = params.can;
      if (typeof can !== 'string' || !/^[a-zA-Z0-9_.-]{1,15}$/.test(can)) throw new Error(t("Select a valid SocketCAN interface"));
      return ['can', operation === 'canUp' ? 'up' : 'restart', can, '--auth', 'polkit'];
    }
    case 'scan': return ['scan', ...busArgs(params)];
    case 'plan': {
      if (typeof params.model !== 'string' || !Object.hasOwn(motorModels, params.model)) throw new Error(t("Unknown motor model"));
      return ['plan', '--model', params.model, '--setup'];
    }
    case 'calibrate': {
      if (params.reviewed !== true) throw new Error(t("Review the motor limits and secure the motor first"));
      if (!params.config || typeof params.config !== 'object') throw new Error(t("Calibration configuration missing"));
      if (params.output != null && (typeof params.output !== 'string' || !path.isAbsolute(params.output))) throw new Error(t("Select a valid calibration folder"));
      return ['calibrate', ...selectedTarget(params), ...(params.output ? ['--output', params.output] : []), '--config-stdin', '--yes'];
    }
    case 'analyze': {
      if (typeof params.directory !== 'string' || !path.isAbsolute(params.directory)) throw new Error(t("Select a saved run"));
      return ['analyze', params.directory];
    }
    case 'manual': {
      if (!params.config || typeof params.config !== 'object') throw new Error(t("Manual configuration missing"));
      return ['manual-session', ...selectedTarget(params)];
    }
    case 'stop': return ['stop', ...target(params)];
    case 'zero': {
      if (params.confirmed !== true) throw new Error(t("Confirm the stationary motor first"));
      return ['zero', ...selectedTarget(params), '--yes'];
    }
    case 'setId': {
      if (params.confirmed !== true) throw new Error(t("Confirm the ID change first"));
      return ['set-id', ...selectedTarget(params), '--new-id', integer(params.newId, t("New motor ID")), '--yes'];
    }
    case 'firmwarePrepare': return ['firmware', 'prepare', ...target(params)];
    case 'firmwareUpdate': {
      if (params.confirmed !== true) throw new Error(t("Confirm firmware update and stable power first"));
      const prepared = JSON.stringify(params.prepared);
      if (!prepared || prepared.length > 4096) throw new Error(t("Prepare firmware for the selected motor first"));
      return ['firmware', 'update', ...target(params), '--prepared', prepared, '--yes'];
    }
    case 'registerRead': return ['register', 'read', ...target(params), '--index', setupRegister(params.index, false, params.model).index];
    case 'registerWrite': {
      if (params.confirmed !== true) throw new Error(t("Confirm the persistent register change first"));
      const item = setupRegister(params.index, true, params.model);
      const value = number(params.value, t("Register value"), item.min, item.max);
      if (typeof params.uuid !== 'string' || !/^[a-fA-F0-9]{16}$/.test(params.uuid)) throw new Error(t("Read the motor identity again"));
      if (typeof params.expectedRaw !== 'string' || !/^[a-fA-F0-9]{8}$/.test(params.expectedRaw)) throw new Error(t("Read the register again"));
      return ['register', 'write', ...target(params), '--index', item.index, '--value', value, '--uuid', params.uuid, '--expected-raw', params.expectedRaw, '--yes'];
    }
    default: throw new Error(t("Unknown operation"));
  }
}

function backendPath(root, resourcesPath = null, override = process.env.MOTOMIND_BACKEND) {
  const binary = process.platform === 'win32' ? 'motor-setup-tool.exe' : 'motor-setup-tool';
  if (resourcesPath) {
    const bundled = path.join(resourcesPath, 'backend', binary);
    if (!fs.existsSync(bundled)) throw new Error(t("Bundled Rust backend missing: {{file}}", { file: bundled }));
    return bundled;
  }
  if (override) {
    if (fs.existsSync(override)) return path.resolve(override);
    throw new Error(t("Rust backend missing: {{file}}", { file: override }));
  }
  const release = path.join(root, 'target', 'release', binary);
  if (fs.existsSync(release)) return release;
  throw new Error(t("Rust backend missing. Build it with cargo build --release."));
}

class Backend {
  constructor(binary, emit) {
    this.binary = binary;
    this.emit = emit;
    this.active = null;
    const bundledLib = path.join(path.dirname(binary), 'lib');
    const developmentLib = path.join(path.resolve(__dirname, '..'), '.tools', 'mujoco', 'mujoco-3.17.0', process.platform === 'win32' ? 'bin' : 'lib');
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
    if (this.active) throw new Error(t("Finish or stop the current operation first"));
    const args = argsFor(operation, params);
    const input = operation === 'calibrate' || operation === 'manual' ? JSON.stringify(params.config) : null;
    if (input && input.length > 10_000) throw new Error(t("Configuration is too large"));
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ['--desktop', ...args], { stdio: 'pipe', shell: false, env: this.environment });
      const job = { child, operation };
      this.active = job;
      child.stdin.on('error', () => {}); // A worker can exit before reading its input.
      if (input) child.stdin.write(`${input}\n`);
      let pending = '';
      let result;
      let protocolError;
      let stderr = '';
      const onLine = line => {
        const event = JSON.parse(line);
        switch (event.type) {
          case 'result':
            if (result !== undefined || !Object.hasOwn(event, 'value')) throw new Error(t("Invalid backend result"));
            result = event.value;
            break;
          case 'progress':
          case 'manualStatus':
          case 'recordingCreated':
            this.emit(event);
            break;
          default:
            throw new Error(t("Unknown backend event"));
        }
      };
      child.stdout.setEncoding('utf8').on('data', chunk => {
        if (protocolError) return;
        pending += chunk;
        try {
          if (pending.length > 32_000_000) throw new Error(t("Backend output exceeded the size limit"));
          let newline;
          while ((newline = pending.indexOf('\n')) !== -1) {
            onLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
          }
        } catch (error) {
          protocolError = new Error(t("Invalid backend response: {{error}}", { error: error.message }));
          pending = '';
          this.cancel();
        }
      });
      child.stderr.setEncoding('utf8').on('data', chunk => {
        stderr = (stderr + chunk).slice(-16_000);
      });
      let spawnError;
      child.once('error', error => { spawnError = error; });
      child.on('close', (code, signal) => {
        this.active = null;
        this.emit({ type: 'finish' });
        if (spawnError) return reject(spawnError);
        if (protocolError) return reject(protocolError);
        if (code !== 0) {
          reject(exitError(t("Backend"), code, signal, stderr));
          return;
        }
        if (pending || result === undefined) return reject(new Error(t("Backend exited with an incomplete response")));
        resolve(result);
      });
    });
  }

  cancel() {
    if (!this.active) return false;
    const input = this.active.child.stdin;
    if (!input.writableEnded && !input.destroyed) input.end();
    return true;
  }

  manualIntent(value) {
    if (this.active?.operation !== 'manual') throw new Error(t("Start monitoring first"));
    const direction = Number(value.direction);
    const speed = Number(value.speed);
    if (typeof value.enabled !== 'boolean' || typeof value.reviewed !== 'boolean' || !Number.isInteger(direction) || direction < -1 || direction > 1 || !Number.isFinite(speed) || speed < 0.01 || speed > 1) {
      throw new Error(t("Invalid manual intent"));
    }
    const input = this.active.child.stdin;
    if (input.writableEnded) return;
    if (input.destroyed || input.writableLength > 1024) {
      this.cancel();
      throw new Error(t("Manual control input stalled; motor is being disabled"));
    }
    input.write(`${JSON.stringify({ type: 'intent', enabled: value.enabled, direction, speed, reviewed: value.reviewed })}\n`);
  }

  async withRecordingLock(directory, action) {
    const finished = promisify(execFile)(this.binary, ['lock-recording', directory], { env: this.environment, windowsHide: true });
    const { child } = finished;
    const lines = createInterface({ input: child.stdout });
    try {
      const ready = once(lines, 'line').then(([line]) => line);
      if (await Promise.race([ready, finished.then(() => null)]) !== 'locked') {
        throw new Error(t("Could not lock the recording"));
      }
      return await action();
    } finally {
      lines.close();
      child.stdin.end();
      await finished;
    }
  }

  preview(config) {
    const input = JSON.stringify(config);
    if (!config || typeof config !== 'object' || input.length > 10_000) throw new Error(t("Invalid preview configuration"));
    return new Promise((resolve, reject) => {
      const child = execFile(this.binary, ['preview'], { env: this.environment, maxBuffer: 2_000_000 }, (error, stdout, stderr) => {
        if (error) {
          return reject(typeof error.code === 'number' || error.signal
            ? exitError(t("Preview backend"), error.code, error.signal, stderr.slice(-4000))
            : error);
        }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(t("Invalid preview result"))); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
}

module.exports = { Backend, argsFor, backendPath };
