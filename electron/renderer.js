'use strict';

const $ = id => document.getElementById(id);
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const themeKey = 'motomind-appearance';
function savedTheme() {
  try {
    const value = localStorage.getItem(themeKey);
    return ['system', 'light', 'dark'].includes(value) ? value : 'system';
  } catch { return 'system'; }
}
let themeChoice = savedTheme();
function applyTheme() {
  document.documentElement.dataset.theme = themeChoice === 'system'
    ? systemDark.matches ? 'dark' : 'light'
    : themeChoice;
  $('theme-select').value = themeChoice;
  renderReport(); renderPreview(); renderLive();
}
const state = {
  interfaces: [], usbAdapters: [], motors: [], motor: null, preset: null, report: null, directory: null,
  tab: 'calibrate', trace: 'validation', chart: 'motion', busy: null, firmware: null,
  preview: null, previewSeq: 0, manualStatus: null, manualHistory: [], manualPromise: null,
  wantEnabled: false, manualEverEnabled: false, direction: 0, lastStatusAt: 0,
  manualIntentPending: false, lastLiveDraw: 0, outputDirectory: null,
  updateCandidate: null, installingUpdate: false, referenceAngle: 0,
  registers: null, registersLoading: false, registersFailed: false, registerRead: null,
};
let referenceAngleUnit = 'rad';
function angleForInput(radians) {
  return String(Number((referenceAngleUnit === 'deg' ? radians * 180 / Math.PI : radians).toPrecision(12)));
}
function showReferenceAngle(radians) {
  $('reference-angle').value = angleForInput(radians);
}
function referenceAngleFromInput() {
  const input = $('reference-angle').value.trim();
  if (!input) return NaN;
  const value = Number(input);
  return referenceAngleUnit === 'deg' ? value * Math.PI / 180 : value;
}

const configFields = [
  ['torque-limit', 'torque_limit'], ['speed-limit', 'speed_limit'],
  ['travel-limit', 'travel_limit'], ['train-seconds', 'train_seconds'],
  ['validation-seconds', 'validation_seconds'], ['temperature-limit', 'temperature_limit'],
  ['sample-hz', 'sample_hz'], ['sweep-start-hz', 'sweep_start_hz'],
  ['sweep-end-hz', 'sweep_end_hz'],
];
const baselineFields = [
  ['baseline-armature', 'armature'], ['baseline-damping', 'damping'],
  ['baseline-friction', 'friction'], ['baseline-delay', 'delay'],
];

function notice(message, error = false) {
  const box = $('notice');
  const readable = error ? String(message).replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(?:Error:\s*)+/, '') : message;
  box.textContent = readable;
  box.classList.toggle('error', error);
  box.classList.toggle('hidden', !readable);
}

function slcanSelected() { return $('transport-select').value === 'slcan'; }
function gsusbSelected() { return $('transport-select').value === 'gsusb'; }
function selectedSerialPort() {
  return $('slcan-port-select').value === 'manual'
    ? $('slcan-port').value.trim()
    : $('slcan-port-select').value;
}
function selectedCan() {
  return slcanSelected()
    ? `slcan:${$('slcan-profile').value}:${$('slcan-baud').value}:${selectedSerialPort()}`
    : gsusbSelected() ? $('gsusb-select').value : $('can-select').value;
}
function serialPortValid() {
  const port = selectedSerialPort();
  return window.motorApp.platform === 'win32'
    ? /^COM[1-9][0-9]*$/i.test(port)
    : /^\/dev\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(port);
}
function busReady() {
  if (slcanSelected()) return serialPortValid();
  if (gsusbSelected()) return state.usbAdapters.some(adapter =>
    adapter.id === selectedCan() && adapter.accessible);
  return state.interfaces.some(bus => bus.name === selectedCan() && bus.up && /^ERROR-(ACTIVE|WARNING|PASSIVE)$/.test(bus.state));
}
function target() { return { can: selectedCan(), hostId: $('host-id').value, id: state.motor?.id }; }
function numberText(value, digits = 3) { return Number.isFinite(value) ? Number(value).toFixed(digits) : '—'; }
function maxJogSpeed() { return Math.max(0.01, Math.min(Number($('speed-limit').value) * 0.1, 1)); }
function feedbackFresh() { return state.manualStatus?.fresh && performance.now() - state.lastStatusAt < 200; }
function motorReady() {
  return Boolean(busReady() && state.motor?.model && !state.motor?.issue);
}
function motorUuid() {
  return Array.isArray(state.motor?.uuid) ? state.motor.uuid.map(value => Number(value).toString(16).padStart(2, '0')).join('').toUpperCase() : '';
}
function selectedRegister() {
  return state.registers?.find(item => String(item.index) === $('register-select').value);
}
function clearRegisterRead() {
  state.registerRead = null;
  $('register-value').value = '';
  $('register-status').textContent = 'Read a register before editing it.';
  updateControls();
}
async function loadRegisters() {
  if (state.registers || state.registersLoading || state.registersFailed || state.busy) return;
  state.registersLoading = true;
  try {
    const registers = await run('registerList');
    state.registers = registers;
    $('register-select').replaceChildren(new Option('Select a register', ''), ...registers.map(item => new Option(`0x${item.index.toString(16).toUpperCase()} · ${item.name}${item.writable ? '' : ' · read only'}`, String(item.index))));
  } catch { state.registersFailed = true; }
  finally { state.registersLoading = false; updateControls(); }
}
function buildConfig() {
  if (!state.preset || !state.motor) throw new Error('Scan and select a motor first');
  const config = structuredClone(state.preset);
  config.interface = selectedCan();
  config.reference_angle_rad = state.referenceAngle;
  config.host_id = Number($('host-id').value);
  config.motor_id = state.motor.id;
  for (const [id, key] of configFields) config[key] = Number($(id).value);
  for (const [id, key] of baselineFields) config.baseline[key] = Number($(id).value);
  config.baseline.static_friction = 0;
  config.experiment = 'Mixed';
  config.excitation_revision = 1;
  return config;
}

