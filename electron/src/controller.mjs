// Owns the Electron bridge and motor intent lease. Rendering never sends commands.
export const configFields = [
  ["torque_limit", "Torque limit", "Nm", 0.001, undefined, 0.01],
  ["speed_limit", "Speed cutoff", "rad/s", 0.001, undefined, 0.1],
  ["travel_limit", "Travel limit", "±rad", 0.001, undefined, 0.5],
  ["temperature_limit", "Temperature cutoff", "°C", 20, 70, 1],
  ["train_seconds", "Training duration", "s", 20, 60, 1],
  ["validation_seconds", "Validation duration", "s", 10, 60, 1],
  ["sample_hz", "Sample rate", "Hz", 50, 500, 10],
  ["sweep_start_hz", "Sweep start", "Hz", 0.05, 20, 0.05],
  ["sweep_end_hz", "Sweep end", "Hz", 0.1, 20, 0.1],
];
export const baselineFields = [
  ["armature", "Armature", "kg m²", 0.000001, 5, 0.001],
  ["damping", "Damping", "Nm s/rad", 0, 10, 0.001],
  ["friction", "Friction", "Nm", 0, 100, 0.001],
  ["delay", "Delay", "s", 0, 0.1, 0.001],
];
export const operationNames = {
  interfaces: "Checking interfaces",
  usbAdapters: "Checking USB adapters",
  canUp: "Bringing up CAN",
  canRestart: "Restarting CAN",
  scan: "Finding motors",
  plan: "Loading preset",
  calibrate: "Calibrating motor",
  manual: "Monitoring motor",
  analyze: "Refitting recording",
  firmwarePrepare: "Verifying firmware",
  firmwareUpdate: "Updating firmware",
  registerList: "Loading registers",
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
  const lines = text.split("\n");
  const start = lines.findLastIndex((line) => /^Error:/.test(line.trim()));
  return (start < 0 ? text : lines.slice(start).join("\n"))
    .replace(/^(?:Error:\s*)+/, "")
    .trim();
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
export function busReady(s, platform) {
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
    healthy,
    calibrate: !s.report && !busy && motor && Boolean(s.preview) && s.reviewed,
    monitor: motor && (Boolean(s.preview) || manual) && (!busy || manual),
    enable:
      manual &&
      fresh &&
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

export function createController(bridge, env = {}) {
  const now = env.now || (() => performance.now());
  const focused =
    env.focused || (() => document.hasFocus() && !document.hidden);
  const listeners = new Set();
  let s = {
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
    motors: [],
    motor: null,
    preset: null,
    config: null,
    preview: null,
    previewLoading: false,
    reviewed: false,
    outputDirectory: null,
    busy: null,
    work: null,
    notice: null,
    connectionOpen: true,
    manualStatus: null,
    manualHistory: [],
    lastStatusAt: 0,
    jogReviewed: false,
    jogSpeed: 0.5,
    referenceAngle: 0,
    referenceInput: "0",
    referenceUnit: "rad",
    newId: "",
    firmware: null,
    firmwareMessage: "",
    registers: null,
    registersFailed: false,
    registerIndex: null,
    registerRead: null,
    registerValue: "",
    registerMessage: "",
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
    updateCandidate: null,
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
  const target = () => ({
    can: selectedCan(s),
    hostId: s.connection.hostId,
    id: s.motor?.id,
  });
  const flags = () => controls(s, bridge.platform, now());
  const buildConfig = () => {
    if (!s.config || !s.motor)
      throw new Error("Scan and select a motor first.");
    const config = structuredClone(s.config);
    for (const [key] of configFields) config[key] = Number(config[key]);
    for (const [key] of baselineFields)
      config.baseline[key] = Number(config.baseline[key]);
    return {
      ...config,
      interface: selectedCan(s),
      host_id: Number(s.connection.hostId),
      motor_id: s.motor.id,
      reference_angle_rad: s.referenceAngle,
      baseline: { ...config.baseline, static_friction: 0 },
      experiment: "Mixed",
      excitation_revision: 1,
    };
  };
  async function run(operation, params = {}) {
    if (s.busy || s.installingUpdate)
      throw new Error("Wait for the current operation to finish.");
    set({
      busy: operation,
      work: {
        title: operationNames[operation] || "Working",
        message: "",
        percent: null,
      },
      notice: null,
    });
    try {
      return await bridge.run(operation, params);
    } catch (error) {
      notice(error.message, true);
      throw error;
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
    set({
      motors: [],
      motor: null,
      preset: null,
      config: null,
      preview: null,
      previewLoading: false,
      reviewed: false,
      jogReviewed: false,
      referenceAngle: 0,
      referenceInput: "0",
      firmware: null,
      firmwareMessage: "",
      registerRead: null,
      registers: null,
      registersFailed: false,
      registerValue: "",
      registerMessage: "",
      manualStatus: null,
      manualHistory: [],
      ...extra,
    });
  }
  function updateSelectedMotor(motor, changes, extra = {}) {
    if (s.motor !== motor) return false;
    const updated = { ...motor, ...changes };
    set({
      motor: updated,
      motors: s.motors.map((item) => (item.id === motor.id ? updated : item)),
      config: s.config ? { ...s.config, motor_id: updated.id } : null,
      newId: "",
      firmware: null,
      firmwareMessage: "",
      registerRead: null,
      registerValue: "",
      registerMessage: "",
      manualStatus: null,
      manualHistory: [],
      reviewed: false,
      jogReviewed: false,
      ...extra,
    });
    return true;
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
          notice(error.message, true);
        }
      }
    }, env.previewDelay ?? 220);
  }
  async function refreshRuns() {
    set({ runsLoading: true });
    try {
      set({ runs: await bridge.listRuns() });
    } catch (error) {
      notice(error.message, true);
    } finally {
      set({ runsLoading: false });
    }
  }
  async function refreshInterfaces() {
    if (flags().busy) return;
    const previousTarget = selectedCan(s);
    const hadMotor = Boolean(s.motor);
    set({ refreshingAdapters: true });
    try {
      const interfaces = await run("interfaces");
      const usbAdapters = (await run("usbAdapters")).filter(
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
      if (
        selectedCan({ ...s, ...next }) !== previousTarget ||
        !busReady({ ...s, ...next }, bridge.platform)
      ) {
        resetMotor({ ...next, connectionOpen: true });
        if (hadMotor)
          notice("Adapter unavailable. Reconnect it, then scan.", true);
      } else set(next);
    } catch {
      /* run reports bridge errors */
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
    } catch {
      /* run reports bridge errors */
    }
  }
  async function selectMotor(id) {
    if (flags().busy) return;
    const motors = s.motors;
    const motor = motors.find((m) => String(m.id) === id) || null;
    if (motor && motor === s.motor && s.config) return;
    resetMotor({ motors, motor });
    const epoch = connectionEpoch;
    if (motor?.uuid) {
      try {
        const angle = await bridge.getReferenceAngle(motor.uuid);
        if (epoch !== connectionEpoch) return;
        set({
          referenceAngle: angle,
          referenceInput: String(
            s.referenceUnit === "deg" ? (angle * 180) / Math.PI : angle,
          ),
        });
      } catch (error) {
        notice(error.message, true);
      }
    }
    if (motor?.model && !motor.issue) {
      try {
        const preset = await run("plan", { model: motor.model });
        if (epoch !== connectionEpoch) return;
        set({
          preset,
          config: structuredClone(preset),
          jogSpeed: Math.min(0.5, maxJogSpeed(preset)),
          connectionOpen: false,
        });
        schedulePreview();
      } catch {
        /* run reports bridge errors */
      }
    }
  }
  function maxJogSpeed(config = s.config) {
    return Math.max(0.01, Math.min(Number(config?.speed_limit || 1) * 0.1, 1));
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
        notice(error.message, true);
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
      notice(error.message, true);
    }
  }
  let registersLoading = false;
  async function loadRegisters() {
    if (
      registersLoading ||
      s.registers ||
      flags().busy ||
      s.registersFailed ||
      !s.motor?.model
    )
      return;
    registersLoading = true;
    try {
      const model = s.motor.model;
      const registers = await run("registerList", { model });
      if (s.motor?.model !== model) return;
      set({ registers, registerIndex: registers[0]?.index ?? null });
    } catch {
      set({ registersFailed: true });
    } finally {
      registersLoading = false;
    }
  }
  function eventReceived(event) {
    if (event.type === "updateFailure")
      set({
        settingsOpen: true,
        version: event.version,
        updateMessage: event.message,
      });
    else if (event.type === "progress") {
      if (!s.busy) return;
      const message = (
        event.message.split("\n").filter(Boolean).at(-1) || ""
      ).replace(/^\[[= ]{20}\]\s*/, "");
      const match =
        message.match(/^(?:Scanning|Recording|Fitting)\s+(\d+)%\s*·\s*(.*)$/) ||
        message.match(/^(\d+)%\s+(.+)$/);
      set({
        work: {
          ...s.work,
          message: match?.[2] || message,
          percent: match ? Math.min(100, Number(match[1])) : s.work?.percent,
        },
      });
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
    // The operation promise owns busy state; a finish event may precede its result.
  }
  function openReport(result) {
    set({
      directory: result.directory,
      report: result.report,
      reportFiles: result.files || [],
      reportUuid:
        result.uuid ||
        (result.report.motor_uuid
          ? uuidText({ uuid: result.report.motor_uuid })
          : ""),
      trace: "validation",
      chart: "motion",
    });
  }
  async function openRun(directory) {
    if (flags().busy) return;
    try {
      const result = directory
        ? await bridge.loadRun(directory)
        : await bridge.pickRun();
      if (result) {
        openReport(result);
        set({ tab: "files", notice: null });
      }
    } catch (error) {
      notice(error.message, true);
    }
  }
  async function setTab(tab) {
    if (!["calibrate", "test", "setup", "files"].includes(tab)) return;
    if (s.tab === "test" && tab !== "test") {
      revoke();
      await stopMonitor();
    }
    set({ tab, notice: s.notice?.error ? s.notice : null });
    if (tab === "files") refreshRuns();
    if (tab === "setup") {
      set({ registersFailed: false });
      loadRegisters();
    }
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
        notice(error.message, true);
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
            if (s.directory === directory)
              set({ directory: null, report: null, reportFiles: [] });
            set({
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
    loadRegisters,
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
      } catch {}
    },
    changeConfig(key, value, baseline = false) {
      if (!s.config || flags().busy) return;
      const config = baseline
        ? { ...s.config, baseline: { ...s.config.baseline, [key]: value } }
        : { ...s.config, [key]: value };
      set({
        config,
        reviewed: false,
        jogSpeed: Math.min(Number(s.jogSpeed), maxJogSpeed(config)),
      });
      schedulePreview();
    },
    restorePreset() {
      if (!s.preset || flags().busy) return;
      set({
        config: structuredClone(s.preset),
        reviewed: false,
        jogSpeed: Math.min(Number(s.jogSpeed), maxJogSpeed(s.preset)),
      });
      schedulePreview();
    },
    review: (value) => {
      if (!flags().busy) set({ reviewed: value });
    },
    async pickOutput() {
      try {
        const outputDirectory = await bridge.pickCalibrationOutput();
        if (outputDirectory) set({ outputDirectory });
      } catch (error) {
        notice(error.message, true);
      }
    },
    async calibrate() {
      if (!flags().calibrate) return;
      try {
        const result = await run("calibrate", {
          ...target(),
          reviewed: s.reviewed,
          config: buildConfig(),
          output: s.outputDirectory,
        });
        if (result?.cancelled) {
          notice("Calibration stopped. Motor disabled.");
          return;
        }
        openReport(await bridge.loadRun(result.directory));
        notice(result.accepted ? "" : "Validation failed. Check the results.");
        refreshRuns();
      } catch (error) {
        notice(error.message, true);
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
        .catch(() => null)
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
          jogSpeed: Math.min(maxJogSpeed(), Math.max(0.01, Number(value))),
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
          notice(error.message, true);
        }
        return;
      }
      try {
        await run("stop", target());
        notice("Motor disabled.");
      } catch {}
    },
    cancel: () => {
      if (s.busy !== "firmwareUpdate")
        bridge.cancel().catch((error) => notice(error.message, true));
    },
    setReferenceInput: (value) => set({ referenceInput: value }),
    setReferenceUnit(unit) {
      const radians =
        Number(s.referenceInput) *
        (s.referenceUnit === "deg" ? Math.PI / 180 : 1);
      set({
        referenceUnit: unit,
        referenceInput:
          s.referenceInput.trim() && Number.isFinite(radians)
            ? String(
                Number(
                  (radians * (unit === "deg" ? 180 / Math.PI : 1)).toPrecision(
                    12,
                  ),
                ),
              )
            : "",
      });
    },
    zero(test = false) {
      if (!flags().zero) return;
      const angle = test
        ? 0
        : s.referenceInput.trim()
          ? Number(s.referenceInput) *
            (s.referenceUnit === "deg" ? Math.PI / 180 : 1)
          : NaN;
      if (!Number.isFinite(angle) || Math.abs(angle) > 100) {
        notice("Reference angle must be within ±100 rad.", true);
        return;
      }
      confirmAction(
        "Set current position?",
        `Set the stationary motor’s current position to zero. The app will display ${numberText(angle, 3)} rad at this position.`,
        async () => {
          if (s.busy === "manual") await stopMonitor();
          await run("zero", { ...target(), confirmed: true });
          await bridge.setReferenceAngle(s.motor.uuid, angle);
          set({
            referenceAngle: angle,
            referenceInput: String(
              Number(
                (
                  angle * (s.referenceUnit === "deg" ? 180 / Math.PI : 1)
                ).toPrecision(12),
              ),
            ),
          });
          notice("Motor zero and display angle saved.");
        },
      );
    },
    setNewId: (value) => set({ newId: value }),
    changeId() {
      const newId = Number(s.newId);
      if (
        !flags().motor ||
        flags().busy ||
        !Number.isInteger(newId) ||
        newId < 1 ||
        newId > 254 ||
        newId === s.motor.id ||
        newId === Number(s.connection.hostId)
      )
        return;
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
          if (result?.cancelled) {
            notice("ID change stopped before verification.");
            return;
          }
          if (result?.previous_id !== motor.id || result.id !== newId)
            throw new Error("The motor’s new ID could not be verified.");
          if (updateSelectedMotor(motor, { id: result.id }))
            notice(`Motor ID changed to ${result.id}.`);
        },
      );
    },
    async prepareFirmware() {
      if (flags().busy || !flags().motor) return;
      try {
        const firmware = await run("firmwarePrepare", target());
        set({
          firmware,
          firmwareMessage: `Verified · installed ${firmware.current_version} → ${firmware.version}`,
        });
      } catch {}
    },
    updateFirmware() {
      if (
        flags().busy ||
        !flags().motor ||
        !s.firmware ||
        s.firmware.id !== s.motor.id
      )
        return;
      const motor = s.motor;
      const params = target();
      confirmAction(
        "Update motor firmware?",
        `Update ${motor.model} · ID ${motor.id} from ${s.firmware.current_version} to ${s.firmware.version}. Keep power and USB connected until the transfer finishes.`,
        async () => {
          if (s.motor !== motor || flags().busy) return;
          const result = await run("firmwareUpdate", {
            ...params,
            confirmed: true,
          });
          if (result?.cancelled) {
            notice("Firmware preparation stopped.");
            return;
          }
          if (
            result?.id !== motor.id ||
            typeof result.firmware !== "string" ||
            !result.firmware
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
      bridge.openReleaseNotes().catch((error) => notice(error.message, true)),
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
    retryRegisters() {
      set({ registersFailed: false });
      loadRegisters();
    },
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
      } catch {}
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
      bridge.showRun(s.directory).catch((error) => notice(error.message, true)),
    copyPath: () =>
      bridge
        .copyRunPath(s.directory)
        .then(() => notice("Folder path copied."))
        .catch((error) => notice(error.message, true)),
    refit() {
      if (!s.directory || flags().busy) return;
      confirmAction(
        "Refit this recording?",
        "Analysis artifacts in this folder will be replaced. The original recorded samples are preserved.",
        async () => {
          const directory = s.directory;
          const result = await run("analyze", { directory });
          if (result?.cancelled) {
            notice("Refit stopped.");
            return;
          }
          openReport(await bridge.loadRun(directory));
          notice("Recording refitted.");
        },
      );
    },
    newCalibration: () => {
      if (!flags().busy)
        set({ report: null, directory: null, reviewed: false, notice: null });
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
        notice(error.message, true);
      }
    },
    async openSettings() {
      set({ settingsOpen: true });
      try {
        const info = await bridge.updateInfo();
        set({
          version: info.version,
          ...(info.updateError ? { updateMessage: info.updateError } : {}),
        });
      } catch (error) {
        set({ updateMessage: error.message });
      }
    },
    closeSettings: () => set({ settingsOpen: false }),
    async checkUpdate() {
      set({
        checkingUpdate: true,
        updateCandidate: null,
        updateMessage: "Checking GitHub releases…",
      });
      try {
        const result = await bridge.checkUpdate();
        set({
          updateCandidate:
            result.available && result.installable ? result : null,
          updateMessage: result.available
            ? result.installable
              ? `Version ${result.version} is available.`
              : result.reason ||
                `No installer for version ${result.version} on this computer yet.`
            : "You have the latest version.",
        });
      } catch (error) {
        set({ updateMessage: error.message });
      } finally {
        set({ checkingUpdate: false });
      }
    },
    async installUpdate() {
      if (flags().busy || !s.updateCandidate) return;
      set({ installingUpdate: true, updateMessage: "Downloading update…" });
      try {
        await bridge.installUpdate();
      } catch (error) {
        set({ updateMessage: error.message });
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
    const timer = setInterval(() => {
      if (s.busy === "manual") {
        sendIntent();
        set({});
      }
    }, 60);
    refreshInterfaces();
    refreshRuns();
    return () => {
      revoke();
      disposed = true;
      clearInterval(timer);
      clearTimeout(previewTimer);
      offEvent?.();
      offUpdate?.();
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
