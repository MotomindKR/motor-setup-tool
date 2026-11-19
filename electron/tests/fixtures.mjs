// Synthetic data used only by automated tests. Never loaded by the app.
export const fixture = {
  preset: {
    torque_limit: 1,
    speed_limit: 14.844025288211773,
    travel_limit: 3,
    train_seconds: 40,
    validation_seconds: 20,
    temperature_limit: 60,
    sample_hz: 200,
    sweep_start_hz: 0.1,
    sweep_end_hz: 5,
    experiment: "Mixed",
    excitation_revision: 1,
    baseline: { static_friction: 0, armature: 0.000001, damping: 0.005, friction: 0.02, delay: 0 },
    profile: { position_range: 12.5, velocity_range: 50, torque_range: 17 },
  },
  preview: {
    spec: {
      rated_torque: 4,
      peak_torque: 17,
      no_load_rpm: 240,
      gear_ratio: 7.75,
      rated_voltage: 48,
    },
    t: [0, 1, 2, 3, 4, 5],
    velocity: [0, 1, -1, 2, -2, 0],
    torque: [0, 0.2, 0, -0.2, 0, 0],
    segments: [
      { name: "Low-speed sweep", start: 0, end: 2 },
      { name: "Torque bursts", start: 2, end: 4 },
      { name: "Validation", start: 4, end: 5 },
    ],
  },
  registers: [
    {
      index: 0x7010,
      name: "Current Kp",
      symbol: "cur_kp",
      description: "Current loop proportional gain.",
      value_type: "float32",
      writable: true,
      readable: true,
      editable: true,
      persistence: "save_to_flash",
      host_index: "0x2012",
      min: 0,
      max: 10,
      choices: [],
    },
    {
      index: 0x701c,
      name: "Bus voltage",
      symbol: "VBUS",
      description: "Live bus voltage.",
      value_type: "uint8",
      writable: false,
      readable: true,
      editable: false,
      persistence: "volatile",
      min: 0,
      max: 255,
      choices: [],
    },
  ],
  report: {
    source: "hardware",
    model: "RS-00",
    motor_id: 1,
    motor_uuid: [1, 2, 3, 4, 5, 6, 7, 8],
    accepted: true,
    mujoco_version: "3.12.0",
    baseline: { armature: 0.01, damping: 0.01, friction: 0.01, delay: 0 },
    fitted: { armature: 0.012, damping: 0.011, friction: 0.005, delay: 0.002 },
    diagnostics: { moving_windows: 4 },
    warnings: [],
    replays: ["validation", "training"].map((name) => ({
      name,
      t: [0, 1, 2, 3, 4, 5],
      measured_velocity: [0, 1, -1, 2, -2, 0],
      pre_velocity: [0, 0.7, -0.7, 1.5, -1.5, 0],
      post_velocity: [0, 0.99, -1.01, 1.99, -1.99, 0],
      measured_position: [0, 0.5, 0.2, 1, 0.5, 0],
      pre_position: [0, 0.3, 0.1, 0.7, 0.3, 0],
      post_position: [0, 0.49, 0.19, 0.99, 0.49, 0],
      command_t: [0, 1, 2, 3, 4, 5],
      command_torque: [0, 0.2, 0, -0.2, 0, 0],
      reported_torque: [0, 0.19, 0, -0.19, 0, 0],
      pre_velocity_rmse: 0.3,
      post_velocity_rmse: 0.01,
      pre_position_rmse: 0.2,
      post_position_rmse: 0.005,
    })),
  },
};