function renderSurface() {
  const test = state.tab === 'test';
  $('page-title').textContent = test ? (state.motor ? `${state.motor.model || 'Motor'} · ID ${state.motor.id}` : 'Motor test')
    : state.report ? 'Results'
      : state.tab === 'files' ? 'Saved recordings'
        : state.motor ? `${state.motor.model || 'Motor'} · ID ${state.motor.id}` : 'Connect your motor';
  $('empty-state').querySelector('p').textContent = state.tab === 'files'
    ? 'Select a recent run or open a folder.'
    : slcanSelected() ? 'Select a serial port and scan for a motor.'
      : gsusbSelected() ? 'Select a USB adapter and scan for a motor.'
      : 'Select a CAN bus and scan for a motor.';
  $('manual-view').classList.toggle('hidden', !test);
  $('report-view').classList.toggle('hidden', test || !state.report);
  $('preview-view').classList.toggle('hidden', test || Boolean(state.report) || !state.preset);
  $('empty-state').classList.toggle('hidden', test || Boolean(state.report) || Boolean(state.preset));
  if (test) renderLive();
  else if (!state.report && state.preset) renderPreview();
}

function updateControls() {
  const selected = state.interfaces.find(bus => bus.name === selectedCan());
  const selectedUsb = state.usbAdapters.find(adapter => adapter.id === selectedCan());
  const ready = busReady();
  const selectedMotor = motorReady();
  const busy = Boolean(state.busy) || state.installingUpdate;
  const manual = state.busy === 'manual';
  const status = state.manualStatus;
  const fresh = feedbackFresh();
  const healthy = fresh && status?.faults === 0 && status?.temperature_c < Number($('temperature-limit').value);
  $('top-actions').classList.toggle('hidden', state.tab === 'files' && !state.motor);
  $('can-state').textContent = slcanSelected()
    ? (serialPortValid() ? 'Classic CAN · 1 Mbps' : 'Select a serial port')
    : gsusbSelected() ? (selectedUsb ? selectedUsb.accessible ? 'Direct USB · 1 Mbps'
      : 'USB access denied · install the udev rule and reconnect' : 'No GS USB adapter selected')
    : selected ? `${selected.up ? 'Up' : 'Down'} · ${selected.state}${selected.bitrate ? ` · ${(selected.bitrate / 1e6).toFixed(1)} Mbps` : ''}` : 'No CAN interface found';
  $('can-up').querySelector('.button-label').textContent = ready ? 'Restart CAN' : 'CAN up';
  $('can-up').disabled = busy || !selected;
  $('socketcan-fields').classList.toggle('hidden', slcanSelected() || gsusbSelected());
  $('gsusb-fields').classList.toggle('hidden', !gsusbSelected());
  $('slcan-fields').classList.toggle('hidden', !slcanSelected());
  $('refresh-interfaces').disabled = busy;
  $('scan').disabled = busy || !ready;
  $('motor-select').disabled = busy || !state.motors.length;
  $('calibrate').disabled = busy || !selectedMotor || !state.preview || !$('reviewed').checked;
  $('pick-calibration-output').disabled = busy;
  $('monitor').disabled = !selectedMotor || (!state.preview && !manual) || (busy && !manual);
  $('monitor').querySelector('.button-label').textContent = manual ? 'Stop monitoring' : 'Start monitoring';
  $('monitor').querySelector('use').setAttribute('href', manual ? '#i-stop' : '#i-play');
  $('jog-speed').max = String(maxJogSpeed());
  $('jog-speed-value').textContent = numberText(Number($('jog-speed').value), 2);
  $('jog-reviewed').disabled = !selectedMotor || (manual && (status?.enabled || status?.preparing));
  $('jog-speed').disabled = !selectedMotor || (manual && (status?.enabled || status?.preparing));
  $('enable-motor').disabled = !manual || !fresh || !healthy || !$('jog-reviewed').checked || status?.enabled || status?.preparing;
  for (const id of ['jog-reverse', 'jog-forward']) $(id).disabled = !manual || !fresh || !status?.enabled || status?.preparing;
  $('test-zero').disabled = !selectedMotor || (busy && (!manual || status?.enabled || status?.preparing));
  $('stop-motor').disabled = !selectedMotor || (busy && !manual);
  $('global-stop').disabled = !state.motor || state.busy === 'firmwareUpdate' || state.installingUpdate;
  for (const id of ['zero', 'set-id', 'firmware-check']) $(id).disabled = busy || !selectedMotor;
  const register = selectedRegister();
  const registerRead = state.registerRead?.index === register?.index && state.registerRead?.uuid === motorUuid();
  const registerValue = $('register-value').value.trim();
  const parsedValue = Number(registerValue);
  $('register-select').disabled = busy || !selectedMotor || !state.registers;
  $('register-read').disabled = busy || !selectedMotor || !register;
  $('register-value').disabled = busy || !selectedMotor || !register?.writable || !registerRead;
  $('register-value').min = register ? String(register.min) : '';
  $('register-value').max = register ? String(register.max) : '';
  $('register-write').disabled = busy || !selectedMotor || !register?.writable || !registerRead || !registerValue || !Number.isFinite(parsedValue) || parsedValue < register.min || parsedValue > register.max || parsedValue === state.registerRead.value;
  $('firmware-update').disabled = busy || !selectedMotor || !state.firmware || state.firmware.id !== state.motor?.id;
  $('refit').disabled = busy || !state.directory;
  $('show-run').disabled = !state.directory;
  $('copy-run').disabled = !state.directory;
  $('cancel').disabled = state.busy === 'firmwareUpdate' || manual;
  $('install-update').disabled = busy || state.installingUpdate;
  $('check-update').disabled = state.installingUpdate;
  $('jog-hint').textContent = status?.preparing ? 'Checking firmware watchdog…' : 'Hold to jog. Release to stop.';
  if (manual) {
    $('status-badge').textContent = status?.enabled ? 'Motor enabled' : status?.preparing ? 'Checking watchdog' : 'Monitoring';
    $('status-badge').className = `badge ${status?.enabled ? 'success' : ''}`;
  }
}

function resetMotor() {
  clearTimeout(previewTimer);
  state.previewSeq++;
  state.motors = [];
  state.motor = null;
  state.referenceAngle = 0;
  showReferenceAngle(0);
  state.preset = null;
  state.preview = null;
  state.firmware = null;
  clearRegisterRead();
  $('motor-select').replaceChildren(new Option('Scan to discover', ''));
  $('motor-details').textContent = 'No motor selected';
  $('preset').textContent = '';
  $('preset').classList.add('hidden');
  $('firmware-result').textContent = '';
  $('calibration-summary').textContent = '';
  $('motor-spec').textContent = '';
  $('protocol-spec').textContent = '';
  $('reviewed').checked = false;
  $('jog-reviewed').checked = false;
  renderSurface();
  updateControls();
}

