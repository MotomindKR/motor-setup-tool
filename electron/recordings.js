'use strict';

const { t } = require('./i18n.mjs');

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const motorModels = require('./motor-models.json');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { json } = require('node:stream/consumers');
const { pipeline } = require('node:stream/promises');
const { ZipFile } = require('yazl');

const SINGLE_FILES = ['training.csv', 'validation.csv', 'calibration.json'];
const ARTIFACTS = [
  ...SINGLE_FILES,
  'config.json', 'hardware.json', 'session.json', 'report.json',
  'candidate.json',
  'error.json', 'experiment_plan.json', 'watchdog_preflight.json', 'encoder_error.json', 'reprocessing.json',
  'pre_calibration.xml', 'post_calibration.xml', 'candidate.xml', 'replay_wrapper.py',
];
const MAX_EXPORT = 512 * 1024 * 1024;

async function regularFile(directory, name) {
  const stat = await fs.lstat(path.join(directory, name));
  if (!stat.isFile()) throw new Error(t("Recording changed while reading; try again"));
  return { name, stat };
}

function actuatorUuid(value) {
  if (Array.isArray(value) && value.length === 8 && value.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) {
    return Buffer.from(value).toString('hex').toUpperCase();
  }
  return typeof value === 'string' && /^[a-fA-F0-9]{16}$/.test(value) ? value.toUpperCase() : null;
}

const reportSummaries = new Map();

async function readMetadata(directory, file, limit) {
  if (file.stat.size > limit) throw new Error(t("{{name}} is too large", { name: file.name }));
  return json(fileChunks(directory, file));
}

async function readReport(directory, full) {
  const file = await regularFile(directory, 'report.json');
  const { dev, ino, ctimeMs, size, mtimeMs } = file.stat;
  const revision = [dev, ino, ctimeMs, size, mtimeMs].join(':');
  const cached = reportSummaries.get(directory);
  if (!full && cached?.revision === revision) return cached.summary;
  const report = await readMetadata(directory, file, 32_000_000);
  if (report?.source !== 'hardware' || !Array.isArray(report.replays)) throw new Error(t("Select a real motor recording"));
  const { model, motor_id, motor_uuid } = report;
  const summary = { model, motor_id, motor_uuid };
  reportSummaries.set(directory, { revision, summary });
  return full ? report : summary;
}

async function readRun(directory, full = false) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.dirname(directory) === directory) throw new Error(t("Select a calibration run"));
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory()) throw new Error(t("Select a calibration folder, not a link"));
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() && ARTIFACTS.includes(entry.name)).map(entry => entry.name);
  async function metadata(name) {
    if (!files.includes(name)) return null;
    return readMetadata(directory, await regularFile(directory, name), 32_768);
  }
  const report = files.includes('report.json') ? await readReport(directory, full) : null;
  const config = await metadata('config.json');
  const hardware = await metadata('hardware.json');
  const model = config?.profile?.model || report?.model;
  const motorId = config?.motor_id ?? report?.motor_id;
  if (typeof model !== 'string' || !Object.hasOwn(motorModels, model) || !Number.isInteger(motorId) || motorId < 1 || motorId > 254) throw new Error(t("Folder does not contain a calibration run"));
  const name = path.basename(directory);
  const timestamp = Number(/^\d{13}(?=-|$)/.exec(name)?.[0]) || stat.mtimeMs;
  const run = { directory, name, model, motorId, uuid: actuatorUuid(report?.motor_uuid) || actuatorUuid(hardware?.uuid), timestamp, completed: Boolean(report), files };
  return { run, report };
}

async function inspectRun(directory) {
  return (await readRun(directory)).run;
}

async function loadRun(directory) {
  const { run, report } = await readRun(directory, true);
  return { directory, report, files: run.files, uuid: run.uuid };
}

function exportName(run, file = null) {
  const identity = `${run.model}-ID${run.motorId}-${run.uuid || 'UUID-unknown'}-${Math.trunc(run.timestamp)}`;
  return file ? `${identity}-${file}` : `${identity}.zip`;
}

async function assertDestination(directory, destination) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error(t("Choose a download location"));
  const [source, parent] = await Promise.all([fs.realpath(directory), fs.realpath(path.dirname(destination))]);
  const relative = path.relative(source, path.join(parent, path.basename(destination)));
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error(t("Download outside the original run folder"));
}

async function* fileChunks(directory, file) {
  const handle = await fs.open(path.join(directory, file.name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== file.stat.size || stat.ino !== file.stat.ino || stat.dev !== file.stat.dev) {
      throw new Error(t("Recording changed while reading; try again"));
    }
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > stat.size) throw new Error(t("Recording changed while reading; try again"));
      yield chunk;
    }
    if (size !== stat.size) throw new Error(t("Recording changed while reading; try again"));
  } finally {
    await handle.close();
  }
}

async function zipRun(directory, files, output) {
  const archive = new ZipFile();
  let source;
  archive.on('error', error => archive.outputStream.destroy(error));
  for (const file of files) {
    archive.addReadStreamLazy(file.name, { size: file.stat.size }, ready => {
      source = Readable.from(fileChunks(directory, file));
      source.on('error', error => archive.outputStream.destroy(error));
      ready(null, source);
    });
  }
  archive.end();
  try {
    await pipeline(archive.outputStream, output);
  } finally {
    source?.destroy();
  }
}

async function exportRun(directory, destination, file = null) {
  const run = await inspectRun(directory);
  await assertDestination(directory, destination);
  if (file !== null && !SINGLE_FILES.includes(file)) throw new Error(t("Choose an available recording file"));
  if (file && !run.files.includes(file)) throw new Error(t("Recording file is missing"));
  const files = await Promise.all((file ? [file] : run.files).map(name => regularFile(directory, name)));
  if (files.reduce((total, entry) => total + entry.stat.size, 0) > MAX_EXPORT) throw new Error(t("Run exceeds the 512 MB download limit. Open its folder to copy the files."));
  const temporary = path.join(path.dirname(destination), `.motor-download-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx');
  try {
    const output = handle.createWriteStream();
    if (file) await pipeline(fileChunks(directory, files[0]), output);
    else await zipRun(directory, files, output);
    await fs.rename(temporary, destination);
    return { path: destination };
  } finally {
    await handle.close();
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
  reportSummaries.delete(directory);
  return { directory };
}

module.exports = { inspectRun, loadRun, exportRun, exportName, SINGLE_FILES, deleteRun };
