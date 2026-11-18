import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createController, controls, selectedCan } from "./controller.mjs";

const preset = {
  torque_limit: 1,
  speed_limit: 5,
  travel_limit: 3,
  train_seconds: 40,
  validation_seconds: 20,
  temperature_limit: 60,
  sample_hz: 200,
  sweep_start_hz: 0.1,
  sweep_end_hz: 5,
  baseline: { armature: 0.01, damping: 0.01, friction: 0.01, delay: 0 },
  profile: {},
};
const motor = { model: "RS-00", id: 1, uuid: [1, 2, 3, 4, 5, 6, 7, 8] };
const usbAdapter = {
  id: "gsusb:0102:1",
  bus_id: "QA",
  address: 1,
  vendor_id: 0x1d50,
  product_id: 0x606f,
  accessible: true,
};
const register = {
  index: 0x7010,
  name: "Test register",
  symbol: "test",
  value_type: "float32",
  writable: true,
  readable: true,
  editable: true,
  persistence: "save_to_flash",
  min: 0,
  max: 10,
};
const tick = () => delay(5);
async function setup(t, overrides = {}) {
  const calls = [],
    intents = [];
  let receive,
    finishManual,
    clock = 1000,
    focus = true;
  const bridge = {
    platform: "linux",
    onEvent: (callback) => {
      receive = callback;
      return () => {};
    },
    onUpdateProgress: () => () => {},
    listRuns: async () => [],
    preview: async () => ({
      spec: {},
      t: [0, 1],
      velocity: [0, 1],
      torque: [0, 0],
      segments: [],
    }),
    getReferenceAngle: async () => 0,
    setReferenceAngle: async () => {},
    run: async (op, params) => {
      calls.push({ op, params });
      if (op === "interfaces")
        return [{ name: "can0", up: true, state: "ERROR-ACTIVE" }];
      if (op === "usbAdapters") return [];
      if (op === "scan") return [motor];
      if (op === "plan") return structuredClone(preset);
      if (op === "registerList") return [register];
      if (op === "setId") return { previous_id: params.id, id: params.newId };
      if (op === "firmwarePrepare")
        return { id: params.id, current_version: "1.2.3", version: "1.2.4" };
      if (op === "firmwareUpdate") return { id: params.id, firmware: "1.2.4" };
      if (op === "registerRead" || op === "registerWrite")
        return {
          index: register.index,
          uuid: "0102030405060708",
          value: op === "registerWrite" ? params.value : 1,
          raw: "0000803F",
        };
      if (op === "manual")
        return new Promise((resolve) => {
          finishManual = resolve;
        });
      return { cancelled: true };
    },
    manualIntent: async (value) => {
      intents.push(value);
    },
    cancel: async () => {
      finishManual?.({ cancelled: true });
    },
    ...overrides,
  };
  const controller = createController(bridge, {
    previewDelay: 0,
    now: () => clock,
    focused: () => focus,
  });
  t.after(controller.start());
  await tick();
  return {
    ...controller,
    bridge,
    calls,
    intents,
    emit: (e) => receive(e),
    setClock: (v) => {
      clock = v;
    },
    setFocus: (v) => {
      focus = v;
    },
    flags: () => controls(controller.getSnapshot(), bridge.platform, clock),
    async connect() {
      await controller.actions.scan();
      await tick();
    },
  };
}
const feedback = {
  fresh: true,
  faults: 0,
  temperature_c: 25,
  position_rad: 0,
  velocity_rad_s: 0,
  torque_nm: 0,
  sample_t: 1,
  enabled: false,
  preparing: false,
};