function renderMotorDetails() {
  const motor = state.motor;
  $('motor-details').textContent = motor ? `${motor.model || 'Unknown model'} · firmware ${motor.firmware || 'unknown'} · UUID ${Array.isArray(motor.uuid) ? motor.uuid.map(value => Number(value).toString(16).padStart(2, '0')).join('').toUpperCase() : 'unknown'}${motor.issue ? ` · ${motor.issue}` : ''}` : 'No motor selected';
}

async function run(operation, params = {}) {
  notice('');
  try {
    return await window.motorApp.run(operation, params);
  } catch (error) {
    notice(error.message, true);
    throw error;
  }
}

async function refreshInterfaces() {
  const previous = selectedCan();
  try {
    state.interfaces = await run('interfaces');
    const select = $('can-select');
    select.replaceChildren(...state.interfaces.map(bus => new Option(bus.name, bus.name)));
    if (state.interfaces.some(bus => bus.name === previous)) select.value = previous;
    try {
      const ports = await run('serialPorts');
      updateSerialPorts(ports);
    } catch { updateSerialPorts([]); }
    try {
      updateUsbAdapters(await run('usbAdapters'));
    } catch { updateUsbAdapters([]); }
    resetMotor();
  } catch { /* notice already shown */ }
}

function updateUsbAdapters(adapters) {
  state.usbAdapters = Array.isArray(adapters) ? adapters.filter(adapter =>
    typeof adapter.id === 'string' && /^gsusb:(?:[0-9a-f]{2}){1,256}:[1-9][0-9]{0,2}$/.test(adapter.id)
      && typeof adapter.bus_id === 'string' && Number.isInteger(adapter.address)) : [];
  const select = $('gsusb-select');
  const previous = select.value;
  select.replaceChildren(
    new Option(state.usbAdapters.length ? 'Select an adapter' : 'No GS USB adapters found', ''),
    ...state.usbAdapters.map(adapter => {
      const value = adapter.id;
      const label = `${adapter.vendor_id.toString(16).padStart(4, '0')}:${adapter.product_id.toString(16).padStart(4, '0')} · USB ${adapter.bus_id ? `${adapter.bus_id}:` : ''}${adapter.address}`;
      return new Option(label, value);
    }),
  );
  if (state.usbAdapters.some(adapter => adapter.id === previous)) select.value = previous;
  else if (state.usbAdapters.length === 1) select.value = state.usbAdapters[0].id;
}

function updateSerialPorts(ports) {
  const select = $('slcan-port-select');
  const previous = select.value;
  const names = [...new Set((Array.isArray(ports) ? ports : []).filter(port => typeof port === 'string' && port))].sort();
  select.replaceChildren(
    new Option(names.length ? 'Select a port' : 'No ports detected', ''),
    ...names.map(port => new Option(port, port)),
    new Option('Enter manually…', 'manual'),
  );
  if (names.includes(previous)) select.value = previous;
  else if (previous === 'manual' || !names.length) select.value = 'manual';
  else if (names.length === 1) select.value = names[0];
  $('slcan-port').classList.toggle('hidden', select.value !== 'manual');
}

async function scan() {
  try {
    resetMotor();
    const motors = await run('scan', { can: selectedCan(), hostId: $('host-id').value });
    state.motors = motors;
    $('motor-select').replaceChildren(new Option(motors.length ? 'Select a motor' : 'No motors found', ''), ...motors.map(motor => new Option(`ID ${motor.id} · ${motor.model || 'Unknown model'}`, String(motor.id))));
    notice(motors.length ? `Found ${motors.length} motor${motors.length === 1 ? '' : 's'}.` : 'No motors found on this bus.');
    updateControls();
  } catch { /* notice already shown */ }
}

async function selectMotor() {
  state.motor = state.motors.find(motor => String(motor.id) === $('motor-select').value) || null;
  clearRegisterRead();
  state.referenceAngle = 0;
  showReferenceAngle(0);
  state.preset = null;
  state.firmware = null;
  $('reviewed').checked = false;
  $('jog-reviewed').checked = false;
  $('firmware-result').textContent = '';
  const motor = state.motor;
  renderMotorDetails();
  if (motor?.uuid) {
    try {
      const angle = await window.motorApp.getReferenceAngle(motor.uuid);
      if (state.motor !== motor) return;
      state.referenceAngle = angle;
      showReferenceAngle(angle);
    } catch (error) { notice(error.message, true); }
  }
  if (motor?.model && !motor.issue) {
    try {
      state.preset = await run('plan', { model: motor.model });
      const preset = state.preset;
      for (const [id, key] of configFields) $(id).value = preset[key];
      for (const [id, key] of baselineFields) $(id).value = preset.baseline[key];
      $('jog-speed').value = Math.min(maxJogSpeed(), 0.5).toFixed(2);
      $('preset').textContent = `${motor.model} preset`;
      $('preset').classList.remove('hidden');
      updateCalibrationSummary();
      schedulePreview();
    } catch { /* notice already shown */ }
  }
  renderSurface();
  updateControls();
}

function setTab(tab) {
  if (state.tab === 'test' && tab !== 'test' && state.busy === 'manual') stopMonitor();
  state.tab = tab;
  $('connection-panel').classList.toggle('hidden', tab === 'files');
  for (const button of document.querySelectorAll('[data-tab]')) button.classList.toggle('selected', button.dataset.tab === tab);
  for (const panel of document.querySelectorAll('.tab-panel')) panel.classList.toggle('hidden', panel.id !== `panel-${tab}`);
  if (tab === 'files') refreshRuns();
  if (tab === 'setup') { state.registersFailed = false; loadRegisters(); }
  renderSurface();
  updateControls();
}

function updateCalibrationSummary() {
  if (!state.preset) return;
  const speed = Number($('speed-limit').value);
  $('calibration-summary').textContent = `Torque ${numberText(Number($('torque-limit').value), 2)} Nm · speed cutoff ${numberText(speed, 2)} rad/s · target ±${numberText(speed * 0.75, 2)} rad/s · sweep ${$('sweep-start-hz').value}–${$('sweep-end-hz').value} Hz · travel ±${$('travel-limit').value} rad`;
  const ratedTorque = state.preview?.spec?.rated_torque;
  $('jog-limits').textContent = `Torque limit ${ratedTorque == null ? '—' : numberText(Math.min(Number($('torque-limit').value), ratedTorque * 0.1), 2)} Nm · travel ±${numberText(Math.min(Number($('travel-limit').value), 2 * Math.PI), 3)} rad from enable`;
}