export function installBridge(data) {
  const calls = [],
    intents = [];
  let listener = () => {},
    endManual,
    monitorTimer,
    enabled = false,
    direction = 0,
    sample = 0;
  const adapters = {
    interfaces: data.interfaces ?? [
      { name: "can0", up: true, state: "ERROR-ACTIVE", bitrate: 1000000 },
    ],
    usb: data.usbAdapters ?? [],
  };
  window.testMotor = { calls, intents, adapters, emit: (event) => listener(event) };
  const result = {
    directory: "/recordings/1760000000000-RS-00",
    uuid: "0102030405060708",
    report: data.report,
    files: ["training.csv", "validation.csv", "calibration.json"],
  };
  let motor = {
    model: "RS-00",
    id: 1,
    firmware: "1.2.3",
    uuid: [1, 2, 3, 4, 5, 6, 7, 8],
  };
  window.motorApp = {
    platform: data.platform || "linux",
    onEvent: (callback) => {
      listener = callback;
      return () => {};
    },
    onUpdateProgress: () => () => {},
    async run(operation, params) {
      calls.push({ operation, params });
      if (operation === "interfaces")
        return structuredClone(adapters.interfaces);
      if (operation === "usbAdapters") return structuredClone(adapters.usb);
      if (operation === "scan") return [structuredClone(motor)];
      if (operation === "setId") {
        const previous_id = motor.id;
        motor = { ...motor, id: params.newId };
        return { previous_id, id: motor.id };
      }
      if (operation === "plan") {
        const keys = Object.keys({ ...data.preset, ...data.preset.baseline });
        const limits = Object.fromEntries(keys.map(key => [key, [0, 100]]));
        limits.armature = [0.000001, 1];
        return { preset: structuredClone(data.preset), limits, registers: data.registers };
      }
      if (operation === "registerRead" || operation === "registerWrite")
        return {
          index: params.index,
          uuid: "0102030405060708",
          raw: "0000803F",
          value: operation === "registerRead" ? 1 : params.value,
        };
      if (operation === "calibrate")
        return { directory: result.directory, accepted: true };
      if (operation === "manual")
        return new Promise((resolve) => {
          endManual = resolve;
          monitorTimer = setInterval(
            () =>
              listener({
                type: "manualStatus",
                value: {
                  fresh: true,
                  enabled,
                  preparing: false,
                  faults: 0,
                  mode: 0,
                  temperature_c: 25,
                  sample_t: sample++ / 20,
                  position_rad: sample / 100,
                  velocity_rad_s: direction * 0.5,
                  torque_nm: 0.1,
                },
              }),
            45,
          );
        });
      if (operation === "firmwarePrepare")
        return {
          id: motor.id,
          model: motor.model, uuid: motor.uuid, interface: params.can, host_id: Number(params.hostId),
          current_version: motor.firmware,
          version: "1.2.4",
        };
      if (operation === "firmwareUpdate") {
        motor = { ...motor, firmware: "1.2.4" };
        return { id: motor.id, firmware: motor.firmware };
      }
      return {};
    },
    preview: async () => structuredClone(data.preview),
    listRuns: async () => [
      {
        directory: result.directory,
        model: "RS-00",
        motorId: 1,
        name: "RS-00",
        uuid: "0102030405060708",
        completed: true,
        files: result.files,
        timestamp: 1760000000000,
      },
    ],
    pickRun: async () => result,
    loadRun: async () => result,
    getReferenceAngle: async () => 0,
    setReferenceAngle: async () => {},
    pickCalibrationOutput: async () => "/recordings/new-run",
    showRun: async () => {},
    copyRunPath: async () => {},
    exportRun: async (directory, file) => {
      calls.push({ operation: "exportRun", params: { directory, file } });
      return { path: "/downloads/run.zip" };
    },
    deleteRun: async (directory) => {
      calls.push({ operation: "deleteRun", params: { directory } });
      return { directory };
    },
    openReleaseNotes: async () => {},
    updateInfo: async () => ({ version: "0.1.17" }),
    checkUpdate: async () => ({ available: false }),
    installUpdate: async () => {},
    manualIntent: async (intent) => {
      intents.push(intent);
      enabled = intent.enabled;
      direction = intent.direction;
    },
    cancel: async () => {
      clearInterval(monitorTimer);
      enabled = false;
      endManual?.({ cancelled: true });
    },
  };
}