test("startup and browsing send no motion or motor commands", async (t) => {
  const ctx = await setup(t);
  assert.deepEqual(
    ctx.calls.map((c) => c.op),
    ["interfaces", "usbAdapters"],
  );
  await ctx.actions.setTab("test");
  await ctx.actions.setTab("files");
  assert.equal(ctx.intents.length, 0);
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.flags().calibrate, false);
});
test("late progress cannot reopen a finished operation", async (t) => {
  const ctx = await setup(t);
  await ctx.connect();
  await ctx.actions.setTab("test");
  await ctx.actions.monitor();
  ctx.emit({ type: "progress", message: "Monitoring" });
  assert.equal(ctx.getSnapshot().work.message, "Monitoring");
  await ctx.actions.monitor();
  ctx.emit({ type: "progress", message: "Error: CAN deadline" });
  assert.equal(ctx.getSnapshot().busy, null);
  assert.equal(ctx.getSnapshot().work, null);
});
test("macOS and Windows default to direct USB and select a sole accessible adapter", async (t) => {
  for (const platform of ["darwin", "win32"]) {
    const ctx = await setup(t, { platform });
    assert.equal(ctx.getSnapshot().connection.transport, "gsusb");
    const run = ctx.bridge.run;
    ctx.bridge.run = async (op, params) =>
      op === "usbAdapters" ? [usbAdapter] : run(op, params);
    await ctx.actions.refreshInterfaces();
    assert.equal(selectedCan(ctx.getSnapshot()), usbAdapter.id);
    assert.equal(ctx.flags().ready, true);
    ctx.actions.changeConnection("transport", "socketcan");
    assert.equal(ctx.getSnapshot().connection.transport, "gsusb");
  }
});
test("Linux selects direct USB when no SocketCAN interface is available", async (t) => {
  const ctx = await setup(t);
  const run = ctx.bridge.run;
  ctx.bridge.run = async (op, params) =>
    op === "interfaces"
      ? []
      : op === "usbAdapters"
        ? [usbAdapter]
        : run(op, params);
  await ctx.actions.refreshInterfaces();
  assert.equal(ctx.getSnapshot().connection.transport, "gsusb");
  assert.equal(ctx.flags().ready, true);
});
test("refreshing an unchanged adapter preserves selection, limits, and review", async (t) => {
  const ctx = await setup(t);
  await ctx.connect();
  ctx.actions.changeConfig("torque_limit", "0.7");
  await tick();
  ctx.actions.review(true);
  const before = ctx.getSnapshot();
  await ctx.actions.refreshInterfaces();
  const after = ctx.getSnapshot();
  for (const key of ["motor", "config", "preset", "preview", "reviewed"])
    assert.equal(after[key], before[key]);
  assert.equal(ctx.flags().calibrate, true);
  assert.equal(ctx.calls.filter((call) => call.op === "scan").length, 1);
});
test("adapter removal clears the motor and blocks further motor commands", async (t) => {
  const ctx = await setup(t);
  await ctx.connect();
  ctx.actions.review(true);
  const run = ctx.bridge.run;
  ctx.bridge.run = async (op, params) =>
    op === "interfaces" ? [] : run(op, params);
  await ctx.actions.refreshInterfaces();
  assert.equal(ctx.getSnapshot().motor, null);
  assert.equal(ctx.getSnapshot().config, null);
  assert.equal(ctx.getSnapshot().connectionOpen, true);
  assert.equal(ctx.flags().motor, false);
  await ctx.actions.calibrate();
  assert.equal(
    ctx.calls.some((call) => call.op === "calibrate"),
    false,
  );
});
test("adapter refresh blocks connection edits throughout enumeration", async (t) => {
  const ctx = await setup(t);
  await ctx.connect();
  const run = ctx.bridge.run;
  let finish;
  ctx.bridge.run = async (op, params) =>
    op === "usbAdapters"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : run(op, params);
  const refresh = ctx.actions.refreshInterfaces();
  await tick();
  assert.equal(ctx.flags().busy, true);
  ctx.actions.changeConnection("transport", "gsusb");
  assert.equal(ctx.getSnapshot().connection.transport, "socketcan");
  finish([]);
  await refresh;
  assert.equal(ctx.flags().busy, false);
  assert.ok(ctx.getSnapshot().motor);
});
test("calibration requires a valid preview and explicit review; editing revokes review", async (t) => {
  const ctx = await setup(t);
  await ctx.connect();
  await ctx.actions.calibrate();
  assert.equal(
    ctx.calls.some((c) => c.op === "calibrate"),
    false,
  );
  ctx.actions.review(true);
  assert.equal(ctx.flags().calibrate, true);
  ctx.actions.changeConfig("speed_limit", "2");
  assert.equal(ctx.getSnapshot().reviewed, false);
  assert.equal(ctx.getSnapshot().preview, null);
  assert.equal(ctx.flags().calibrate, false);
  await tick();
  ctx.actions.review(true);
  await ctx.actions.calibrate();
  const call = ctx.calls.find((c) => c.op === "calibrate");
  assert.equal(call.params.reviewed, true);
  assert.equal(call.params.config.speed_limit, 2);
  assert.equal(call.params.config.motor_id, 1);
});
test("outdated preview responses cannot authorize a changed configuration", async (t) => {
  const responses = [];
  const ctx = await setup(t, {
    preview: () => new Promise((resolve) => responses.push(resolve)),
  });
  await ctx.connect();
  ctx.actions.changeConfig("speed_limit", "2");
  await tick();
  responses[0]({ old: true });
  await tick();
  assert.equal(ctx.getSnapshot().preview, null);
  responses[1]({ current: true });
  await tick();
  assert.deepEqual(ctx.getSnapshot().preview, { current: true });
});
test("changing transport clears motor identity, review, and register reads", async (t) => {
  const ctx = await setup(t);
  await ctx.connect();
  ctx.actions.review(true);
  ctx.actions.changeConnection("transport", "gsusb");
  ctx.actions.changeConnection("usb", "gsusb:0102:1");
  assert.equal(selectedCan(ctx.getSnapshot()), "gsusb:0102:1");
  assert.equal(ctx.getSnapshot().motor, null);
  assert.equal(ctx.getSnapshot().reviewed, false);
  assert.equal(ctx.flags().calibrate, false);
});
test("manual enable needs fresh, healthy feedback and review; stale feedback blocks jogging", async (t) => {
  const ctx = await setup(t);
  await ctx.connect();
  await ctx.actions.setTab("test");
  await ctx.actions.monitor();
  assert.equal(ctx.flags().enable, false);
  ctx.emit({ type: "manualStatus", value: feedback });
  ctx.actions.reviewJog(true);
  assert.equal(ctx.flags().enable, true);
  ctx.emit({ type: "manualStatus", value: { ...feedback, faults: 1 } });
  assert.equal(ctx.flags().enable, false);
  ctx.emit({ type: "manualStatus", value: { ...feedback, temperature_c: 65 } });
  assert.equal(ctx.flags().enable, false);
  ctx.emit({ type: "manualStatus", value: { ...feedback, enabled: true } });
  assert.equal(ctx.flags().jog, true);
  ctx.setClock(1250);
  assert.equal(ctx.flags().jog, false);
  await ctx.actions.setTab("files");
  assert.equal(ctx.getSnapshot().busy, null);
});
test("hold-to-jog releases to zero and focus loss revokes the motor lease", async (t) => {
  const ctx = await setup(t);
  await ctx.connect();
  await ctx.actions.setTab("test");
  await ctx.actions.monitor();
  ctx.emit({ type: "manualStatus", value: feedback });
  ctx.actions.reviewJog(true);
  ctx.actions.enable();
  await tick();
  assert.equal(ctx.intents.at(-1).enabled, true);
  ctx.emit({ type: "manualStatus", value: { ...feedback, enabled: true } });
  ctx.actions.jog(1);
  await tick();
  assert.equal(ctx.intents.at(-1).direction, 1);
  ctx.actions.release();
  await tick();
  assert.equal(ctx.intents.at(-1).direction, 0);
  ctx.setFocus(false);
  await delay(75);
  assert.equal(ctx.intents.at(-1).enabled, false);
  assert.equal(ctx.intents.at(-1).direction, 0);
  await ctx.actions.setTab("files");
});
test("register writes require a read for the same UUID and preserve expected raw value", async (t) => {
  const ctx = await setup(t);
  await ctx.connect();
  await ctx.actions.setTab("setup");
  await tick();
  ctx.actions.setRegisterValue("2");
  assert.equal(ctx.flags().registerWrite, false);
  await ctx.actions.readRegister();
  assert.equal(ctx.flags().registerWrite, false);
  ctx.actions.setRegisterValue("2");
  assert.equal(ctx.flags().registerWrite, true);
  ctx.actions.writeRegister();
  assert.equal(
    ctx.calls.some((c) => c.op === "registerWrite"),
    false,
  );
  await ctx.actions.confirm();
  const call = ctx.calls.find((c) => c.op === "registerWrite");
  assert.equal(call.params.expectedRaw, "0000803F");
  assert.equal(call.params.uuid, "0102030405060708");
  assert.equal(call.params.confirmed, true);
});
test("blank and out-of-range register values cannot be saved", async (t) => {
  const ctx = await setup(t);
  await ctx.connect();
  await ctx.actions.setTab("setup");
  await tick();
  await ctx.actions.readRegister();
  for (const value of ["", "11", "-1", "NaN"]) {
    ctx.actions.setRegisterValue(value);
    assert.equal(ctx.flags().registerWrite, false);
  }
});
test("restoring a preset restores baseline fields and revokes calibration review", async (t) => {
  const ctx = await setup(t);
  await ctx.connect();
  ctx.actions.changeConfig("damping", "5", true);
  ctx.actions.review(true);
  ctx.actions.restorePreset();
  assert.equal(
    ctx.getSnapshot().config.baseline.damping,
    preset.baseline.damping,
  );
  assert.equal(ctx.getSnapshot().reviewed, false);
});