let previewTimer;
function schedulePreview() {
  clearTimeout(previewTimer);
  const sequence = ++state.previewSeq;
  state.preview = null;
  updateControls();
  previewTimer = setTimeout(async () => {
    try {
      const preview = await window.motorApp.preview(buildConfig());
      if (sequence !== state.previewSeq) return;
      state.preview = preview;
      const spec = preview.spec;
      $('motor-spec').textContent = `${spec.rated_torque} Nm rated · ${spec.peak_torque} Nm peak · ${spec.no_load_rpm} rpm · ${spec.gear_ratio}:1 · ${spec.rated_voltage} V. Test limits are lower than motor ratings.`;
      $('protocol-spec').textContent = `Host ID ${$('host-id').value} · position ±${numberText(state.preset.profile.position_range, 3)} rad · speed ±${numberText(state.preset.profile.velocity_range, 2)} rad/s · torque ±${numberText(state.preset.profile.torque_range, 2)} Nm`;
      updateCalibrationSummary();
      updateControls();
      renderPreview();
    } catch { /* Editing an incomplete value leaves the last valid preview visible. */ }
  }, 220);
}

function renderPreview() {
  if (!state.preview || state.tab === 'test' || state.report) return;
  $('preview-title').textContent = `${state.motor?.model || 'Motor'} · calibration suite`;
  $('preview-segments').replaceChildren();
  for (const segment of state.preview.segments) {
    const item = document.createElement('div');
    item.className = 'subtle-card';
    const label = document.createElement('strong'); label.textContent = segment.name;
    const time = document.createElement('small'); time.textContent = `${numberText(segment.start, 0)}–${numberText(segment.end, 0)} s`;
    item.append(label, time); $('preview-segments').append(item);
  }
  requestAnimationFrame(() => drawPlot($('preview-chart'), [{ x: state.preview.t, y: state.preview.velocity, color: getComputedStyle(document.documentElement).getPropertyValue('--after') }]));
  const bursts = state.preview.torque.some(value => value !== 0);
  $('preview-torque-card').classList.toggle('hidden', !bursts);
  if (bursts) requestAnimationFrame(() => drawPlot($('preview-torque-chart'), [{ x: state.preview.t, y: state.preview.torque, color: getComputedStyle(document.documentElement).getPropertyValue('--before') }]));
}

function renderLive() {
  if (state.tab !== 'test') return;
  $('manual-identity').textContent = state.motor ? `${state.motor.model} · ID ${state.motor.id} · ${selectedCan()}` : 'Scan to select a motor for testing.';
  const status = state.manualStatus;
  const fresh = feedbackFresh();
  const label = status?.preparing ? 'Checking watchdog' : fresh && status?.faults ? 'Motor fault' : fresh && status?.enabled ? 'Enabled' : fresh ? 'Disabled' : 'No live feedback';
  $('manual-badge').textContent = label;
  $('manual-badge').className = `badge ${label === 'Enabled' ? 'success' : label === 'Motor fault' ? 'error' : ''}`;
  $('manual-reason').textContent = status?.error || status?.stop_reason || (fresh ? `Mode ${status.mode} · Faults 0x${Number(status.faults).toString(16).padStart(2, '0')}` : 'Start monitoring to see live motor feedback.');
  for (const [id, key, digits] of [['feedback-position', 'position_rad', 3], ['feedback-velocity', 'velocity_rad_s', 3], ['feedback-torque', 'torque_nm', 3], ['feedback-temp', 'temperature_c', 1]]) {
    $(id).textContent = fresh ? numberText(key === 'position_rad' ? status[key] + state.referenceAngle : status[key], digits) : '—';
  }
  const container = $('live-charts');
  container.replaceChildren();
  if (!state.manualHistory.length) return;
  const t = state.manualHistory.map(item => item.t);
  const color = getComputedStyle(document.documentElement).getPropertyValue('--measured');
  for (const [title, key] of [['Position · rad', 'position_rad'], ['Speed · rad/s', 'velocity_rad_s'], ['Torque · Nm', 'torque_nm']]) {
    plot(title, [{ x: t, y: state.manualHistory.map(item => key === 'position_rad' ? item[key] + state.referenceAngle : item[key]), color }], false, container);
  }
}

function sendManualIntent() {
  if (state.busy !== 'manual') return;
  if (!document.hasFocus() || document.hidden || state.tab !== 'test' || !$('jog-reviewed').checked) {
    state.wantEnabled = false;
    state.direction = 0;
  }
  if (state.manualIntentPending) { state.manualIntentDirty = true; return; }
  state.manualIntentPending = true;
  const value = { enabled: state.wantEnabled, direction: state.direction, speed: Number($('jog-speed').value), reviewed: $('jog-reviewed').checked };
  window.motorApp.manualIntent(value).catch(error => {
    state.wantEnabled = false;
    state.direction = 0;
    notice(error.message, true);
  }).finally(() => {
    state.manualIntentPending = false;
    if (state.manualIntentDirty) { state.manualIntentDirty = false; sendManualIntent(); }
  });
}

async function stopMonitor() {
  if (state.busy !== 'manual') return;
  state.wantEnabled = false;
  state.direction = 0;
  sendManualIntent();
  try { await window.motorApp.cancel(); await state.manualPromise; }
  catch (error) { notice(error.message, true); }
}

