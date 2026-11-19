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
  experiment: "Mixed",
  excitation_revision: 1,
  baseline: { static_friction: 0, armature: 0.01, damping: 0.01, friction: 0.01, delay: 0 },
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
    manual,
    clock = 1000,
    focus = true;
  const adapters = {
    interfaces: [{ name: "can0", up: true, state: "ERROR-ACTIVE" }],
    usbAdapters: [],
  };
  const bridge = {
    platform: "linux",
    onEvent: (callback) => {
      receive = callback;
      return () => {};
    },
    onUpdateProgress: () => () => {},
    updateInfo: async () => ({ version: "0.1.22" }),
    listRuns: async () => [],
    loadRun: async directory => ({ directory, report: { accepted: true }, files: [], uuid: "" }),
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
      if (Object.hasOwn(adapters, op)) {
        if (adapters[op] instanceof Error) throw adapters[op];
        return adapters[op];
      }
      if (op === "scan") return [motor];
      if (op === "calibrate") return { accepted: true, directory: "/recordings/finished" };
      if (op === "plan") return { preset: structuredClone(preset), limits: {}, registers: [register] };
      if (op === "setId") return { previous_id: params.id, id: params.newId };
      if (op === "firmwarePrepare")
        return { id: params.id, model: motor.model, uuid: motor.uuid, interface: params.can, host_id: Number(params.hostId), current_version: "1.2.3", version: "1.2.4" };
      if (op === "firmwareUpdate") return { id: params.id, firmware: "1.2.4" };
      if (op === "registerRead" || op === "registerWrite")
        return {
          index: register.index,
          uuid: "0102030405060708",
          value: op === "registerWrite" ? params.value : 1,
          raw: "0000803F",
        };
      if (op === "manual") {
        manual = Promise.withResolvers();
        return manual.promise;
      }
      if (op === "zero") return { zeroed: true };
      if (op === "stop") return { stopped: true };
      throw new Error(`Unexpected test operation: ${op}`);
    },
    manualIntent: async (value) => {
      intents.push(value);
    },
    cancel: async () => {
      manual?.resolve({ cancelled: true });
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
    adapters,
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

test("late progress cannot reopen a finished operation", async (t) => {
  const ctx = await setup(t);
  await ctx.connect();
  await ctx.actions.setTab("test");
  await ctx.actions.monitor();
  ctx.emit({ type: "progress", message: "Monitoring", percent: 31 });
  assert.equal(ctx.getSnapshot().work.message, "Monitoring");
  assert.equal(ctx.getSnapshot().work.percent, 31);
  await ctx.actions.monitor();
  ctx.emit({ type: "progress", message: "Error: CAN deadline" });
  assert.equal(ctx.getSnapshot().busy, null);
  assert.equal(ctx.getSnapshot().work, null);
});
test("Linux can scan using USB when SocketCAN is unavailable", async t => {
  for (const interfaces of [[], new Error("SocketCAN unavailable")]) {
    const ctx = await setup(t);
    ctx.adapters.interfaces = interfaces;
    ctx.adapters.usbAdapters = [usbAdapter];
    await ctx.actions.refreshInterfaces();
    assert.equal(selectedCan(ctx.getSnapshot()), usbAdapter.id);
    await ctx.connect();
    assert.equal(ctx.getSnapshot().motor.id, motor.id);
  }
});
test("reviewed settings stay usable while the selected adapter is available", async t => {
  const ctx = await setup(t);
  await ctx.connect();
  ctx.actions.changeConfig("torque_limit", "0.7");
  await tick();
  ctx.actions.review(true);

  ctx.adapters.usbAdapters = new Error("USB unavailable");
  await ctx.actions.refreshInterfaces();
  assert.equal(ctx.getSnapshot().config.torque_limit, 0.7);
  assert.equal(ctx.flags().calibrate, true);
  assert.equal(ctx.getSnapshot().notice.error, true);

  ctx.adapters.interfaces = [];
  await ctx.actions.refreshInterfaces();
  assert.equal(ctx.getSnapshot().motor, null);
  assert.equal(ctx.flags().calibrate, false);
  await ctx.actions.calibrate();
  assert.ok(!ctx.calls.some(call => call.op === "calibrate"));
});
test("adapter refresh blocks connection edits throughout enumeration", async (t) => {
  const ctx = await setup(t);
  await ctx.connect();
  const enumeration = Promise.withResolvers();
  ctx.adapters.usbAdapters = enumeration.promise;
  const refresh = ctx.actions.refreshInterfaces();
  await tick();
  assert.equal(ctx.flags().busy, true);
  ctx.actions.changeConnection("transport", "gsusb");
  assert.equal(ctx.getSnapshot().connection.transport, "socketcan");
  enumeration.resolve([]);
  await refresh;
  assert.equal(ctx.flags().busy, false);
  assert.ok(ctx.getSnapshot().motor);
});
test("calibration requires a complete, reviewed configuration", async t => {
  const ctx = await setup(t);
  await ctx.connect();
  await ctx.actions.calibrate();
  assert.ok(!ctx.calls.some(call => call.op === "calibrate"));
  ctx.actions.review(true);
  assert.ok(ctx.flags().calibrate);

  ctx.actions.changeConfig("damping", "", true);
  await tick();
  assert.equal(ctx.getSnapshot().reviewed, false);
  ctx.actions.review(true);
  assert.equal(ctx.flags().calibrate, false);

  ctx.actions.changeConfig("damping", "0", true);
  await tick();
  ctx.actions.review(true);
  await ctx.actions.calibrate();
  const call = ctx.calls.find(call => call.op === "calibrate");
  assert.equal(call.params.config.baseline.damping, 0);
  assert.equal(call.params.config.motor_id, motor.id);
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

test("recording deletion is confirmed, permanent, and clears only the deleted selection", async (t) => {
  const directory = "/recordings/run";
  let deleted;
  const ctx = await setup(t, {
    listRuns: async () => [{ directory, model: "RS-10P", motorId: 61 }],
    loadRun: async () => ({
      directory,
      uuid: "0102030405060708",
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
  const listing = Promise.withResolvers();
  ctx.bridge.listRuns = () => listing.promise;
  const refresh = ctx.actions.refreshRuns();
  ctx.actions.deleteRun(directory);
  await ctx.actions.confirm();
  listing.resolve([{ directory }]);
  await refresh;
  assert.equal(deleted, directory);
  assert.equal(ctx.getSnapshot().directory, null);
  assert.equal(ctx.getSnapshot().report, null);
  assert.deepEqual(ctx.getSnapshot().runs, []);
});

test("file downloads block concurrent actions and a cancelled dialog leaves the recording open", async (t) => {
  const download = Promise.withResolvers();
  const ctx = await setup(t, { exportRun: () => download.promise });
  const operation = ctx.actions.exportRun("/recordings/run", "training.csv");
  assert.equal(ctx.flags().busy, true);
  ctx.actions.deleteRun("/recordings/run");
  assert.equal(ctx.getSnapshot().confirmation, undefined);
  download.resolve(null);
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
  const transfer = Promise.withResolvers();
  const reviewed = ctx.getSnapshot().firmware;
  ctx.bridge.run = async (_op, params) => {
    assert.deepEqual(params.prepared, reviewed);
    return transfer.promise;
  };
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
  transfer.resolve({ id: 1, firmware: "1.2.4" });
  await updating;
  assert.equal(ctx.getSnapshot().motor.firmware, "1.2.4");
  assert.equal(ctx.getSnapshot().motors[0].firmware, "1.2.4");
  assert.equal(ctx.getSnapshot().firmware, null);
  assert.equal(ctx.getSnapshot().reviewed, false);
});

test("preparing a replacement motor invalidates the earlier firmware review", async t => {
  const ctx = await setup(t);
  await ctx.connect();
  await ctx.actions.prepareFirmware();
  const reviewed = ctx.getSnapshot().firmware;
  ctx.bridge.run = async () => ({ ...reviewed, uuid: Array(8).fill(0) });
  await ctx.actions.prepareFirmware();
  assert.equal(ctx.flags().updateFirmware, false);
  assert.equal(ctx.getSnapshot().notice.error, true);
  ctx.actions.updateFirmware();
  assert.ok(!ctx.getSnapshot().confirmation);
});

test("changing the motor ID keeps its settings and requires fresh reviews", async t => {
  const ctx = await setup(t);
  await ctx.connect();
  await ctx.actions.readRegister();
  ctx.actions.setRegisterValue("2");
  await ctx.actions.prepareFirmware();
  ctx.actions.changeConfig("torque_limit", "0.7");
  ctx.actions.setReferenceInput("0.2");
  ctx.actions.zero();
  await ctx.actions.confirm();
  await tick();
  ctx.actions.review(true);
  assert.ok(ctx.flags().registerWrite && ctx.flags().updateFirmware && ctx.flags().calibrate);

  ctx.actions.setNewId("61");
  ctx.actions.changeId();
  await ctx.actions.confirm();
  const s = ctx.getSnapshot();
  assert.ok(ctx.flags().motor);
  assert.equal(s.motor.id, 61);
  assert.deepEqual(s.motor.uuid, motor.uuid);
  assert.equal(s.config.torque_limit, 0.7);
  assert.equal(s.referenceAngle, 0.2);
  ctx.actions.setRegisterValue("2");
  assert.equal(ctx.flags().registerWrite, false);
  assert.equal(ctx.flags().updateFirmware, false);
  assert.equal(ctx.flags().calibrate, false);

  await ctx.actions.readRegister();
  assert.equal(ctx.calls.findLast(call => call.op === "registerRead").params.id, 61);
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
    assert.deepEqual(ctx.getSnapshot().motor, original);
    assert.deepEqual(ctx.getSnapshot().motors[0], original);
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
  assert.deepEqual(ctx.getSnapshot().motors[1], other);
});

test("a confirmation cannot change a different motor selected afterward", async (t) => {
  const ctx = await setup(t);
  const run = ctx.bridge.run;
  ctx.bridge.run = async (operation, params) =>
    operation === "scan"
      ? [motor, { ...motor, id: 2 }]
      : run(operation, params);
  await ctx.actions.scan();
  for (const command of ["setId", "firmwareUpdate", "zero"]) {
    await ctx.actions.selectMotor("1");
    if (command === "setId") {
      ctx.actions.setNewId("61");
      ctx.actions.changeId();
    } else if (command === "firmwareUpdate") {
      await ctx.actions.prepareFirmware();
      ctx.actions.updateFirmware();
    } else ctx.actions.zero();
    assert.ok(ctx.getSnapshot().confirmation, command);
    await ctx.actions.selectMotor("2");
    await ctx.actions.confirm();
    assert.ok(!ctx.calls.some(call => call.op === command), command);
  }
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

test("a cancelled scan leaves the motor list empty and can be retried", async (t) => {
  const ctx = await setup(t);
  const run = ctx.bridge.run;
  ctx.bridge.run = async () => ({ cancelled: true });
  await ctx.actions.scan();
  assert.deepEqual(ctx.getSnapshot().motors, []);
  assert.equal(ctx.getSnapshot().notice.error, false);
  ctx.bridge.run = run;
  await ctx.actions.scan();
  assert.equal(ctx.getSnapshot().motor.id, motor.id);
  assert.ok(ctx.getSnapshot().config);
  assert.equal(ctx.flags().calibrate, false);
});

test("a cancelled zero does not save a reference angle", async (t) => {
  let writes = 0;
  const ctx = await setup(t, { setReferenceAngle: async () => { writes++; } });
  await ctx.connect();
  ctx.bridge.run = async () => ({ cancelled: true });
  ctx.actions.zero();
  await ctx.actions.confirm();
  assert.equal(writes, 0);
  assert.equal(ctx.getSnapshot().notice.error, false);
});