test("register loading remains single-flight when a subscriber reacts to operation completion", async (t) => {
  const ctx = await setup(t);
  await ctx.actions.scan();
  const off = ctx.subscribe(() => {
    const s = ctx.getSnapshot();
    if (s.tab === "setup" && !s.busy && !s.registers && !s.registersFailed)
      ctx.actions.loadRegisters();
  });
  t.after(off);
  await ctx.actions.setTab("setup");
  await tick();
  assert.equal(ctx.calls.filter((c) => c.op === "registerList").length, 1);
  assert.equal(ctx.getSnapshot().registers.length, 1);
});

test("recording deletion is confirmed, permanent, and clears only the deleted selection", async (t) => {
  const directory = "/recordings/run";
  let deleted;
  const ctx = await setup(t, {
    listRuns: async () => [{ directory, model: "RS-10P", motorId: 61 }],
    loadRun: async () => ({
      directory,
      report: { motor_uuid: motor.uuid },
      files: ["training.csv"],
    }),
    deleteRun: async (value) => {
      deleted = value;
    },
  });
  await ctx.actions.refreshRuns();
  await ctx.actions.openRun(directory);
  assert.equal(ctx.getSnapshot().reportUuid, "0102030405060708");
  ctx.actions.deleteRun(directory);
  assert.equal(deleted, undefined);
  assert.match(
    ctx.getSnapshot().confirmation.description,
    /Permanently delete/,
  );
  ctx.actions.closeConfirmation();
  assert.equal(ctx.getSnapshot().directory, directory);
  ctx.actions.deleteRun(directory);
  await ctx.actions.confirm();
  assert.equal(deleted, directory);
  assert.equal(ctx.getSnapshot().directory, null);
  assert.equal(ctx.getSnapshot().report, null);
  assert.deepEqual(ctx.getSnapshot().runs, []);
});