function eventReceived(event) {
  if (event.type === 'updateFailure') {
    $('app-version').textContent = event.version;
    $('update-status').textContent = event.message;
    $('settings-dialog').showModal();
  } else if (event.type === 'start') {
    state.busy = event.operation;
    $('work').classList.toggle('hidden', event.operation === 'manual');
    $('work-title').textContent = ({ interfaces: 'Checking interfaces', canUp: 'Bringing up CAN', canRestart: 'Restarting CAN', scan: 'Finding motors', plan: 'Loading preset', calibrate: 'Calibrating motor', manual: 'Monitoring motor', analyze: 'Refitting recording', firmwarePrepare: 'Verifying firmware', firmwareUpdate: 'Updating firmware' })[event.operation] || 'Working';
    $('work-message').textContent = '';
    $('work-percent').textContent = '';
    $('work-message').dataset.transferStarted = 'false';
    $('progress-bar').style.width = '0%';
    if (event.operation === 'manual') {
      state.manualStatus = null;
      state.manualHistory = [];
      state.lastStatusAt = 0;
      state.wantEnabled = false;
      state.manualEverEnabled = false;
      renderLive();
    } else {
      $('status-badge').textContent = 'Working';
      $('status-badge').className = 'badge warning';
    }
  } else if (event.type === 'progress') {
    const message = (event.message.split('\n').filter(Boolean).at(-1) || '').replace(/^\[[= ]{20}\]\s*/, '');
    const work = message.match(/^(?:Scanning|Recording|Fitting)\s+(\d+)%\s*·\s*(.*)$/);
    const firmware = message.match(/^(\d+)%\s+(.+)$/);
    $('work-message').textContent = work?.[2] || firmware?.[2] || message;
    if (event.transferStarted) $('work-message').dataset.transferStarted = 'true';
    const percent = work?.[1] || firmware?.[1];
    if (percent) {
      $('work-percent').textContent = `${percent}%`;
      $('progress-bar').style.width = `${Math.min(100, Number(percent))}%`;
    }
  } else if (event.type === 'manualStatus') {
    const value = event.value;
    const previouslyEnabled = state.manualEverEnabled;
    state.manualStatus = value;
    state.lastStatusAt = performance.now();
    if (value.enabled) state.manualEverEnabled = true;
    if (previouslyEnabled && !value.enabled && !value.preparing) {
      state.wantEnabled = false;
      state.direction = 0;
    }
    if (Number.isFinite(value.position_rad) && Number.isFinite(value.sample_t) && state.manualHistory.at(-1)?.sample_t !== value.sample_t) {
      state.manualHistory.push(value);
      while (state.manualHistory[0] && value.sample_t - state.manualHistory[0].sample_t > 30) state.manualHistory.shift();
    }
    if (performance.now() - state.lastLiveDraw > 100 || value.error) {
      state.lastLiveDraw = performance.now();
      renderLive();
    }
  } else if (event.type === 'feedback') {
    const value = event.value;
    $('feedback-position').textContent = numberText(value.position_rad, 2);
    $('feedback-velocity').textContent = numberText(value.velocity_rad_s, 2);
    $('feedback-torque').textContent = numberText(value.torque_nm, 2);
    $('feedback-temp').textContent = numberText(value.temperature_c, 1);
  } else if (event.type === 'finish') {
    if (event.operation === 'manual') {
      state.wantEnabled = false;
      state.direction = 0;
      state.manualPromise = null;
    }
    state.busy = null;
    $('work').classList.add('hidden');
    $('status-badge').textContent = event.cancelled ? 'Stopped' : event.ok ? motorReady() ? 'Connected' : 'Not connected' : 'Attention';
    $('status-badge').className = `badge ${event.ok || event.cancelled ? '' : 'error'}`;
    if (event.operation === 'manual') renderLive();
    if (state.tab === 'setup' && !state.registers && !state.registersLoading && !state.registersFailed) queueMicrotask(loadRegisters);
  } else if (event.type === 'error') notice(event.message, true);
  updateControls();
}

function openReport(result) {
  state.directory = result.directory;
  state.report = result.report;
  $('current-run').textContent = `Selected run · ${state.directory.split(/[\\/]/).at(-1)}`;
  $('current-run').title = state.directory;
  $('run-actions').classList.remove('hidden');
  for (const button of $('run-list').querySelectorAll('button')) {
    const active = button.dataset.directory === state.directory;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
  $('report-title').textContent = `${state.report.model} · ID ${state.report.motor_id}`;
  $('report-identity').textContent = [
    Array.isArray(state.report.motor_uuid) ? `UUID ${state.report.motor_uuid.map(value => Number(value).toString(16).padStart(2, '0')).join('').toUpperCase()}` : '',
    state.report.reference_angle_rad ? `Reference ${numberText(state.report.reference_angle_rad, 2)} rad` : '',
  ].filter(Boolean).join(' · ');
  $('result-badge').textContent = state.report.accepted ? 'Validated' : 'Needs improvement';
  $('result-badge').className = `badge ${state.report.accepted ? 'success' : 'warning'}`;
  renderParameters();
  renderReport();
  renderSurface();
  updateControls();
}

function renderParameters() {
  const container = $('parameters');
  container.replaceChildren();
  for (const [label, key, unit, scale] of [['Armature', 'armature', 'kg m²', 1], ['Damping', 'damping', 'Nm s/rad', 1], ['Friction', 'friction', 'Nm', 1], ['Delay', 'delay', 'ms', 1000]]) {
    const card = document.createElement('div');
    card.className = 'parameter';
    const title = document.createElement('span'); title.textContent = label;
    const value = document.createElement('strong'); value.textContent = numberText(state.report.fitted[key] * scale, 5);
    const before = document.createElement('small'); before.textContent = `Before ${numberText(state.report.baseline[key] * scale, 5)} ${unit}`;
    card.append(title, value, before);
    container.append(card);
  }
  const d = state.report.diagnostics || {};
  $('diagnostics').textContent = [`MuJoCo ${state.report.mujoco_version}`, `${d.moving_windows || 0} moving seed windows`, ...(state.report.warnings || [])].join('\n');
}

function plot(title, series, tall = false, container = $('charts')) {
  const card = document.createElement('section'); card.className = `chart-card card${tall ? ' tall' : ''}`;
  if (container.id === 'live-charts') card.classList.add('live-chart');
  const heading = document.createElement('h3'); heading.textContent = title;
  const canvas = document.createElement('canvas');
  card.append(heading, canvas);
  container.append(card);
  requestAnimationFrame(() => drawPlot(canvas, series));
}

function drawPlot(canvas, series) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  const theme = getComputedStyle(document.documentElement);
  ctx.scale(dpr, dpr);
  const left = 50, right = 16, top = 13, bottom = 32;
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const s of series) for (let i = 0; i < Math.min(s.x.length, s.y.length); i++) {
    const x = s.x[i], y = s.y[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
  }
  if (!Number.isFinite(xmin)) { ctx.fillStyle = theme.getPropertyValue('--plot-axis'); ctx.fillText('No plot data', left, top + 25); return; }
  if (xmin === xmax) xmax += 1;
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const pad = (ymax - ymin) * 0.08; ymin -= pad; ymax += pad;
  const xp = x => left + (x - xmin) / (xmax - xmin) * (width - left - right);
  const yp = y => top + (ymax - y) / (ymax - ymin) * (height - top - bottom);
  ctx.font = '11px Pretendard, sans-serif';
  ctx.fillStyle = theme.getPropertyValue('--plot-axis'); ctx.strokeStyle = theme.getPropertyValue('--plot-grid'); ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = top + i / 4 * (height - top - bottom);
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke();
    ctx.fillText((ymax - i / 4 * (ymax - ymin)).toFixed(2), 2, y + 3);
  }
  for (let i = 0; i <= 4; i++) {
    const x = left + i / 4 * (width - left - right);
    ctx.fillText((xmin + i / 4 * (xmax - xmin)).toFixed(1), x - 10, height - 8);
  }
  for (const s of series) {
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.7; ctx.beginPath();
    let begun = false;
    const stride = Math.max(1, Math.floor(s.x.length / Math.max(1000, width * 2)));
    for (let i = 0; i < Math.min(s.x.length, s.y.length); i += stride) {
      if (!Number.isFinite(s.x[i]) || !Number.isFinite(s.y[i])) continue;
      if (!begun) { ctx.moveTo(xp(s.x[i]), yp(s.y[i])); begun = true; }
      else ctx.lineTo(xp(s.x[i]), yp(s.y[i]));
    }
    ctx.stroke();
  }
}

