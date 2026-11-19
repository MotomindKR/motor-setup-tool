import { displayAngle } from "./format.mjs";

const operationNames = {
  interfaces: "Checking interfaces",
  usbAdapters: "Checking USB adapters",
  canUp: "Bringing up CAN",
  canRestart: "Restarting CAN",
  scan: "Finding motors",
  setId: "Changing motor ID",
  zero: "Setting motor zero",
  stop: "Disabling motor",
  plan: "Loading preset",
  calibrate: "Calibrating motor",
  manual: "Monitoring motor",
  analyze: "Refitting recording",
  firmwarePrepare: "Verifying firmware",
  firmwareUpdate: "Updating firmware",
  registerRead: "Reading register",
  registerWrite: "Saving register",
};
export const numberText = (value, digits = 3) =>
  Number.isFinite(value) ? value.toFixed(digits) : "—";
function readableError(message) {
  const text = String(message).replace(
    /^Error invoking remote method '[^']+':\s*/,
    "",
  );
  return text.replace(/^(?:Error:\s*)+/, "").trim();
}
export const uuidText = (motor) =>
  Array.isArray(motor?.uuid)
    ? motor.uuid
        .map((value) => Number(value).toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase()
    : "";
export function registerValueText(value, item) {
  if (item?.value_type === "float32") {
    for (let digits = 1; digits <= 9; digits++) {
      const text = String(Number(value.toPrecision(digits)));
      if (Math.fround(Number(text)) === Math.fround(value)) return text;
    }
  }
  return String(value);
}
export function selectedCan(s) {
  const c = s.connection;
  return c.transport === "gsusb"
    ? c.usb
    : c.transport === "socketcan"
      ? c.bus
      : "";
}
function busReady(s, platform) {
  if (s.connection.transport === "gsusb")
    return s.usbAdapters.some((a) => a.id === selectedCan(s) && a.accessible);
  if (s.connection.transport !== "socketcan" || platform !== "linux")
    return false;
  return s.interfaces.some(
    (b) =>
      b.name === selectedCan(s) &&
      b.up &&
      /^ERROR-(ACTIVE|WARNING|PASSIVE)$/.test(b.state),
  );
}
export function maxJogSpeed(config) {
  return Math.max(0.01, Math.min(Number(config?.speed_limit || 1) * 0.1, 1));
}

export function controls(s, platform, now = performance.now()) {
  const busy = Boolean(
    s.busy || s.refreshingAdapters || s.installingUpdate || s.fileOperation,
  );
  const ready = busReady(s, platform);
  const motor = Boolean(ready && s.motor?.model && !s.motor.issue);
  const manual = s.busy === "manual";
  const fresh = Boolean(
    manual && s.manualStatus?.fresh && now - s.lastStatusAt < 200,
  );
  const healthy = Boolean(
    fresh &&
      s.manualStatus.faults === 0 &&
      s.manualStatus.temperature_c < Number(s.config?.temperature_limit),
  );
  const r = s.registers?.find((r) => r.index === s.registerIndex);
  const read =
    r &&
    s.registerRead?.index === r.index &&
    s.registerRead?.uuid === uuidText(s.motor);
  const value = Number(s.registerValue);
  const newId = Number(s.newId);
  const changed =
    read &&
    (r.value_type === "float32"
      ? Math.fround(value) !== Math.fround(s.registerRead.value)
      : value !== s.registerRead.value);
  return {
    busy,
    ready,
    motor,
    manual,
    fresh,
    calibrate: !busy && motor && Boolean(s.preview) && s.reviewed,
    monitor: motor && (Boolean(s.preview) || manual) && (!busy || manual),
    enable:
      manual &&
      healthy &&
      s.jogReviewed &&
      !s.manualStatus?.enabled &&
      !s.manualStatus?.preparing,
    jog: Boolean(
      manual &&
        fresh &&
        s.manualStatus?.enabled &&
        !s.manualStatus?.preparing &&
        s.jogReviewed,
    ),
    zero:
      motor &&
      (!busy ||
        (manual && !s.manualStatus?.enabled && !s.manualStatus?.preparing)),
    disable:
      Boolean(s.motor) &&
      s.busy !== "firmwareUpdate" &&
      !s.refreshingAdapters &&
      !s.installingUpdate,
    changeId:
      !busy && motor && Number.isInteger(newId) &&
      newId >= 1 && newId <= 254 &&
      newId !== s.motor.id && newId !== Number(s.connection.hostId),
    updateFirmware: !busy && motor && Boolean(s.firmware && s.firmware.id === s.motor.id),
    registerRead: !busy && motor && Boolean(r?.readable),
    registerWrite:
      !busy &&
      motor &&
      Boolean(
        r?.readable &&
          r?.writable &&
          r?.editable &&
          read &&
          s.registerValue.trim() &&
          Number.isFinite(value) &&
          value >= r.min &&
          value <= r.max &&
          (r.value_type !== "uint8" || Number.isInteger(value)) &&
          changed,
      ),
  };
}

class OperationCancelled extends Error {}

function clearedMotorControls() {
  return {
    reviewed: false,
    jogReviewed: false,
    manualStatus: null,
    manualHistory: [],
    firmware: null,
    firmwareMessage: "",
    registerRead: null,
    registerValue: "",
    registerMessage: "",
  };
}

function emptyMotorSelection() {
  return {
    ...clearedMotorControls(),
    motors: [],
    motor: null,
    preset: null,
    limits: null,
    config: null,
    preview: null,
    previewLoading: false,
    referenceAngle: 0,
    referenceInput: "0",
    registers: null,
    registerIndex: null,
  };
}

export function createController(bridge, env = {}) {
  const now = env.now || (() => performance.now());
  const focused =
    env.focused || (() => document.hasFocus() && !document.hidden);
  const listeners = new Set();
  let s = {
    ...emptyMotorSelection(),
    tab: "calibrate",
    connection: {
      transport: bridge.platform === "linux" ? "socketcan" : "gsusb",
      bus: "",
      usb: "",
      hostId: "253",
    },
    interfaces: [],
    refreshingAdapters: false,
    usbAdapters: [],
    outputDirectory: null,
    busy: null,
    work: null,
    notice: null,
    connectionOpen: true,
    lastStatusAt: 0,
    jogSpeed: 0.5,
    referenceUnit: "rad",
    newId: "",
    registerSearch: "",
    runs: [],
    runsLoading: false,
    fileOperation: false,
    reportFiles: [],
    reportUuid: "",
    report: null,
    directory: null,
    trace: "validation",
    chart: "motion",
    visible: { measured: true, before: true, after: true },
    settingsOpen: false,
    version: "",
    updateMessage: "",
    updateResult: null,
    checkingUpdate: false,
    installingUpdate: false,
  };
  let sequence = 0,
    connectionEpoch = 0,
    previewTimer,
    manualPromise,
    manualEverEnabled = false;
  let wantEnabled = false,
    direction = 0,
    intentPending = false,
    intentDirty = false,
    disposed = false;
  const set = (patch) => {
    if (disposed) return;
    s = { ...s, ...patch };
    listeners.forEach((fn) => fn());
  };
  const notice = (message, error = false) =>
    set({
      notice: message
        ? {
            message: error ? readableError(message) : String(message),
            error,
          }
        : null,
    });
  const reportError = (error) => notice(error.message, !(error instanceof OperationCancelled));
  const target = () => ({
    can: selectedCan(s),
    hostId: s.connection.hostId,
    id: s.motor?.id,
    expectedUuid: uuidText(s.motor),
  });
  const flags = () => controls(s, bridge.platform, now());
  const buildConfig = () => {
    if (!s.config || !s.motor)
      throw new Error("Scan and select a motor first.");
    if ([...Object.values(s.config), ...Object.values(s.config.baseline)].includes(null))
      throw new Error("Fill in all calibration settings.");
    return {
      ...s.config,
      interface: selectedCan(s),
      host_id: Number(s.connection.hostId),
      motor_id: s.motor.id,
      reference_angle_rad: s.referenceAngle,
    };
  };
  async function run(operation, params = {}) {
    if (s.busy || s.installingUpdate)
      throw new Error("Wait for the current operation to finish.");
    set({
      busy: operation,
      work: {
        title: operationNames[operation],
        message: "",
        percent: null,
      },
      notice: null,
    });
    try {
      const result = await bridge.run(operation, params);
      if (result?.cancelled && operation !== "manual") {
        throw new OperationCancelled("Operation stopped.");
      }
      return result;
    } finally {
      set({ busy: null, work: null });
    }
  }
  function resetMotor(extra = {}) {
    clearTimeout(previewTimer);
    sequence++;
    connectionEpoch++;
    wantEnabled = false;
    direction = 0;
    set({ ...emptyMotorSelection(), ...extra });
  }
  function updateSelectedMotor(motor, changes, extra = {}) {
    if (s.motor !== motor) return false;
    const updated = { ...motor, ...changes };
    set({
      ...clearedMotorControls(),
      motor: updated,
      motors: s.motors.map((item) => (item.id === motor.id ? updated : item)),
      config: s.config ? { ...s.config, motor_id: updated.id } : null,
      newId: "",
      ...extra,
    });
    return true;
  }
  function applyConfig(config) {
    set({ config, reviewed: false, jogSpeed: Math.min(Number(s.jogSpeed), maxJogSpeed(config)) });
    schedulePreview();
  }
  function inputRadians() {
    const value = s.referenceInput.trim();
    return value ? Number(value) * (s.referenceUnit === "deg" ? Math.PI / 180 : 1) : NaN;
  }
  function referenceInput(radians, unit) {
    return Number.isFinite(radians) ? String(Number(displayAngle(radians, unit).toPrecision(12))) : "";
  }
  function schedulePreview() {
    clearTimeout(previewTimer);
    const request = ++sequence;
    set({ preview: null, previewLoading: Boolean(s.config) });
    if (!s.config) return;
    previewTimer = setTimeout(async () => {
      try {
        const preview = await bridge.preview(buildConfig());
        if (request === sequence) set({ preview, previewLoading: false });
      } catch (error) {
        if (request === sequence) {
          set({ previewLoading: false });
          reportError(error);
        }
      }
    }, env.previewDelay ?? 220);
  }
  let runListRequest = 0;
  async function refreshRuns() {
    const request = ++runListRequest;
    set({ runsLoading: true });
    try {
      const runs = await bridge.listRuns();
      if (request === runListRequest) set({ runs });
    } catch (error) {
      if (request === runListRequest) reportError(error);
    } finally {
      if (request === runListRequest) set({ runsLoading: false });
    }
  }
  async function refreshInterfaces() {
    if (flags().busy) return;
    const previousTarget = selectedCan(s);
    const hadMotor = Boolean(s.motor);
    set({ refreshingAdapters: true });
    try {
      const errors = [];
      const unavailable = (error) => {
        errors.push(error);
        return [];
      };
      const interfaces = bridge.platform === "linux"
        ? await run("interfaces").catch(unavailable)
        : [];
      const usbAdapters = (await run("usbAdapters").catch(unavailable)).filter(
        (a) =>
          typeof a.id === "string" &&
          /^gsusb:(?:[0-9a-f]{2}){1,256}:[1-9][0-9]{0,2}$/.test(a.id) &&
          typeof a.bus_id === "string" &&
          Number.isInteger(a.address),
      );
      const accessible = usbAdapters.filter((adapter) => adapter.accessible);
      const connection = {
        ...s.connection,
        bus: interfaces.some((item) => item.name === s.connection.bus)
          ? s.connection.bus
          : interfaces.find((item) => item.up)?.name ||
            interfaces[0]?.name ||
            "",
        usb: usbAdapters.some((item) => item.id === s.connection.usb)
          ? s.connection.usb
          : accessible.length === 1
            ? accessible[0].id
            : usbAdapters.length === 1
              ? usbAdapters[0].id
              : "",
      };
      if (
        !hadMotor &&
        connection.transport === "socketcan" &&
        !interfaces.length &&
        accessible.length === 1
      )
        connection.transport = "gsusb";
      const next = {
        usbAdapters,
        interfaces,
        connection,
      };
      const unavailableTarget =
        selectedCan({ ...s, ...next }) !== previousTarget ||
        !busReady({ ...s, ...next }, bridge.platform);
      if (unavailableTarget)
        resetMotor({ ...next, connectionOpen: true });
      else set(next);
      const removed = unavailableTarget && hadMotor;
      const messages = errors.map((error) => readableError(error.message));
      if (removed)
        messages.unshift("Adapter unavailable. Reconnect it, then scan.");
      if (messages.length)
        notice(
          messages.join(" "),
          removed || errors.some((error) => !(error instanceof OperationCancelled)),
        );
    } catch (error) {
      reportError(error);
    } finally {
      set({ refreshingAdapters: false });
    }
  }
  async function scan() {
    if (flags().busy || !flags().ready) return;
    resetMotor();
    try {
      const motors = await run("scan", {
        can: selectedCan(s),
        hostId: s.connection.hostId,
      });
      set({ motors });
      if (motors.length === 1) {
        await selectMotor(String(motors[0].id));
        return;
      }
      notice(
        motors.length
          ? `${motors.length} motors found. Select one.`
          : "No motors found. Check power and wiring.",
      );
    } catch (error) {
      reportError(error);
    }
  }
  async function selectMotor(id) {
    if (flags().busy) return;
    const motors = s.motors;
    const motor = motors.find((m) => String(m.id) === id) || null;
    if (motor && motor === s.motor && s.config) return;
    resetMotor({ motors, motor });
    const epoch = connectionEpoch;
    let referenceError;
    if (motor?.uuid) {
      try {
        const angle = await bridge.getReferenceAngle(motor.uuid);
        if (epoch !== connectionEpoch) return;
        set({
          referenceAngle: angle,
          referenceInput: String(displayAngle(angle, s.referenceUnit)),
        });
      } catch (error) {
        if (epoch !== connectionEpoch) return;
        referenceError = error;
      }
    }
    if (motor?.model && !motor.issue) {
      try {
        const { preset, limits, registers } = await run("plan", { model: motor.model });
        if (epoch !== connectionEpoch) return;
        set({
          preset,
          limits,
          registers,
          registerIndex: registers[0]?.index ?? null,
          config: preset,
          jogSpeed: Math.min(0.5, maxJogSpeed(preset)),
          connectionOpen: false,
        });
        schedulePreview();
      } catch (error) {
        reportError(error);
        return;
      }
    }
    if (referenceError) reportError(referenceError);
  }
  function sendIntent() {
    if (s.busy !== "manual") return;
    if (!focused() || s.tab !== "test" || !s.jogReviewed) {
      wantEnabled = false;
      direction = 0;
    }
    if (intentPending) {
      intentDirty = true;
      return;
    }
    intentPending = true;
    bridge
      .manualIntent({
        enabled: wantEnabled,
        direction,
        speed: Number(s.jogSpeed),
        reviewed: s.jogReviewed,
      })
      .catch((error) => {
        wantEnabled = false;
        direction = 0;
        reportError(error);
      })
      .finally(() => {
        intentPending = false;
        if (intentDirty) {
          intentDirty = false;
          sendIntent();
        }
      });
  }
  const release = () => {
    direction = 0;
    sendIntent();
  };
  const revoke = () => {
    wantEnabled = false;
    direction = 0;
    sendIntent();
  };
  async function stopMonitor() {
    if (s.busy !== "manual") return;
    revoke();
    try {
      await bridge.cancel();
      await manualPromise;
    } catch (error) {
      reportError(error);
    }
  }
  function eventReceived(event) {
    if (event.type === "updateChecked") set({ updateResult: event.result });
    else if (event.type === "updateFailure")
      set({
        settingsOpen: true,
        version: event.version,
        updateMessage: event.message,
      });
    else if (event.type === "progress") {
      if (!s.busy) return;
      set({ work: { ...s.work, message: event.message, percent: event.percent } });
    } else if (event.type === "manualStatus") {
      const value = event.value;
      if (manualEverEnabled && !value.enabled && !value.preparing) {
        wantEnabled = false;
        direction = 0;
      }
      if (value.enabled) manualEverEnabled = true;
      let history = s.manualHistory;
      if (
        Number.isFinite(value.position_rad) &&
        Number.isFinite(value.sample_t) &&
        history.at(-1)?.sample_t !== value.sample_t
      ) {
        history = [
          ...history.filter((v) => value.sample_t - v.sample_t <= 30),
          value,
        ];
      }
      set({ manualStatus: value, lastStatusAt: now(), manualHistory: history });
    } else if (event.type === "error") notice(event.message, true);
  }
  async function openRun(directory, showFiles = true) {
    if (flags().busy) return false;
    const tab = s.tab;
    set({ fileOperation: true });
    try {
      const result = directory
        ? await bridge.loadRun(directory)
        : await bridge.pickRun();
      if (!result) return false;
      set({
        tab: showFiles && s.tab === tab ? "files" : s.tab,
        directory: result.directory,
        report: result.report,
        reportFiles: result.files,
        reportUuid: result.uuid,
        trace: "validation",
        chart: "motion",
        notice: null,
      });
      if (!directory) refreshRuns();
      return true;
    } catch (error) {
      reportError(error);
      return false;
    } finally {
      set({ fileOperation: false });
    }
  }
  async function setTab(tab) {
    if (!["calibrate", "test", "setup", "files"].includes(tab)) return;
    if (s.tab === "test" && tab !== "test") await stopMonitor();
    set({ tab, notice: s.notice?.error ? s.notice : null });
    if (tab === "files") refreshRuns();
  }
  let confirmation = null;
  function confirmAction(title, description, action, destructive = false) {
    confirmation = action;
    set({ confirmation: { title, description, destructive } });
  }
  const actions = {
    setTab,
    refreshInterfaces,
    scan,
    selectMotor,
    refreshRuns,
    openRun,
    async exportRun(directory = s.directory, file = null) {
      if (!directory || flags().busy) return;
      set({ fileOperation: true });
      try {
        const result = await bridge.exportRun(directory, file);
        if (result) notice(`Downloaded ${file || "calibration run"}.`);
      } catch (error) {
        reportError(error);
      } finally {
        set({ fileOperation: false });
      }
    },
    deleteRun(directory = s.directory) {
      if (!directory || flags().busy) return;
      const run = s.runs.find((item) => item.directory === directory);
      confirmAction(
        "Delete this run?",
        `Permanently delete its recordings and calibration files.\n${run?.model || s.report?.model || "Calibration run"}${run?.motorId ? ` · ID ${run.motorId}` : ""}\n${directory}`,
        async () => {
          if (flags().busy) return;
          set({ fileOperation: true });
          try {
            await bridge.deleteRun(directory);
            ++runListRequest;
            if (s.directory === directory)
              set({ directory: null, report: null, reportFiles: [], reportUuid: "" });
            set({
              runsLoading: false,
              runs: s.runs.filter((item) => item.directory !== directory),
            });
            notice("Run deleted.");
          } finally {
            set({ fileOperation: false });
          }
        },
        true,
      );
    },
    dismissNotice: () => notice(""),
    toggleConnection: () => set({ connectionOpen: !s.connectionOpen }),
    changeConnection(key, value) {
      if (flags().busy) return;
      if (!["transport", "bus", "usb", "hostId"].includes(key)) return;
      if (
        key === "transport" &&
        value !== "gsusb" &&
        (value !== "socketcan" || bridge.platform !== "linux")
      )
        return;
      if (s.connection[key] === value) return;
      resetMotor({ connection: { ...s.connection, [key]: value } });
    },
    async restartCan() {
      if (flags().busy) return;
      const bus = s.interfaces.find((b) => b.name === s.connection.bus);
      if (!bus) return;
      try {
        await run(bus.up ? "canRestart" : "canUp", { can: bus.name });
        await refreshInterfaces();
      } catch (error) {
        reportError(error);
      }
    },
    changeConfig(key, value, baseline = false) {
      if (!s.config || flags().busy) return;
      const numeric = value === "" ? null : Number(value);
      const config = baseline
        ? { ...s.config, baseline: { ...s.config.baseline, [key]: numeric } }
        : { ...s.config, [key]: numeric };
      applyConfig(config);
    },
    restorePreset() {
      if (s.preset && !flags().busy) applyConfig(s.preset);
    },
    review: (value) => {
      if (!flags().busy) set({ reviewed: value });
    },
    async pickOutput() {
      try {
        const outputDirectory = await bridge.pickCalibrationOutput();
        if (outputDirectory) set({ outputDirectory });
      } catch (error) {
        reportError(error);
      }
    },
    async calibrate() {
      if (!flags().calibrate) return;
      try {
        const output = s.outputDirectory;
        const config = buildConfig();
        const reviewed = s.reviewed;
        set({ outputDirectory: null, reviewed: false });
        const result = await run("calibrate", {
          ...target(),
          reviewed,
          config,
          output,
        });
        const opened = await openRun(result.directory, s.tab === "calibrate");
        if (opened && !result.accepted) notice("Validation failed. Check the results.");
      } catch (error) {
        reportError(error);
      } finally {
        if (s.tab === "files") refreshRuns();
      }
    },
    async monitor() {
      if (!flags().monitor) return;
      if (s.busy === "manual") return stopMonitor();
      if (manualPromise) return;
      wantEnabled = false;
      direction = 0;
      manualEverEnabled = false;
      set({
        jogReviewed: false,
        manualStatus: null,
        manualHistory: [],
        lastStatusAt: 0,
      });
      manualPromise = run("manual", { ...target(), config: buildConfig() })
        .catch(reportError)
        .finally(() => {
          manualPromise = null;
          wantEnabled = false;
          direction = 0;
          set({});
        });
    },
    reviewJog(value) {
      set({ jogReviewed: value });
      if (!value) revoke();
    },
    setJogSpeed(value) {
      if (!s.manualStatus?.enabled && !s.manualStatus?.preparing)
        set({
          jogSpeed: Math.min(maxJogSpeed(s.config), Math.max(0.01, Number(value))),
        });
    },
    enable() {
      if (!flags().enable) return;
      manualEverEnabled = false;
      wantEnabled = true;
      direction = 0;
      sendIntent();
    },
    jog(value) {
      if (!flags().jog) return;
      direction = value;
      sendIntent();
    },
    release,
    revoke,
    async disable() {
      if (!flags().disable) return;
      if (s.busy === "manual") {
        revoke();
        return;
      }
      if (s.busy) {
        try {
          await bridge.cancel();
        } catch (error) {
          reportError(error);
        }
        return;
      }
      try {
        await run("stop", target());
        notice("Motor disabled.");
      } catch (error) {
        reportError(error);
      }
    },
    cancel: () => {
      if (s.busy !== "firmwareUpdate")
        bridge.cancel().catch(reportError);
    },
    setReferenceInput: (value) => set({ referenceInput: value }),
    setReferenceUnit(unit) {
      set({ referenceUnit: unit, referenceInput: referenceInput(inputRadians(), unit) });
    },
    zero(test = false) {
      if (!flags().zero) return;
      const angle = test ? 0 : inputRadians();
      if (!Number.isFinite(angle) || Math.abs(angle) > 100) {
        notice("Reference angle must be within ±100 rad.", true);
        return;
      }
      const motor = s.motor;
      confirmAction(
        "Set current position?",
        `Set the stationary motor’s current position to zero. The app will display ${numberText(angle, 3)} rad at this position.`,
        async () => {
          if (s.motor !== motor || !flags().zero) return;
          if (s.busy === "manual") await stopMonitor();
          if (s.motor !== motor || flags().busy) return;
          await run("zero", { ...target(), confirmed: true });
          await bridge.setReferenceAngle(motor.uuid, angle);
          if (s.motor !== motor) return;
          set({
            referenceAngle: angle,
            referenceInput: referenceInput(angle, s.referenceUnit),
          });
          notice("Motor zero and display angle saved.");
        },
      );
    },
    setNewId: (value) => set({ newId: value }),
    changeId() {
      const newId = Number(s.newId);
      if (!flags().changeId) return;
      const motor = s.motor;
      const params = target();
      confirmAction(
        "Change motor ID?",
        `Change motor ID ${motor.id} to ${newId}. The app verifies the motor at its new address.`,
        async () => {
          if (s.motor !== motor || flags().busy) return;
          const result = await run("setId", {
            ...params,
            newId,
            confirmed: true,
          });
          if (result?.previous_id !== motor.id || result.id !== newId)
            throw new Error("The motor’s new ID could not be verified.");
          if (updateSelectedMotor(motor, { id: result.id }))
            notice(`Motor ID changed to ${result.id}.`);
        },
      );
    },
    async prepareFirmware() {
      if (flags().busy || !flags().motor) return;
      const motor = s.motor;
      set({ firmware: null, firmwareMessage: "" });
      try {
        const firmware = await run("firmwarePrepare", target());
        if (s.motor !== motor) return;
        if (firmware.id !== motor.id || firmware.model !== motor.model || uuidText(firmware) !== uuidText(motor))
          throw new Error("The motor at this ID has changed. Scan again before updating firmware.");
        set({
          firmware,
          firmwareMessage: `Verified · installed ${firmware.current_version} → ${firmware.version}`,
        });
      } catch (error) {
        reportError(error);
      }
    },
    updateFirmware() {
      if (!flags().updateFirmware) return;
      const motor = s.motor;
      const params = target();
      const prepared = s.firmware;
      confirmAction(
        "Update motor firmware?",
        `Update ${motor.model} · ID ${motor.id} from ${s.firmware.current_version} to ${s.firmware.version}. Keep power and USB connected until the transfer finishes.`,
        async () => {
          if (s.motor !== motor || s.firmware !== prepared || flags().busy) return;
          const result = await run("firmwareUpdate", {
            ...params,
            prepared,
            confirmed: true,
          });
          if (
            result?.id !== motor.id ||
            result.firmware !== prepared.version
          )
            throw new Error("The installed firmware could not be verified.");
          if (
            !updateSelectedMotor(
              motor,
              { firmware: result.firmware },
              {
                firmwareMessage: `Installed and verified · ${result.firmware}`,
              },
            )
          )
            return;
          notice(
            `Firmware ${result.firmware} installed and verified. Motor disabled.`,
          );
        },
        true,
      );
    },
    releaseNotes: () =>
      bridge.openReleaseNotes(s.motor?.model).catch(reportError),
    selectRegister(index) {
      set({
        registerIndex: index,
        registerRead: null,
        registerValue: "",
        registerMessage: "",
      });
    },
    searchRegisters: (query) => set({ registerSearch: query }),
    setRegisterValue: (value) => set({ registerValue: value }),
    async readRegister() {
      if (!flags().registerRead) return;
      const index = s.registerIndex,
        motor = s.motor;
      set({ registerRead: null, registerValue: "", registerMessage: "" });
      try {
        const result = await run("registerRead", {
          ...target(),
          model: s.motor.model,
          index,
        });
        if (
          s.motor !== motor ||
          s.registerIndex !== index ||
          result.uuid !== uuidText(motor)
        )
          return;
        set({
          registerRead: result,
          registerValue: registerValueText(
            result.value,
            s.registers.find((r) => r.index === index),
          ),
        });
      } catch (error) {
        reportError(error);
      }
    },
    writeRegister() {
      if (!flags().registerWrite) return;
      const r = s.registers.find((r) => r.index === s.registerIndex),
        prior = s.registerRead,
        value = Number(s.registerValue),
        motor = s.motor;
      confirmAction(
        "Save register to motor?",
        `Write ${r.name} (0x${r.index.toString(16).toUpperCase()}) from ${registerValueText(prior.value, r)} to ${registerValueText(value, r)} on motor ID ${motor.id}, then save motor settings to flash. This also saves other pending persistent settings.`,
        async () => {
          if (s.motor !== motor || s.registerRead !== prior || s.registerIndex !== r.index || flags().busy) return;
          try {
            const result = await run("registerWrite", {
              ...target(),
              model: motor.model,
              index: r.index,
              value,
              uuid: prior.uuid,
              expectedRaw: prior.raw,
              confirmed: true,
            });
            if (s.motor !== motor || s.registerIndex !== r.index) return;
            set({
              registerRead: result,
              registerValue: registerValueText(result.value, r),
              registerMessage:
                "Saved. Power cycle the motor to verify persistence.",
            });
            notice(
              `${r.name} saved. Power cycle the motor to verify persistence.`,
            );
          } catch (error) {
            set({ registerRead: null, registerValue: "" });
            throw error;
          }
        },
      );
    },
    setTrace: (trace) => set({ trace }),
    setChart: (chart) => set({ chart }),
    toggleSeries: (key) =>
      set({ visible: { ...s.visible, [key]: !s.visible[key] } }),
    showFolder: () =>
      bridge.showRun(s.directory).catch(reportError),
    copyPath: () =>
      bridge
        .copyRunPath(s.directory)
        .then(() => notice("Folder path copied."))
        .catch(reportError),
    refit() {
      const directory = s.directory;
      if (!directory || flags().busy || !s.reportFiles.includes("session.json")) return;
      confirmAction(
        "Refit this recording?",
        "Analysis artifacts in this folder will be replaced. The original recorded samples are preserved.",
        async () => {
          if (s.directory !== directory || flags().busy) return;
          await run("analyze", { directory });
          if (await openRun(directory, false)) {
            await refreshRuns();
            notice("Recording refitted.");
          }
        },
      );
    },
    closeConfirmation: () => {
      confirmation = null;
      set({ confirmation: null });
    },
    async confirm() {
      const action = confirmation;
      confirmation = null;
      set({ confirmation: null });
      try {
        await action?.();
      } catch (error) {
        reportError(error);
      }
    },
    openSettings: () => set({ settingsOpen: true }),
    closeSettings: () => set({ settingsOpen: false }),
    async checkUpdate() {
      if (s.checkingUpdate || s.installingUpdate) return;
      set({
        checkingUpdate: true,
        updateMessage: "Checking for updates…",
      });
      try {
        const result = await bridge.checkUpdate();
        set({ updateResult: result, updateMessage: "" });
      } catch (error) {
        set({ updateMessage: readableError(error.message) });
      } finally {
        set({ checkingUpdate: false });
      }
    },
    async installUpdate(version) {
      if (flags().busy || s.checkingUpdate || !s.updateResult?.available) return;
      if (s.updateResult.version !== version) return;
      set({
        installingUpdate: true,
        updateMessage: s.updateResult.releasePage ? "" : "Downloading update…",
      });
      try {
        await bridge.installUpdate(version);
      } catch (error) {
        set({ updateMessage: readableError(error.message) });
      } finally {
        set({ installingUpdate: false });
      }
    },
  };
  function start() {
    const offEvent = bridge.onEvent(eventReceived);
    const offUpdate = bridge.onUpdateProgress((message) =>
      set({ updateMessage: message }),
    );
    bridge
      .updateInfo()
      .then((info) => {
        set({
          version: info.version,
          updateResult: s.updateResult ?? info.updateResult ?? null,
          updateMessage: s.updateMessage || info.updateError || "",
        });
      })
      .catch(() => {});
    const timer = setInterval(() => {
      if (s.busy === "manual") {
        sendIntent();
        set({});
      }
    }, 60);
    refreshInterfaces();
    return () => {
      revoke();
      disposed = true;
      clearInterval(timer);
      clearTimeout(previewTimer);
      offEvent();
      offUpdate();
    };
  }
  return {
    getSnapshot: () => s,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    actions,
    start,
    platform: bridge.platform,
  };
}