test("file downloads block concurrent actions and a cancelled dialog leaves the recording open", async (t) => {
  let finish;
  const ctx = await setup(t, {
    exportRun: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const operation = ctx.actions.exportRun("/recordings/run", "training.csv");
  assert.equal(ctx.flags().busy, true);
  ctx.actions.deleteRun("/recordings/run");
  assert.equal(ctx.getSnapshot().confirmation, undefined);
  finish(null);
  await operation;
  assert.equal(ctx.flags().busy, false);
});

test("position reference converts degrees and requires confirmation before writing", async (t) => {
  let saved;
  const ctx = await setup(t, {
    setReferenceAngle: async (uuid, angle) => {
      saved = { uuid, angle };
    },
  });
  await ctx.connect();
  ctx.actions.setReferenceUnit("deg");
  ctx.actions.setReferenceInput("90");
  ctx.actions.zero();
  assert.equal(
    ctx.calls.some((c) => c.op === "zero"),
    false,
  );
  await ctx.actions.confirm();
  assert.equal(ctx.calls.find((c) => c.op === "zero").params.confirmed, true);
  assert.equal(saved.angle, Math.PI / 2);
  assert.deepEqual(saved.uuid, motor.uuid);
  ctx.actions.setReferenceInput("");
  ctx.actions.zero();
  assert.equal(ctx.getSnapshot().confirmation, null);
  assert.equal(ctx.getSnapshot().notice.error, true);
});

test("firmware transfer requires confirmation and blocks stop until verified completion", async (t) => {
  const ctx = await setup(t);
  await ctx.connect();
  await ctx.actions.prepareFirmware();
  let finish;
  ctx.bridge.run = async () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  let cancelled = false;
  ctx.bridge.cancel = async () => {
    cancelled = true;
  };
  ctx.actions.updateFirmware();
  assert.equal(ctx.getSnapshot().busy, null);
  const updating = ctx.actions.confirm();
  assert.equal(ctx.getSnapshot().busy, "firmwareUpdate");
  assert.equal(ctx.flags().disable, false);
  await ctx.actions.disable();
  ctx.actions.cancel();
  assert.equal(cancelled, false);
  finish({ id: 1, firmware: "1.2.4" });
  await updating;
  assert.equal(ctx.getSnapshot().motor.firmware, "1.2.4");
  assert.equal(ctx.getSnapshot().motors[0].firmware, "1.2.4");
  assert.equal(ctx.getSnapshot().firmware, null);
  assert.equal(ctx.getSnapshot().reviewed, false);
});

test("verified ID changes keep the motor, limits, and reference selected without scanning", async (t) => {
  const ctx = await setup(t);
  await ctx.connect();
  await ctx.actions.setTab("setup");
  await tick();
  await ctx.actions.readRegister();
  await ctx.actions.prepareFirmware();
  ctx.actions.changeConfig("torque_limit", "0.7");
  await tick();
  ctx.actions.setReferenceInput("0.2");
  ctx.actions.zero();
  await ctx.actions.confirm();
  ctx.actions.review(true);
  const config = ctx.getSnapshot().config;
  const preview = ctx.getSnapshot().preview;
  ctx.actions.setNewId("61");
  ctx.actions.changeId();
  assert.equal(
    ctx.calls.some((call) => call.op === "setId"),
    false,
  );
  await ctx.actions.confirm();
  const s = ctx.getSnapshot();
  assert.equal(s.motor.id, 61);
  assert.deepEqual(s.motor.uuid, motor.uuid);
  assert.equal(s.motors[0], s.motor);
  assert.deepEqual(s.config, { ...config, motor_id: 61 });
  assert.equal(s.preview, preview);
  assert.equal(s.referenceAngle, 0.2);
  assert.equal(s.connectionOpen, false);
  assert.equal(s.newId, "");
  assert.equal(s.registerRead, null);
  assert.equal(s.firmware, null);
  assert.equal(s.reviewed, false);
  assert.equal(ctx.flags().motor, true);
  await ctx.actions.readRegister();
  await ctx.actions.prepareFirmware();
  ctx.actions.updateFirmware();
  await ctx.actions.confirm();
  assert.equal(ctx.getSnapshot().motor.id, 61);
  assert.equal(ctx.getSnapshot().motors[0].firmware, "1.2.4");
  for (const op of ["registerRead", "firmwarePrepare", "firmwareUpdate"])
    assert.equal(ctx.calls.findLast((call) => call.op === op).params.id, 61);
  await ctx.actions.selectMotor("61");
  assert.equal(ctx.getSnapshot().motor.firmware, "1.2.4");
  assert.equal(ctx.getSnapshot().config.torque_limit, "0.7");
  assert.equal(ctx.getSnapshot().referenceAngle, 0.2);
  assert.equal(ctx.calls.filter((call) => call.op === "plan").length, 1);
  assert.equal(ctx.calls.filter((call) => call.op === "scan").length, 1);
});

test("failed, cancelled, and unverified ID changes do not replace motor identity", async (t) => {
  const ctx = await setup(t);
  await ctx.connect();
  const original = ctx.getSnapshot().motor;
  for (const outcome of [
    new Error("Target CAN ID is already occupied"),
    { cancelled: true },
    { previous_id: 2, id: 61 },
    { previous_id: 1, id: 62 },
  ]) {
    ctx.bridge.run = async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    ctx.actions.setNewId("61");
    ctx.actions.changeId();
    await ctx.actions.confirm();
    assert.equal(ctx.getSnapshot().motor, original);
    assert.equal(ctx.getSnapshot().motors[0], original);
    assert.ok(!ctx.getSnapshot().notice.message.includes("Motor ID changed"));
  }
});

test("ID changes update only the selected motor in a multi-motor list", async (t) => {
  const ctx = await setup(t);
  const run = ctx.bridge.run;
  ctx.bridge.run = async (operation, params) =>
    operation === "scan"
      ? [motor, { ...motor, id: 2, uuid: [...motor.uuid.slice(0, 7), 9] }]
      : run(operation, params);
  await ctx.actions.scan();
  await ctx.actions.selectMotor("1");
  const other = ctx.getSnapshot().motors[1];
  ctx.actions.setNewId("61");
  ctx.actions.changeId();
  await ctx.actions.confirm();
  assert.equal(ctx.getSnapshot().motor.id, 61);
  assert.equal(ctx.getSnapshot().motors[0].id, 61);
  assert.equal(ctx.getSnapshot().motors[1], other);
});

test("a confirmation cannot change a different motor selected afterward", async (t) => {
  const ctx = await setup(t);
  const run = ctx.bridge.run;
  ctx.bridge.run = async (operation, params) =>
    operation === "scan"
      ? [motor, { ...motor, id: 2 }]
      : run(operation, params);
  await ctx.actions.scan();
  await ctx.actions.selectMotor("1");
  ctx.actions.setNewId("61");
  ctx.actions.changeId();
  await ctx.actions.selectMotor("2");
  await ctx.actions.confirm();
  assert.equal(
    ctx.calls.some((call) => call.op === "setId"),
    false,
  );
  await ctx.actions.prepareFirmware();
  ctx.actions.updateFirmware();
  await ctx.actions.selectMotor("1");
  await ctx.actions.confirm();
  assert.equal(
    ctx.calls.some((call) => call.op === "firmwareUpdate"),
    false,
  );
});

test("a single scanned motor loads its preset without another selection", async (t) => {
  const ctx = await setup(t);
  await ctx.actions.scan();
  await tick();
  assert.equal(ctx.getSnapshot().motor.id, 1);
  assert.ok(ctx.getSnapshot().config);
  assert.deepEqual(
    ctx.calls.slice(2).map((call) => call.op),
    ["scan", "plan"],
  );
  assert.equal(ctx.flags().calibrate, false);
});

test("multiple scanned motors require an explicit selection", async (t) => {
  const ctx = await setup(t);
  const run = ctx.bridge.run;
  ctx.bridge.run = async (operation, params) =>
    operation === "scan"
      ? [motor, { ...motor, id: 2 }]
      : run(operation, params);
  await ctx.actions.scan();
  assert.equal(ctx.getSnapshot().motor, null);
  assert.equal(ctx.getSnapshot().config, null);
  await ctx.actions.selectMotor("2");
  assert.equal(ctx.getSnapshot().motor.id, 2);
});

test("firmware errors show the failure without repeated progress output", async (t) => {
  const ctx = await setup(t);
  await ctx.connect();
  ctx.bridge.run = async () => {
    throw new Error(
      "Preparing official RS-00 firmware 0.0.3.36\nError: RobStride no longer hosts RS-00 firmware 0.0.3.36. Check for an app update.",
    );
  };
  await ctx.actions.prepareFirmware();
  assert.equal(
    ctx.getSnapshot().notice.message,
    "RobStride no longer hosts RS-00 firmware 0.0.3.36. Check for an app update.",
  );
  assert.equal(ctx.getSnapshot().firmware, null);
});