function renderReport() {
  const report = state.report;
  if (!report) return;
  const replay = report.replays.find(item => item.name === state.trace);
  if (!replay) return;
  const referenceAngle = Number(report.reference_angle_rad) || 0;
  $('velocity-rmse').textContent = `${numberText(replay.post_velocity_rmse, 4)} rad/s`;
  $('velocity-before').textContent = `Before ${numberText(replay.pre_velocity_rmse, 4)} rad/s`;
  $('position-rmse').textContent = `${numberText(replay.post_position_rmse, 4)} rad`;
  $('position-before').textContent = `Before ${numberText(replay.pre_position_rmse, 4)} rad`;
  const visible = { measured: $('show-measured').checked, before: $('show-before').checked, after: $('show-after').checked };
  const theme = getComputedStyle(document.documentElement);
  const colors = Object.fromEntries(['measured', 'before', 'after'].map(name => [name, theme.getPropertyValue(`--${name}`)]));
  const series = (measured, before, after, residual = false, offset = 0) => [
    visible.measured && !residual && { x: replay.t, y: measured.map(value => value + offset), color: colors.measured },
    visible.before && { x: replay.t, y: residual ? before.map((v, i) => v - measured[i]) : before.map(value => value + offset), color: colors.before },
    visible.after && { x: replay.t, y: residual ? after.map((v, i) => v - measured[i]) : after.map(value => value + offset), color: colors.after },
  ].filter(Boolean);
  $('charts').replaceChildren();
  if (state.chart === 'motion') {
    plot('Velocity · rad/s', series(replay.measured_velocity, replay.pre_velocity, replay.post_velocity));
    plot('Position · rad', series(replay.measured_position, replay.pre_position, replay.post_position, false, referenceAngle));
  } else if (state.chart === 'residuals') {
    plot('Velocity residual · rad/s', series(replay.measured_velocity, replay.pre_velocity, replay.post_velocity, true));
    plot('Position residual · rad', series(replay.measured_position, replay.pre_position, replay.post_position, true));
  } else {
    plot('Torque · Nm', [
      { x: replay.command_t || [], y: replay.command_torque || [], color: colors.before },
      { x: replay.t, y: replay.reported_torque || [], color: colors.measured },
    ], true);
  }
}

