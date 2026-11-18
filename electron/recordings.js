'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { crc32 } = require('node:zlib');

// Only calibration artifacts are exported. Never follow links or include unrelated files.
const ARTIFACTS = [
  'config.json', 'hardware.json', 'session.json', 'report.json',
  'training.csv', 'validation.csv', 'calibration.json', 'candidate.json',
  'experiment_plan.json', 'watchdog_preflight.json', 'encoder_error.json',
  'pre_calibration.xml', 'post_calibration.xml', 'candidate.xml', 'replay_wrapper.py',
];
const SINGLE_FILES = ['training.csv', 'validation.csv', 'calibration.json'];
const MAX_EXPORT = 512 * 1024 * 1024;

async function regularFile(directory, name) {
  try {
    const stat = await fs.lstat(path.join(directory, name));
    return stat.isFile() ? { name, stat } : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function jsonFile(directory, name, limit) {
  const file = await regularFile(directory, name);
  if (!file) return null;
  if (file.stat.size > limit) throw new Error(`${name} is too large`);
  return JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
}

function actuatorUuid(value) {
  if (Array.isArray(value) && value.length === 8 && value.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) {
    return Buffer.from(value).toString('hex').toUpperCase();
  }
  return typeof value === 'string' && /^[a-fA-F0-9]{16}$/.test(value) ? value.toUpperCase() : null;
}

async function inspectRun(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.dirname(directory) === directory) throw new Error('Select a calibration run');
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error('Select a calibration folder, not a link');
  const report = await jsonFile(directory, 'report.json', 32_000_000);
  const config = await jsonFile(directory, 'config.json', 32_768);
  const hardware = await jsonFile(directory, 'hardware.json', 32_768);
  if (report && (report.source !== 'hardware' || !Array.isArray(report.replays))) throw new Error('Select a real motor recording');
  const model = config?.profile?.model || report?.model;
  const motorId = config?.motor_id ?? report?.motor_id;
  if (!/^(?:RS-0[0-6]|RS-10P)$/.test(model) || !Number.isInteger(motorId) || motorId < 1 || motorId > 254) throw new Error('Folder does not contain a calibration run');
  const files = (await Promise.all(ARTIFACTS.map(name => regularFile(directory, name)))).filter(Boolean);
  const name = path.basename(directory);
  const timestamp = Number(/^\d{13}(?=-|$)/.exec(name)?.[0]) || (await fs.stat(directory)).mtimeMs;
  return { directory, name, model, motorId, uuid: actuatorUuid(hardware?.uuid) || actuatorUuid(report?.motor_uuid), timestamp, completed: Boolean(report), files: files.map(f => f.name) };
}

async function loadRun(directory) {
  const run = await inspectRun(directory);
  if (!run.completed) throw new Error('This run has no completed report. You can still download or delete its files.');
  return { directory, report: await jsonFile(directory, 'report.json', 32_000_000), files: run.files, uuid: run.uuid };
}

function exportName(run, file = null) {
  const identity = `${run.model}-ID${run.motorId}-${run.uuid || 'UUID-unknown'}-${Math.trunc(run.timestamp)}`;
  return file ? `${identity}-${file}` : `${identity}.zip`;
}

function assertDestination(directory, destination) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('Choose a download location');
  const relative = path.relative(directory, destination);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Download outside the original run folder');
}

async function openSource(directory, file) {
  const handle = await fs.open(path.join(directory, file.name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size !== file.stat.size || stat.ino !== file.stat.ino || stat.dev !== file.stat.dev) {
    await handle.close();
    throw new Error('Recording changed during download; try again');
  }
  return handle;
}

// Streaming ZIP (stored entries, ZIP32). Works without a platform-specific archiver
// or runtime npm dependency, and bounds memory even for large session.json files.
async function zipRun(directory, files, output) {
  let offset = 0;
  const central = [];
  const write = async data => { await output.writeFile(data); offset += data.length; };
  for (const file of files) {
    const name = Buffer.from(file.name);
    const start = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6); // UTF-8 + trailing CRC/sizes
    local.writeUInt16LE(33, 12); // 1980-01-01
    local.writeUInt16LE(name.length, 26);
    await write(local);
    await write(name);
    let crc = 0, size = 0;
    const source = await openSource(directory, file);
    try {
      for await (const chunk of source.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > file.stat.size) throw new Error('Recording changed during download; try again');
        crc = crc32(chunk, crc);
        await write(chunk);
      }
    } finally { await source.close(); }
    if (size !== file.stat.size) throw new Error('Recording changed during download; try again');
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    await write(descriptor);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0808, 8);
    entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(size, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(start, 42);
    central.push(entry, name);
  }
  const start = offset;
  for (const entry of central) await write(entry);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(offset - start, 12);
  end.writeUInt32LE(start, 16);
  await write(end);
}

async function exportRun(directory, destination, file = null) {
  const run = await inspectRun(directory);
  assertDestination(await fs.realpath(directory), path.join(await fs.realpath(path.dirname(destination)), path.basename(destination)));
  if (file !== null && !SINGLE_FILES.includes(file)) throw new Error('Choose an available recording file');
  const files = (await Promise.all((file ? [file] : run.files).map(name => regularFile(directory, name)))).filter(Boolean);
  if (!files.length || (file && files.length !== 1)) throw new Error('Recording file is missing');
  if (files.reduce((total, entry) => total + entry.stat.size, 0) > MAX_EXPORT) throw new Error('Run exceeds the 512 MB download limit. Open its folder to copy the files.');
  const temporary = path.join(path.dirname(destination), `.motor-download-${randomUUID()}.tmp`);
  let output;
  try {
    output = await fs.open(temporary, 'wx');
    if (!file) await zipRun(directory, files, output);
    else {
      const source = await openSource(directory, files[0]);
      try {
        let size = 0;
        for await (const chunk of source.createReadStream({ autoClose: false })) {
          size += chunk.length;
          if (size > files[0].stat.size) throw new Error('Recording changed during download; try again');
          await output.writeFile(chunk);
        }
        if (size !== files[0].stat.size) throw new Error('Recording changed during download; try again');
      } finally { await source.close(); }
    }
    await output.close();
    output = null;
    await fs.rename(temporary, destination);
    return { path: destination };
  } finally {
    await output?.close();
    await fs.rm(temporary, { force: true });
  }
}

async function deleteRun(directory) {
  const run = await inspectRun(directory);
  // Custom output folders may also contain user files. Delete calibration
  // artifacts only, then remove the folder if it is empty.
  const metadata = ['hardware.json', 'report.json', 'config.json'];
  const ordered = [...run.files.filter(name => !metadata.includes(name)), ...metadata.filter(name => run.files.includes(name))];
  for (const name of ordered) await fs.unlink(path.join(directory, name));
  try { await fs.rmdir(directory); }
  catch (error) { if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error; }
  return { directory };
}

module.exports = { inspectRun, loadRun, exportRun, exportName, actuatorUuid, deleteRun };
