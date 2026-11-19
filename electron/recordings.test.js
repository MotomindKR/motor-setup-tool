'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { unzipSync } = require('fflate');
const { inspectRun, loadRun, exportRun, exportName, deleteRun } = require('./recordings');

async function fixture(t, completed = true) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'motor-recordings-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, '1760000000000-RS-10P');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ profile: { model: 'RS-10P' }, motor_id: 61 }));
  await fs.writeFile(path.join(directory, 'hardware.json'), JSON.stringify({ uuid: [1,2,3,4,5,6,7,8] }));
  await fs.writeFile(path.join(directory, 'training.csv'), 'time_s,measured_position\n0,0\n1,0.5\n');
  await fs.writeFile(path.join(directory, 'validation.csv'), 'time_s,measured_position\n0,0\n');
  if (completed) await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({ source: 'hardware', replays: [], model: 'RS-10P', motor_id: 61 }));
  return { base, directory };
}

test('downloads are independently readable ZIPs containing exact artifacts and actuator identity', async t => {
  const { base, directory } = await fixture(t);
  await fs.writeFile(path.join(directory, 'unrelated-secret.txt'), 'excluded');
  const provenance = { reason: 'Corrected acquisition timestamps' };
  await fs.writeFile(path.join(directory, 'reprocessing.json'), JSON.stringify(provenance));
  await fs.writeFile(path.join(directory, 'session.json'), Buffer.alloc(300_000, 65));
  const destination = path.join(base, 'download.zip');
  await exportRun(directory, destination);
  const zip = unzipSync(await fs.readFile(destination));
  assert.ok(!('unrelated-secret.txt' in zip));
  for (const name of (await fs.readdir(directory)).filter(name => name !== 'unrelated-secret.txt')) {
    assert.deepEqual(Buffer.from(zip[name]), await fs.readFile(path.join(directory, name)), name);
  }
  const run = await inspectRun(directory);
  assert.equal(run.uuid, '0102030405060708');
  assert.match(exportName(run), /^RS-10P-ID61-0102030405060708-1760000000000\.zip$/);
  assert.equal((await loadRun(directory)).files.includes('training.csv'), true);
});

test('individual downloads preserve CSV bytes and cannot overwrite run artifacts', async t => {
  const { base, directory } = await fixture(t);
  const output = path.join(base, 'recording.csv');
  await exportRun(directory, output, 'validation.csv');
  assert.deepEqual(await fs.readFile(output), await fs.readFile(path.join(directory, 'validation.csv')));
  await assert.rejects(exportRun(directory, path.join(directory, 'training.csv'), 'validation.csv'), /outside/);
  await assert.rejects(exportRun(directory, output, '../training.csv'), /available recording/);
  await assert.rejects(exportRun(directory, output, 'calibration.json'), /missing/);
  await assert.rejects(exportRun(directory, path.relative(process.cwd(), output), 'validation.csv'), /download location/);
  assert.equal((await fs.readdir(base)).some(name => name.endsWith('.tmp')), false);
});

test('incomplete calibration runs can be managed without a completed report', async t => {
  const { base, directory } = await fixture(t, false);
  assert.equal((await inspectRun(directory)).completed, false);
  await assert.rejects(loadRun(directory), /no completed report/);
  const partial = await loadRun(directory, { allowIncomplete: true });
  assert.equal(partial.report, null);
  assert.equal(partial.uuid, '0102030405060708');
  assert.ok(partial.files.includes('training.csv'));
  await assert.rejects(loadRun(base, { allowIncomplete: true }), /does not contain/);
  await exportRun(directory, path.join(base, 'partial.zip'));
  await fs.rm(path.join(directory, 'hardware.json'));
  assert.equal((await inspectRun(directory)).uuid, null);
});

test('arbitrary folders and symlinked artifacts are excluded', async t => {
  const { base, directory } = await fixture(t);
  await fs.symlink(path.join(base, 'outside.json'), path.join(directory, 'calibration.json'));
  assert.equal((await inspectRun(directory)).files.includes('calibration.json'), false);
  await assert.rejects(exportRun(directory, path.join(base, 'copy.json'), 'calibration.json'), /missing/);
  await fs.symlink(directory, path.join(base, 'run-link'));
  await assert.rejects(inspectRun(path.join(base, 'run-link')), /not a link/);
  await assert.rejects(inspectRun(base), /does not contain/);
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({source: 'simulation', replays: []}));
  await assert.rejects(inspectRun(directory), /real motor/);
});

test('deletion removes calibration artifacts permanently and preserves unrelated files', async t => {
  const { directory } = await fixture(t);
  await fs.writeFile(path.join(directory, 'notes.txt'), 'user notes');
  await fs.writeFile(path.join(directory, 'error.json'), JSON.stringify({ error: 'Acquisition failed' }));
  await deleteRun(directory);
  assert.deepEqual(await fs.readdir(directory), ['notes.txt']);
  assert.equal(await fs.readFile(path.join(directory, 'notes.txt'), 'utf8'), 'user notes');
  await assert.rejects(inspectRun(directory), /does not contain/);
});

test('deletion removes an empty run folder and rejects unrelated folders', async t => {
  const { base, directory } = await fixture(t, false);
  await assert.rejects(deleteRun(base), /does not contain/);
  await deleteRun(directory);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('refreshing the recordings list observes a report replaced by a refit', async t => {
  const { directory } = await fixture(t);
  for (const name of ['config.json', 'hardware.json']) await fs.unlink(path.join(directory, name));
  const file = path.join(directory, 'report.json');
  assert.equal((await inspectRun(directory)).uuid, null);
  const report = JSON.parse(await fs.readFile(file));
  report.motor_uuid = '0123456789abcdef';
  await fs.writeFile(file + '.tmp', JSON.stringify(report));
  await fs.rename(file + '.tmp', file);
  assert.equal((await inspectRun(directory)).uuid, '0123456789ABCDEF');
  assert.deepEqual((await loadRun(directory)).report, report);
});