async function refreshRuns() {
  try {
    const runs = await window.motorApp.listRuns();
    $('run-list').replaceChildren();
    $('run-empty').classList.toggle('hidden', runs.length > 0);
    for (const item of runs) {
      const button = document.createElement('button');
      button.dataset.directory = item.directory;
      button.title = item.directory;
      const primary = document.createElement('strong');
      primary.textContent = item.model ? `${item.model} · ID ${item.motorId}` : item.name;
      const detail = document.createElement('small');
      detail.textContent = Number.isFinite(item.timestamp)
        ? new Date(item.timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        : item.name;
      button.append(primary, detail);
      if (item.directory === state.directory) { button.classList.add('active'); button.setAttribute('aria-current', 'true'); }
      button.addEventListener('click', async () => {
        try { openReport(await window.motorApp.loadRun(item.directory)); notice(''); }
        catch (error) { notice(error.message, true); }
      });
      $('run-list').append(button);
    }
  } catch (error) { notice(error.message, true); }
}

function wire() {
  applyTheme();
  $('theme-select').onchange = () => {
    themeChoice = $('theme-select').value;
    try { localStorage.setItem(themeKey, themeChoice); }
    catch { /* The selected theme still applies for this session. */ }
    applyTheme();
  };
  window.motorApp.onEvent(eventReceived);
  window.motorApp.onUpdateProgress(message => { $('update-status').textContent = message; });
  $('open-settings').onclick = async () => {
    $('settings-dialog').showModal();
    try {
      const info = await window.motorApp.updateInfo();
      if (info.updateError) $('update-status').textContent = info.updateError;
      $('app-version').textContent = info.version;
    } catch (error) { $('update-status').textContent = error.message; }
  };
  $('close-settings').onclick = () => $('settings-dialog').close();
  $('check-update').onclick = async () => {
    $('check-update').disabled = true;
    $('update-status').textContent = 'Checking GitHub releases…';
    $('install-update').classList.add('hidden');
    try {
      const result = await window.motorApp.checkUpdate();
      state.updateCandidate = result.available ? result : null;
      $('update-status').textContent = result.available
        ? result.installable ? `Version ${result.version} is available.` : result.reason || `Version ${result.version} has no installer for this computer yet.`
        : 'You have the latest version.';
      $('install-update').classList.toggle('hidden', !result.installable);
      $('install-update').querySelector('.button-label').textContent = result.installMode === 'mac-dmg'
        ? `Open ${result.version} DMG` : `Install ${result.version}`;
    } catch (error) { $('update-status').textContent = error.message; }
    finally { $('check-update').disabled = false; updateControls(); }
  };
  $('install-update').onclick = async () => {
    state.installingUpdate = true;
    updateControls();
    $('update-status').textContent = 'Downloading update…';
    try { await window.motorApp.installUpdate(); }
    catch (error) { $('update-status').textContent = error.message; }
    finally { state.installingUpdate = false; updateControls(); }
  };
  if (window.motorApp.platform !== 'linux') {
    $('transport-select').value = 'slcan';
    $('transport-select').querySelector('option[value="socketcan"]').disabled = true;
  }
  $('slcan-port').placeholder = window.motorApp.platform === 'win32' ? 'COM3' : window.motorApp.platform === 'darwin' ? '/dev/cu.usbmodem…' : '/dev/ttyUSB0';
  $('transport-select').onchange = () => { resetMotor(); updateControls(); };
  $('slcan-port-select').onchange = () => {
    $('slcan-port').classList.toggle('hidden', $('slcan-port-select').value !== 'manual');
    resetMotor(); updateControls();
  };
  for (const id of ['slcan-port', 'slcan-profile', 'slcan-baud']) $(id).oninput = () => { resetMotor(); updateControls(); };
  $('gsusb-select').onchange = resetMotor;
  $('reference-angle-unit').onchange = () => {
    const radians = referenceAngleFromInput();
    referenceAngleUnit = $('reference-angle-unit').value;
    $('reference-angle-hint').textContent = referenceAngleUnit;
    $('reference-angle').placeholder = referenceAngleUnit === 'deg' ? 'e.g. 90' : 'e.g. 1.57';
    $('reference-angle').max = referenceAngleUnit === 'deg' ? String(100 * 180 / Math.PI) : '100';
    $('reference-angle').min = referenceAngleUnit === 'deg' ? String(-100 * 180 / Math.PI) : '-100';
    $('reference-angle').step = 'any';
    if (Number.isFinite(radians)) showReferenceAngle(radians);
  };
  $('refresh-interfaces').onclick = refreshInterfaces;
  $('can-select').onchange = resetMotor;
  $('host-id').onchange = resetMotor;
  $('can-up').onclick = async () => {
    const bus = state.interfaces.find(item => item.name === selectedCan());
    try { await run(bus?.up ? 'canRestart' : 'canUp', { can: selectedCan() }); await refreshInterfaces(); }
    catch { /* notice already shown */ }
  };
  $('scan').onclick = scan;
  $('motor-select').onchange = selectMotor;
  $('register-select').onchange = () => {
    clearRegisterRead();
    const register = selectedRegister();
    if (register) $('register-status').textContent = `0x${register.index.toString(16).toUpperCase()} · ${register.writable ? `editable · ${register.min}–${register.max}` : 'read only'}`;
    updateControls();
  };
  $('register-value').oninput = updateControls;
  $('register-read').onclick = async () => {
    const register = selectedRegister();
    if (!register) return;
    clearRegisterRead();
    const motor = state.motor;
    try {
      const result = await run('registerRead', { ...target(), index: register.index });
      if (state.motor !== motor || selectedRegister()?.index !== register.index || result.uuid !== motorUuid()) return;
      state.registerRead = result;
      $('register-value').value = String(result.value);
      $('register-status').textContent = `Current ${result.value}${register.writable ? ` · range ${register.min}–${register.max}` : ' · read only'}`;
      updateControls();
    } catch { /* notice already shown */ }
  };
  $('register-write').onclick = async () => {
    const register = selectedRegister();
    const prior = state.registerRead;
    const value = Number($('register-value').value);
    if (!register?.writable || !prior || prior.index !== register.index || prior.uuid !== motorUuid() || $('register-write').disabled) return;
    if (!window.confirm(`Save ${register.name} (0x${register.index.toString(16).toUpperCase()}) from ${prior.value} to ${value} on motor ID ${state.motor.id}?`)) return;
    const motor = state.motor;
    try {
      const result = await run('registerWrite', { ...target(), index: register.index, value, uuid: prior.uuid, expectedRaw: prior.raw, confirmed: true });
      if (state.motor !== motor || selectedRegister()?.index !== register.index) return;
      state.registerRead = result;
      $('register-value').value = String(result.value);
      $('register-status').textContent = `Saved ${result.value} · power cycle to verify persistence`;
      notice(`${register.name} saved. Power cycle the motor to verify persistence.`);
    } catch { clearRegisterRead(); }
    updateControls();
  };
  $('reviewed').onchange = updateControls;
  $('jog-reviewed').onchange = () => {
    if (!$('jog-reviewed').checked) { state.wantEnabled = false; state.direction = 0; sendManualIntent(); }
    updateControls();
  };
  for (const [id] of [...configFields, ...baselineFields]) $(id).oninput = () => {
    $('reviewed').checked = false;
    if (id === 'speed-limit') {
      $('jog-speed').value = Math.min(Number($('jog-speed').value), maxJogSpeed()).toFixed(2);
    }
    updateCalibrationSummary();
    schedulePreview();
    updateControls();
  };
  $('restore-preset').onclick = () => {
    if (!state.preset) return;
    for (const [id, key] of [['torque-limit', 'torque_limit'], ['speed-limit', 'speed_limit'], ['travel-limit', 'travel_limit'], ['sweep-start-hz', 'sweep_start_hz'], ['sweep-end-hz', 'sweep_end_hz']]) $(id).value = state.preset[key];
    $('reviewed').checked = false;
    updateCalibrationSummary(); schedulePreview(); updateControls();
  };
  $('pick-calibration-output').onclick = async () => {
    try {
      const directory = await window.motorApp.pickCalibrationOutput();
      if (!directory) return;
      state.outputDirectory = directory;
      $('calibration-output').textContent = directory;
      $('calibration-output').title = directory;
    } catch (error) { notice(error.message, true); }
  };
  $('calibrate').onclick = async () => {
    try {
      const result = await run('calibrate', { ...target(), reviewed: $('reviewed').checked, config: buildConfig(), output: state.outputDirectory });
      if (result?.cancelled) { notice('Calibration stopped. Motor disabled.'); return; }
      openReport(await window.motorApp.loadRun(result.directory));
      notice(result.accepted ? 'Calibration complete. Held-out validation passed.' : 'Candidate fit complete. Validation needs attention.');
      refreshRuns();
    } catch (error) { if (!$('notice').textContent) notice(error.message, true); }
  };
  $('monitor').onclick = () => {
    if (state.busy === 'manual') { stopMonitor(); return; }
    if (state.manualPromise) return;
    $('jog-reviewed').checked = false;
    state.manualPromise = run('manual', { ...target(), config: buildConfig() }).catch(() => null).finally(() => {
      state.manualPromise = null;
      state.wantEnabled = false;
      state.direction = 0;
      updateControls();
    });
  };
  $('jog-speed').oninput = () => { $('jog-speed-value').textContent = numberText(Number($('jog-speed').value), 2); };
  for (const [id, direction] of [['jog-reverse', -1], ['jog-forward', 1]]) {
    const button = $(id);
    button.onpointerdown = event => {
      if (event.button !== 0 || button.disabled) return;
      button.setPointerCapture(event.pointerId);
      state.direction = direction;
      sendManualIntent();
    };
    const release = () => { if (state.direction === direction) { state.direction = 0; sendManualIntent(); } };
    button.onpointerup = release;
    button.onpointercancel = release;
    button.onlostpointercapture = release;
    button.onkeydown = event => { if ((event.key === ' ' || event.key === 'Enter') && !button.disabled) { event.preventDefault(); state.direction = direction; sendManualIntent(); } };
    button.onkeyup = release;
    button.oncontextmenu = event => event.preventDefault();
  }
  $('enable-motor').onclick = () => {
    if ($('enable-motor').disabled) return;
    state.manualEverEnabled = false;
    state.wantEnabled = true;
    state.direction = 0;
    sendManualIntent();
    updateControls();
  };
  const disableMotor = async () => {
    if (state.busy === 'manual') {
      state.wantEnabled = false; state.direction = 0; sendManualIntent(); updateControls(); return;
    }
    if (state.busy) { try { await window.motorApp.cancel(); } catch (error) { notice(error.message, true); } return; }
    try { await run('stop', target()); notice('Motor disabled.'); } catch { /* notice already shown */ }
  };
  $('stop-motor').onclick = disableMotor;
  $('global-stop').onclick = disableMotor;
  const setZero = async (referenceAngle) => {
    if (!Number.isFinite(referenceAngle) || Math.abs(referenceAngle) > 100) { notice('Reference angle must be within ±100 rad', true); return; }
    if (!window.confirm(`Set the stationary motor’s current position as ${angleForInput(referenceAngle)} ${referenceAngleUnit} in this app? The motor itself will be set to zero.`)) return;
    if (state.busy === 'manual') await stopMonitor();
    try {
      await run('zero', { ...target(), confirmed: true });
      await window.motorApp.setReferenceAngle(state.motor.uuid, referenceAngle);
      state.referenceAngle = referenceAngle;
      showReferenceAngle(referenceAngle);
      renderLive();
      notice(`Motor zero set. Display angle here: ${angleForInput(referenceAngle)} ${referenceAngleUnit}.`);
    }
    catch (error) { notice(error.message, true); }
  };
  $('zero').onclick = () => setZero(referenceAngleFromInput());
  $('test-zero').onclick = () => setZero(0);
  $('set-id').onclick = async () => {
    const newId = $('new-id').value;
    if (!window.confirm(`Change motor ID ${state.motor.id} to ${newId}?`)) return;
    try { await run('setId', { ...target(), newId, confirmed: true }); notice('Motor ID changed. Scan again to verify.'); resetMotor(); } catch {}
  };
  $('firmware-check').onclick = async () => {
    try {
      state.firmware = await run('firmwarePrepare', target());
      $('firmware-result').textContent = `Downloaded and verified · installed ${state.firmware.current_version} → ${state.firmware.version}`;
      updateControls();
    } catch { /* notice already shown */ }
  };
  $('firmware-update').onclick = async () => {
    if (!window.confirm(`Update ${state.motor.model} · ID ${state.motor.id} from ${state.firmware.current_version} to ${state.firmware.version}? Keep power and USB connected until transfer finishes.`)) return;
    const motor = state.motor;
    try {
      const result = await run('firmwareUpdate', { ...target(), confirmed: true });
      if (result?.cancelled) { notice('Firmware preparation stopped.'); return; }
      if (state.motor !== motor || result.id !== motor.id) { notice('Firmware verified. Select the motor again.'); return; }
      motor.firmware = result.firmware;
      state.firmware = null;
      clearRegisterRead();
      state.manualStatus = null;
      state.manualHistory = [];
      $('firmware-result').textContent = `Installed and verified · ${result.firmware}`;
      $('reviewed').checked = false;
      $('jog-reviewed').checked = false;
      renderMotorDetails();
      renderSurface();
      updateControls();
      notice(`Firmware ${result.firmware} installed and verified. Motor disabled.`);
    } catch { /* notice already shown */ }
  };
  $('pick-run').onclick = async () => {
    try { const result = await window.motorApp.pickRun(); if (result) { openReport(result); setTab('files'); } }
    catch (error) { notice(error.message, true); }
  };
  $('refresh-runs').onclick = refreshRuns;
  $('show-run').onclick = () => window.motorApp.showRun(state.directory).catch(error => notice(error.message, true));
  $('copy-run').onclick = () => window.motorApp.copyRunPath(state.directory).then(() => notice('Folder path copied.')).catch(error => notice(error.message, true));
  $('refit').onclick = async () => {
    if (!window.confirm('Refit this recording? Analysis artifacts in the folder will be replaced.')) return;
    try { const result = await run('analyze', { directory: state.directory }); if (result?.cancelled) { notice('Refit stopped.'); return; } openReport(await window.motorApp.loadRun(state.directory)); notice('Recording refitted.'); }
    catch {}
  };
  $('cancel').onclick = () => window.motorApp.cancel().catch(error => notice(error.message, true));
  $('firmware-release').onclick = event => { event.preventDefault(); window.motorApp.openReleaseNotes().catch(error => notice(error.message, true)); };
  for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => setTab(button.dataset.tab);
  for (const button of document.querySelectorAll('[data-trace]')) button.onclick = () => { state.trace = button.dataset.trace; document.querySelectorAll('[data-trace]').forEach(b => b.classList.toggle('selected', b === button)); renderReport(); };
  for (const button of document.querySelectorAll('[data-chart]')) button.onclick = () => { state.chart = button.dataset.chart; document.querySelectorAll('[data-chart]').forEach(b => b.classList.toggle('selected', b === button)); renderReport(); };
  for (const id of ['show-measured', 'show-before', 'show-after']) $(id).onchange = renderReport;
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { renderReport(); renderPreview(); renderLive(); }, 120); });
  window.addEventListener('blur', () => { state.wantEnabled = false; state.direction = 0; sendManualIntent(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { state.wantEnabled = false; state.direction = 0; sendManualIntent(); } });
  window.addEventListener('pointerup', () => { if (state.direction) { state.direction = 0; sendManualIntent(); } });
  systemDark.addEventListener('change', () => { if (themeChoice === 'system') applyTheme(); });
  setInterval(() => {
    if (state.busy !== 'manual') return;
    sendManualIntent();
    updateControls();
    if (performance.now() - state.lastLiveDraw > 150) { state.lastLiveDraw = performance.now(); renderLive(); }
  }, 60);
  refreshInterfaces();
  refreshRuns();
}

wire();
