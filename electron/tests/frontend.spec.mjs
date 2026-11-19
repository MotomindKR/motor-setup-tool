import { test, expect } from "@playwright/test";
import { fixture, installBridge } from "./fixtures.mjs";
import { DxlWorker } from "../dxl.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(installBridge, fixture);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Scan motors", exact: true }),
  ).toBeEnabled();
});
async function navigate(page, name) {
  const button = page.getByRole("button", { name, exact: true });
  if (!(await button.isVisible()))
    await page.locator('[data-slot="sidebar-trigger"]').click();
  await button.click();
}
async function connect(page) {
  await page.getByRole("button", { name: "Scan motors", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Limits", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start calibration", exact: true }),
  ).toBeDisabled();
}
test("Dynamixel connects through a serial port and verifies zero, mode, ID, and baud", async ({ page }) => {
  const backupDir = await mkdtemp(`${tmpdir()}/motor-dxl-ui-`);
  const worker = new DxlWorker({ root: fileURLToPath(new URL("../..", import.meta.url)), backupDir });
  const authorized = [];
  const connections = [];
  let discovered;
  let waitForPoll;
  let resumePoll;
  let failPolling = false;
  const writes = [];
  try {
    await page.exposeFunction("testDxl", async (operation, params) => {
      if (operation === "ports") return { connected: false, result: { ports: ["/dev/ttyACM1"] } };
      if (operation === "authorize") {
        authorized.push(params.port);
        return { connected: false, result: {} };
      }
      if (operation === "connect") {
        connections.push(params);
        const reply = await worker.run(operation, { ...params, demo: true });
        discovered = reply.result?.motors;
        return reply;
      }
      if (operation === "poll") {
        await waitForPoll;
        if (failPolling) return { connected: true, faulted: false, error: "Status read failed" };
      }
      if (operation === "setMode5") writes.push(params);
      return worker.run(operation, params);
    });
    await page.evaluate(() => { window.motorApp.dxl = window.testDxl; });
    await navigate(page, "Dynamixel");
    await page.getByLabel("Serial port").fill("/dev/ttyACM1");
    await page.getByRole("button", { name: "Grant port access" }).click();
    await expect(page.getByText("Access ready for /dev/ttyACM1. Connect to continue.")).toBeVisible();
    expect(authorized).toEqual(["/dev/ttyACM1"]);

    const connect = page.getByRole("button", { name: "Connect", exact: true });
    const serialPort = page.getByLabel("Serial port");
    await expect(page.getByRole("checkbox", { name: "Demo motors" })).toHaveCount(0);
    await serialPort.clear();
    await expect(connect).toBeDisabled();
    await serialPort.fill("/dev/ttyACM1");
    await connect.click();
    await expect(page.getByText("Hardware connected")).toBeVisible();
    expect(connections).toEqual([{ port: "/dev/ttyACM1", baud: 1_000_000 }]);
    const { motor_id: zeroId } = discovered[0];
    const { motor_id: modeId, operating_mode: oldMode } =
      discovered.find((motor) => motor.motor_id !== zeroId && motor.operating_mode !== 5);
    const takenIds = new Set(discovered.map((motor) => motor.motor_id));
    const newId = Array.from({ length: 253 }, (_, id) => id).find((id) => !takenIds.has(id));
    const motors = page.getByRole("table", { name: "Dynamixel motors" });
    const selectMotor = (id) => page.getByRole("checkbox", { name: `Select ${id}`, exact: true });
    await expect(page.getByLabel("Motor IDs", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Read IDs" })).toHaveCount(0);
    await motors.getByRole("checkbox", { name: "Select all filtered rows" }).uncheck();
    await selectMotor(zeroId).check();
    await expect(page.getByRole("button", { name: "Preview zero" })).toHaveCount(0);
    await page.getByRole("button", { name: "Save zero" }).click();
    await expect(page.getByText(/Zero saved and verified/)).toBeVisible();
    const zeroRow = motors.getByRole("row").filter({ has: selectMotor(zeroId) });
    await expect(zeroRow.getByRole("cell", { name: "2048", exact: true })).toBeVisible();
    await expect(zeroRow.getByRole("cell", { name: "0.000 rad / 0.0°", exact: true })).toBeVisible();

    await page.getByLabel("New ID").fill(String(newId));
    await page.getByRole("button", { name: "Save ID" }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(selectMotor(newId)).toBeChecked();
    await navigate(page, "Setup");
    await expect(page.getByRole("button", { name: "Scan motors", exact: true })).toBeVisible();
    waitForPoll = new Promise((resolve) => { resumePoll = resolve; });
    await navigate(page, "Dynamixel");
    await expect(selectMotor(newId)).toBeChecked();
    await expect(page.getByRole("button", { name: "Save zero" })).toBeDisabled();
    resumePoll();
    await expect(page.getByRole("button", { name: "Save zero" })).toBeEnabled();

    await selectMotor(newId).uncheck();
    await selectMotor(modeId).check();
    const modeButton = page.getByRole("button", { name: "Set Mode 5" });
    await modeButton.click();
    failPolling = true;
    await expect(page.getByText("Status read failed")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(modeButton).toBeDisabled();
    await expect(page.getByRole("button", { name: "Torque off" })).toBeEnabled();
    expect(writes).toEqual([]);
    failPolling = false;
    await modeButton.click();
    await expect(page.getByRole("dialog")).toContainText(`ID ${modeId} (Mode ${oldMode})`);
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByText(`Mode 5 verified for IDs ${modeId}.`, { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Set Mode 5" })).toBeDisabled();

    await expect(page.getByLabel("Baud rate")).toHaveValue("57600");
    await expect(motors.getByRole("columnheader", { name: "Baud rate (bps)" })).toBeVisible();
    const settingsRow = motors.getByRole("row").filter({ has: selectMotor(modeId) });
    await expect(settingsRow.getByRole("cell", { name: "57,600", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Set 1 Mbps" }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByText(`1 Mbps verified for ID ${modeId}.`, { exact: false })).toBeVisible();
    await expect(page.getByLabel("Baud rate")).toHaveValue("1000000");
    await expect(motors.getByRole("cell", { name: "1,000,000", exact: true })).toBeVisible();
    await expect(selectMotor(modeId)).toBeChecked();
    await expect(selectMotor(newId)).toHaveCount(0);
  } finally {
    resumePoll?.();
    await worker.close();
    await rm(backupDir, { recursive: true, force: true });
  }
});
test("startup, navigation, and disconnected states never send motion commands", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const [name, heading] of [
    ["Test", "Motor test"],
    ["Setup", "Motor setup"],
    ["Files", "Recordings"],
    ["Calibrate", "Calibration"],
  ]) {
    await navigate(page, name);
    await expect(
      page.getByRole("main", { name: heading, exact: true }),
    ).toBeVisible();
  }
  const operations = await page.evaluate(() => window.testMotor.calls.map(c => c.operation));
  expect(operations.filter(op => !["interfaces", "usbAdapters"].includes(op))).toEqual([]);
  expect(await page.evaluate(() => window.testMotor.intents)).toEqual([]);
  expect(errors).toEqual([]);
});
test("calibration previews, review, saved results, and chart views work", async ({
  page,
}, info) => {
  await connect(page);
  await page
    .getByRole("button", { name: "Motion preview", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: /Target speed in/ }),
  ).toBeVisible();
  const start = page.getByRole("button", {
    name: "Start calibration",
    exact: true,
  });
  await expect(start).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "Motor secured · limits reviewed" })
    .check();
  await expect(start).toBeEnabled();
  await navigate(page, "Files");
  await page.getByRole("button", { name: "Open recording", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show folder" })).toBeVisible();
  await navigate(page, "Calibrate");
  await expect(start).toBeEnabled();
  await page.getByLabel("Speed cutoff").fill("3");
  await expect(
    page.getByRole("checkbox", { name: "Motor secured · limits reviewed" }),
  ).not.toBeChecked();
  await expect(start).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "Motor secured · limits reviewed" })
    .check();
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByText("Validated", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start calibration", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Limits", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("0.0100", { exact: false }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Residuals", exact: true }).click();
  await expect(
    page.getByRole("img", { name: /Velocity residual/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Torque", exact: true }).click();
  await expect(page.getByRole("img", { name: /Torque in Nm/ })).toBeVisible();
  await page.screenshot({
    path: info.outputPath("calibration-result.png"),
    fullPage: true,
  });
});
test("register reads, search, confirmation, and writes use the selected motor", async ({
  page,
}) => {
  await connect(page);
  await navigate(page, "Setup");
  await page.getByRole("button", { name: "Read", exact: true }).click();
  const value = page.getByLabel("New value", { exact: true });
  await expect(value).toHaveValue("1");
  await value.fill("2");
  await page
    .getByRole("button", { name: "Save to motor", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.testMotor.calls.some((c) => c.operation === "registerWrite"),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Current Kp saved." }),
  ).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Search registers" })
    .fill("missing");
  await expect(page.getByText("No matching registers.")).toBeVisible();
});
test("read-only registers show only the read action", async ({ page }) => {
  await connect(page);
  await navigate(page, "Setup");
  await page.getByRole("button", { name: /Bus voltage/ }).click();
  await expect(
    page.getByRole("button", { name: "Read", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("New value", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save to motor", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Read", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        window.testMotor.calls.findLast(
          (call) => call.operation === "registerRead",
        ).params.index,
    ),
  ).toBe(0x701c);
  await page.getByRole("button", { name: /Current Kp/ }).click();
  await expect(page.getByLabel("New value", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save to motor", exact: true }),
  ).toBeDisabled();
});
test("switching workspaces starts at the top of the page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await connect(page);
  await navigate(page, "Setup");
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  await navigate(page, "Test");
  await expect(
    page.getByRole("main", { name: "Motor test", exact: true }),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});
test("desktop USB connection is automatic and refresh preserves the selected motor", async ({
  page,
}) => {
  for (const platform of ["darwin", "win32"]) {
    const desktop = await page.context().newPage();
    await desktop.addInitScript(installBridge, {
      ...fixture,
      platform,
      interfaces: [],
      usbAdapters: [
        {
          id: "gsusb:0102:1",
          bus_id: "QA",
          address: 1,
          vendor_id: 0x1d50,
          product_id: 0x606f,
          accessible: true,
        },
      ],
    });
    await desktop.goto("/");
    await expect(
      desktop.getByRole("combobox", { name: "Adapter", exact: true }),
    ).toHaveCount(0);
    await expect(
      desktop.getByRole("combobox", { name: "USB adapter", exact: true }),
    ).toHaveText(/GS USB/);
    await expect(
      desktop.getByRole("button", { name: "Scan motors", exact: true }),
    ).toBeEnabled();
    await navigate(desktop, "Setup");
    await expect(
      desktop.getByRole("heading", { name: "Motor identity", exact: true }),
    ).toHaveCount(0);
    await navigate(desktop, "Calibrate");
    await connect(desktop);
    await desktop.getByLabel("Torque limit").fill("0.7");
    await desktop
      .getByRole("button", { name: "Refresh adapters", exact: true })
      .click();
    await expect(desktop.locator(".connection-badge")).toHaveText("Connected");
    await expect(desktop.getByLabel("Torque limit")).toHaveValue("0.7");
    expect(
      await desktop.evaluate(
        () =>
          window.testMotor.calls.filter((call) => call.operation === "scan")
            .length,
      ),
    ).toBe(1);
    await desktop.evaluate(() => {
      window.testMotor.adapters.usb = [];
    });
    await desktop
      .getByRole("button", { name: "Refresh adapters", exact: true })
      .click();
    await expect(desktop.locator(".connection-badge")).toHaveText(
      "Not connected",
    );
    await expect(
      desktop.getByRole("button", { name: "Scan motors", exact: true }),
    ).toBeDisabled();
    await expect(desktop.getByLabel("Torque limit")).toHaveCount(0);
    await desktop.close();
  }
});
test("ID and firmware changes stay connected and keep settings without another scan", async ({
  page,
}) => {
  await connect(page);
  await page.getByLabel("Torque limit").fill("0.7");
  await navigate(page, "Setup");
  await page.getByLabel("New motor ID", { exact: true }).fill("61");
  await page.getByRole("button", { name: "Change ID", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toContainText("Scan again");
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  const identity = page.locator('[data-slot="card"]').filter({
    has: page.getByRole("heading", { name: "Motor identity", exact: true }),
  });
  await expect(identity.locator(".identity-current strong")).toHaveText("61");
  await expect(page.locator(".connection-badge")).toHaveText("Connected");
  await expect(page.getByLabel("New motor ID", { exact: true })).toHaveValue(
    "",
  );
  await page
    .getByRole("button", { name: "Download and verify", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Update firmware", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Update firmware", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("ID 61");
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.locator(".firmware-version")).toHaveText("1.2.4");
  await expect(page.locator(".connection-badge")).toHaveText("Connected");
  await page.getByRole("button", { name: "Connection", exact: true }).click();
  await page.getByRole("combobox", { name: "Motor", exact: true }).click();
  await page
    .getByRole("option", { name: "RS-00 · ID 61", exact: true })
    .click();
  await expect(page.locator(".firmware-version")).toHaveText("1.2.4");
  await navigate(page, "Calibrate");
  await expect(page.getByLabel("Torque limit")).toHaveValue("0.7");
  await expect(
    page.getByRole("checkbox", { name: "Motor secured · limits reviewed" }),
  ).not.toBeChecked();
  await page
    .getByRole("checkbox", { name: "Motor secured · limits reviewed" })
    .check();
  await expect(
    page.getByRole("button", { name: "Start calibration", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Start calibration", exact: true })
    .click();
  const calls = await page.evaluate(() => window.testMotor.calls);
  expect(calls.filter((call) => call.operation === "scan")).toHaveLength(1);
  for (const operation of ["firmwarePrepare", "firmwareUpdate", "calibrate"])
    expect(calls.find((call) => call.operation === operation).params.id).toBe(
      61,
    );
});
test("live monitoring starts disabled, jog releases, and navigation stops monitoring", async ({
  page,
}) => {
  await connect(page);
  await navigate(page, "Test");
  await page
    .getByRole("button", { name: "Start monitoring", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Enable motor", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "Motor secured · shaft clear" })
    .check();
  await expect(
    page.getByRole("button", { name: "Enable motor", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Enable motor", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Enable motor", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Disable motor", exact: true }),
  ).toHaveCount(1);
  const jog = page.getByRole("button", { name: "Jog +", exact: true });
  await expect(jog).toBeEnabled();
  const box = await jog.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect
    .poll(() => page.evaluate(() => window.testMotor.intents.at(-1)?.direction))
    .toBe(1);
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.testMotor.intents.at(-1)?.direction))
    .toBe(0);
  const reverse = page.getByRole("button", { name: "Jog −", exact: true });
  const disable = page.getByRole("button", { name: "Disable motor", exact: true });
  await reverse.focus();
  await page.keyboard.down("Space");
  await expect
    .poll(() => page.evaluate(() => window.testMotor.intents.at(-1)?.direction))
    .toBe(-1);
  await disable.focus();
  await expect
    .poll(() => page.evaluate(() => window.testMotor.intents.at(-1)?.direction))
    .toBe(0);
  await page.keyboard.up("Space");
  await disable.click();
  await expect(
    page.getByRole("button", { name: "Enable motor", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Disable motor", exact: true }),
  ).toHaveCount(0);
  await expect(jog).toBeDisabled();
  await navigate(page, "Files");
  await expect(page.getByRole("main", { name: "Recordings" })).toBeVisible();
  expect(
    await page.evaluate(() => window.testMotor.intents.at(-1)?.enabled),
  ).toBe(false);
});
test("recordings show identity, download individual files, and require confirmation to delete", async ({
  page,
}) => {
  await navigate(page, "Files");
  const run = page.locator(".recording-item").first();
  await run.getByRole("button", { name: "Run actions", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Entire run (.zip)", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Open recording", exact: true })
    .click();
  await expect(page.locator(".recording-identity")).toContainText(
    "0102030405060708",
  );
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Training recording (.csv)", exact: true })
    .click();
  expect(
    await page.evaluate(
      () =>
        window.testMotor.calls.find((c) => c.operation === "exportRun").params
          .file,
    ),
  ).toBe("training.csv");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete run", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Permanently delete");
  expect(
    await page.evaluate(() =>
      window.testMotor.calls.some((c) => c.operation === "deleteRun"),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(
    page.getByText("No recording open", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No saved runs.", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.testMotor.calls.filter((c) => c.operation === "deleteRun")
          .length,
    ),
  ).toBe(1);
});

test("saved measurements can be fitted before a report exists", async ({ page }) => {
  await page.evaluate(() => {
    const { listRuns, loadRun, run } = window.motorApp;
    let fitted = false;
    window.motorApp.listRuns = async () => (await listRuns()).map(item => ({ ...item, completed: fitted }));
    window.motorApp.loadRun = async directory => {
      const recording = await loadRun(directory);
      return fitted ? recording : { ...recording, report: null, files: ["session.json"] };
    };
    window.motorApp.run = async (operation, params) => {
      const result = await run(operation, params);
      if (operation === "analyze") fitted = true;
      return result;
    };
  });
  await navigate(page, "Files");
  const run = page.locator(".recording-open");
  await run.click();
  await expect(run).toContainText("No report");
  await page.getByRole("button", { name: "Refit recording", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Validated", { exact: true })).toBeVisible();
  await expect(run).not.toContainText("No report");
});

test("recording charts retain short torque spikes in long traces", async ({ page }) => {
  const recording = structuredClone(fixture.report);
  const validation = recording.replays.find(trace => trace.name === "validation");
  validation.command_t = Array.from({ length: 5000 }, (_, i) => i / 1000);
  validation.command_torque = Array(5000).fill(0);
  validation.command_torque[100] = 40;
  validation.command_torque[101] = -40;
  await page.evaluate(report => {
    const load = window.motorApp.pickRun;
    window.motorApp.pickRun = async () => ({ ...await load(), report });
  }, recording);
  await navigate(page, "Files");
  await page.getByRole("button", { name: "Open recording", exact: true }).click();
  await page.getByRole("button", { name: "Torque", exact: true }).click();
  const chart = page.getByRole("img", { name: /Torque in Nm/ });
  await expect.poll(async () => {
    const ticks = (await chart.locator("text").allTextContents()).map(Number);
    return Math.min(...ticks) <= -30 && Math.max(...ticks) >= 30;
  }).toBe(true);
});

test("appearance persists and saved recordings work without hardware", async ({
  page,
}, info) => {
  await navigate(page, "Settings");
  await page.getByRole("combobox", { name: "Appearance", exact: true }).click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass("dark");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveClass("dark");
  await navigate(page, "Files");
  await page
    .getByRole("button", { name: "Open recording", exact: true })
    .click();
  await expect(page.getByText("Validated", { exact: true })).toBeVisible();
  await page.screenshot({
    path: info.outputPath("recordings-dark.png"),
    fullPage: true,
  });
});
for (const width of [320, 720, 1050, 1440]) {
  test(`all workspaces fit a ${width}px viewport`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of ["Calibrate", "Test", "Setup", "Files"]) {
      await navigate(page, name);
      await expect(page.getByRole("main")).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: info.outputPath(`${name.toLowerCase()}-${width}.png`),
        fullPage: true,
      });
    }
    if (width === 320) {
      await navigate(page, "Settings");
      await expect(page.getByRole("dialog")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
  });
}

test("Motomind sidebar collapses and opens as a mobile sheet", async ({
  page,
}) => {
  const sidebar = page.locator('[data-slot="sidebar"][data-state]');
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await navigate(page, "Test");
  await expect(page.getByRole("main", { name: "Motor test" })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await expect(page.getByRole("dialog", { name: "Sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Sidebar" })).not.toBeVisible();
  await expect(page.getByRole("main", { name: "Recordings" })).toBeVisible();
});

test("a background update marks Settings in the collapsed sidebar", async ({ page }) => {
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  const dot = settings.locator(".settings-update-dot");
  await expect(dot).toHaveCount(0);

  await page.evaluate(() => window.testMotor.emit({
    type: "updateChecked",
    result: { available: true, version: "0.1.23" },
  }));
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  await expect(settings).toHaveAccessibleDescription("Update available");
  await expect(dot).toBeVisible();
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await expect(dot).toBeVisible();

  await settings.click();
  await expect(page.getByText("Version 0.1.23 is available.")).toBeVisible();
  await page.getByRole("button", { name: "Install update" }).click();
  expect(await page.evaluate(() => window.testMotor.calls.at(-1).version)).toBe("0.1.23");
  await page.getByRole("button", { name: "Check for update" }).click();
  await expect(page.getByText("You have the latest version.")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dot).toHaveCount(0);
});

test.describe("calibration settings with a decimal comma", () => {
  test.use({ locale: "de-DE" });

  test("calibration uses the reviewed limits and preserves unedited preset precision", async ({ page }) => {
    await connect(page);
    const speed = page.getByLabel("Speed cutoff");
    const travel = page.getByLabel("Travel limit");
    const review = page.getByRole("checkbox", { name: "Motor secured · limits reviewed" });
    const start = page.getByRole("button", { name: "Start calibration", exact: true });
    await expect(speed).toHaveValue("14,844");
    await speed.focus();
    await speed.press("Tab");
    const advanced = page.getByRole("button", { name: "Advanced settings", exact: true });
    await advanced.click();
    await expect(page.getByLabel("Armature")).toHaveValue("0,000001");
    await advanced.click();

    await review.check();
    await expect(start).toBeEnabled();
    await travel.fill(",");
    await expect(review).not.toBeChecked();
    await expect(page.getByRole("alert")).toBeVisible();
    await review.check();
    await expect(start).toBeDisabled();

    await travel.fill("2,5");
    await review.check();
    await start.click();
    const config = await page.evaluate(() =>
      window.testMotor.calls.find(call => call.operation === "calibrate").params.config
    );
    expect(config.travel_limit).toBe(2.5);
    expect(config.speed_limit).toBe(fixture.preset.speed_limit);
    expect(config.baseline.armature).toBe(fixture.preset.baseline.armature);
    await navigate(page, "Calibrate");
    await expect(review).not.toBeChecked();
    await expect(start).toBeDisabled();
  });
});

test("calibration keeps advanced options and motion preview out of the main flow", async ({
  page,
}, info) => {
  await expect(
    page.getByRole("button", { name: "Start calibration", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Limits", exact: true }),
  ).toHaveCount(0);
  await connect(page);
  await expect(
    page.getByRole("button", { name: "Advanced settings", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("button", { name: "Motion preview", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("button", { name: "Start calibration", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: info.outputPath("calibration-ready.png"),
    fullPage: true,
  });
});

test("connected calibration stays readable at narrow widths and in dark mode", async ({
  page,
}, info) => {
  await connect(page);
  await expect(
    page.getByText("40 s training · 20 s validation", { exact: true }),
  ).toBeVisible();
  for (const width of [320, 720, 1050, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "Start calibration", exact: true }),
    ).toBeInViewport();
    await expect(page.getByLabel("Speed cutoff")).toHaveValue("14.844");
    await page.screenshot({
      path: info.outputPath(`ready-${width}.png`),
      fullPage: true,
    });
  }
  await navigate(page, "Settings");
  await page.getByRole("combobox", { name: "Appearance", exact: true }).click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("html")).toHaveClass("dark");
  await page.screenshot({
    path: info.outputPath("ready-dark.png"),
    fullPage: true,
  });
});
