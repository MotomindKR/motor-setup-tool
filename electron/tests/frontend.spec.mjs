import { test, expect } from "@playwright/test";
import { fixture, installBridge } from "./fixtures.mjs";
import { clickSidebarControl, selectWorkspace } from "./navigation.mjs";
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
const robStridePages = [
  ["Calibrate", "Calibration"],
  ["Test", "Motor test"],
  ["Setup", "Motor setup"],
  ["Files", "Recordings"],
];
async function openSettings(page, name = "Settings") {
  await clickSidebarControl(page, page.getByRole("button", { name, exact: true }));
}
function robStrideTools(scope) {
  return scope.getByRole("navigation", { name: "RobStride tools", exact: true });
}
async function navigateRobStride(page, name) {
  await clickSidebarControl(page, robStrideTools(page).getByRole("button", { name, exact: true }));
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
    await selectWorkspace(page, "Dynamixel");
    await page.getByLabel("Serial port", { exact: true }).fill("/dev/ttyACM1");
    await page.getByRole("option", { name: "/dev/ttyACM1" }).click();
    await page.getByRole("button", { name: "Grant port access" }).click();
    await expect(page.getByText("Access ready for /dev/ttyACM1. Connect to continue.")).toBeVisible();
    expect(authorized).toEqual(["/dev/ttyACM1"]);

    const connect = page.getByRole("button", { name: "Connect", exact: true });
    const serialPort = page.getByLabel("Serial port");
    await serialPort.clear();
    await expect(connect).toBeDisabled();
    await serialPort.fill("/dev/ttyUSB3");
    await serialPort.press("Tab");
    await connect.click();
    await expect(page.getByText("Hardware connected")).toBeVisible();
    expect(connections).toEqual([{ port: "/dev/ttyUSB3", baud: 1_000_000 }]);
    const { motor_id: zeroId } = discovered[0];
    const { motor_id: modeId, operating_mode: oldMode } =
      discovered.find((motor) => motor.motor_id !== zeroId && motor.operating_mode !== 5);
    const takenIds = new Set(discovered.map((motor) => motor.motor_id));
    const newId = Array.from({ length: 253 }, (_, id) => id).find((id) => !takenIds.has(id));
    const motors = page.getByRole("table", { name: "Dynamixel motors" });
    const selectMotor = (id) => page.getByRole("checkbox", { name: `Select ${id}`, exact: true });
    await expect(motors.getByRole("columnheader", { name: "Baud rate (bps)" })).toBeVisible();
    await expect(motors.getByRole("columnheader", { name: "Direction" })).toBeVisible();
    await expect(motors.getByRole("columnheader", { name: "Model" })).toBeVisible();
    await expect(motors.getByRole("columnheader", { name: "Position (pulse)" })).toBeVisible();
    await expect(motors.getByRole("columnheader", { name: "Joint angle" })).toBeVisible();
    await expect(motors.getByRole("columnheader", { name: "Mode", exact: true })).toHaveCount(0);
    const saveZero = page.getByRole("button", { name: "Save zero" });
    await expect(saveZero).toBeDisabled();
    await selectMotor(zeroId).check();
    const filter = page.getByRole("textbox", { name: "Filter motors" });
    await filter.fill(String(discovered.find(motor => motor.motor_id === modeId).position));
    await expect(selectMotor(modeId)).toBeVisible();
    await expect(selectMotor(zeroId)).toHaveCount(0);
    await expect(page.getByText(`Selected IDs: ${zeroId}`, { exact: true }).first()).toBeVisible();
    await saveZero.click();
    await filter.clear();
    await expect(page.getByText(/Zero saved and verified/)).toBeVisible();
    const zeroRow = motors.getByRole("row").filter({ has: selectMotor(zeroId) });
    await expect(zeroRow.getByRole("cell", { name: "Forward", exact: true })).toBeVisible();
    await expect(zeroRow.getByRole("cell", { name: discovered[0].name, exact: true })).toBeVisible();
    await expect(zeroRow.getByRole("cell", { name: "2048", exact: true })).toBeVisible();
    await expect(zeroRow.getByRole("cell", { name: "0.000 rad / 0.0°", exact: true })).toBeVisible();
    const details = zeroRow.getByRole("button", { name: `Details ${zeroId}`, exact: true });
    await expect(motors.getByText("Torque", { exact: true })).toHaveCount(0);
    await details.click();
    await expect(motors.getByText("Torque", { exact: true })).toBeVisible();
    await details.click();

    await page.getByLabel("New ID").fill(String(newId));
    await page.getByRole("button", { name: "Save ID" }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(selectMotor(newId)).toBeChecked();
    await selectWorkspace(page, "RobStride");
    await expect(page.getByRole("button", { name: "Scan motors", exact: true })).toBeVisible();
    waitForPoll = new Promise((resolve) => { resumePoll = resolve; });
    await selectWorkspace(page, "Dynamixel");
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
    await expect(modeButton).toBeEnabled();
    await expect(page.getByText("Status read failed")).toHaveCount(0);
    await modeButton.click();
    await expect(page.getByRole("dialog")).toContainText(`ID ${modeId} (Mode ${oldMode})`);
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByText(`Mode 5 verified for IDs ${modeId}.`, { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Set Mode 5" })).toBeDisabled();

    const settingsRow = motors.getByRole("row").filter({ has: selectMotor(modeId) });
    await expect(settingsRow.getByRole("cell", { name: "57,600", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Set 1 Mbps" }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByText(`1 Mbps verified for ID ${modeId}.`, { exact: false })).toBeVisible();
    await expect(page.getByText("/dev/ttyUSB3 · 1,000,000 bps")).toBeVisible();
    await expect(settingsRow.getByRole("cell", { name: "1,000,000", exact: true })).toBeVisible();
    await expect(selectMotor(modeId)).toBeChecked();
    await expect(selectMotor(newId)).toHaveCount(0);
    await page.getByRole("combobox", { name: "Direction", exact: true }).click();
    await page.getByRole("option", { name: "Reverse", exact: true }).click();
    await page.getByRole("button", { name: "Save direction", exact: true }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(settingsRow.getByRole("cell", { name: "Reverse", exact: true })).toBeVisible();
  } finally {
    resumePoll?.();
    await worker.close();
    await rm(backupDir, { recursive: true, force: true });
  }
});
test("the sidebar workspace picker switches tools and restores the last RobStride tool", async ({ page }) => {
  const sidebar = page.locator('[data-slot="sidebar"]');
  const picker = sidebar.getByRole("combobox", { name: "Workspace", exact: true });
  const tools = robStrideTools(sidebar);
  const calibrate = tools.getByRole("button", { name: "Calibrate", exact: true });
  const setup = tools.getByRole("button", { name: "Setup", exact: true });
  const options = page.getByRole("listbox").getByRole("option");
  const main = page.getByRole("main");
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });

  await expect(picker.getByText("RobStride", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Workspace", exact: true })).toHaveCount(1);
  await expect(robStrideTools(page)).toHaveCount(1);
  await expect(tools.getByRole("button")).toHaveText(robStridePages.map(([name]) => name));
  await expect(calibrate).toHaveAttribute("aria-current", "page");
  for (const [name] of robStridePages) {
    await expect(main.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  const pickerBox = await picker.boundingBox();
  const calibrateBox = await calibrate.boundingBox();
  expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(calibrateBox.y);
  await expect(breadcrumb).toContainText(/RobStride.*Calibration/);

  await picker.focus();
  await page.keyboard.press("Tab");
  await expect(calibrate).toBeFocused();
  await navigateRobStride(page, "Setup");
  await expect(setup).toHaveAttribute("aria-current", "page");
  await expect(tools.locator('[aria-current="page"]')).toHaveCount(1);

  await picker.press("Enter");
  await expect(options).toHaveText(["RobStride", "Dynamixel", "Camera"]);
  await expect(page.getByRole("option", { name: "RobStride", selected: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Dynamixel", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main", { name: "Dynamixel setup" })).toBeVisible();
  await expect(picker.getByText("Dynamixel", { exact: true })).toBeVisible();
  await expect(picker).toHaveAttribute("aria-expanded", "false");
  await expect(tools).toHaveCount(0);
  const dxlTools = sidebar.getByRole("navigation", { name: "Dynamixel tools", exact: true });
  await expect(dxlTools.getByRole("button")).toHaveText(["Motor setup"]);
  await expect(dxlTools.getByRole("button", { name: "Motor setup", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(breadcrumb).toContainText(/Dynamixel.*Motor setup/);

  await selectWorkspace(page, "Camera");
  const cameraView = page.getByRole("main", { name: "Camera verification" });
  await expect(cameraView).toBeVisible();
  await expect(picker.getByText("Camera", { exact: true })).toBeVisible();
  await expect(dxlTools).toHaveCount(0);
  const cameraTools = sidebar.getByRole("navigation", { name: "Camera tools", exact: true });
  await expect(cameraTools.getByRole("button")).toHaveText(["Focus check"]);
  await expect(cameraTools.getByRole("button", { name: "Focus check", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(breadcrumb).toContainText(/Camera.*Focus check/);
  await openSettings(page);
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(cameraView).toBeVisible();
  await expect(picker.getByText("Camera", { exact: true })).toBeVisible();

  await selectWorkspace(page, "RobStride");
  await expect(page.getByRole("main", { name: "Motor setup" })).toBeVisible();
  await expect(picker.getByText("RobStride", { exact: true })).toBeVisible();
  await expect(setup).toHaveAttribute("aria-current", "page");
  await expect(breadcrumb).toContainText(/RobStride.*Motor setup/);
});
test("startup, navigation, and disconnected states never send motion commands", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const [name, heading] of robStridePages) {
    await navigateRobStride(page, name);
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
  await navigateRobStride(page, "Files");
  await page.getByRole("button", { name: "Open recording", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show folder" })).toBeVisible();
  await navigateRobStride(page, "Calibrate");
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
  await expect(page.getByRole("main", { name: "Recordings" })).toBeVisible();
  const files = robStrideTools(page).getByRole("button", { name: "Files" });
  await expect(files).toHaveAttribute("aria-current", "page");
  await selectWorkspace(page, "Camera");
  await selectWorkspace(page, "RobStride");
  await expect(files).toHaveAttribute("aria-current", "page");
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
  await navigateRobStride(page, "Setup");
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
  await navigateRobStride(page, "Setup");
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
test("switching RobStride tools starts at the top of the page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await connect(page);
  await navigateRobStride(page, "Setup");
  await robStrideTools(page).getByRole("button", { name: "Test", exact: true }).focus();
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  await page.keyboard.press("Enter");
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
    await navigateRobStride(desktop, "Setup");
    await expect(
      desktop.getByRole("heading", { name: "Motor identity", exact: true }),
    ).toHaveCount(0);
    await navigateRobStride(desktop, "Calibrate");
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
  await navigateRobStride(page, "Setup");
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
  await navigateRobStride(page, "Calibrate");
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
  await navigateRobStride(page, "Test");
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
  await selectWorkspace(page, "Camera");
  await expect(page.getByRole("main", { name: "Camera verification" })).toBeVisible();
  expect(
    await page.evaluate(() => window.testMotor.intents.at(-1)?.enabled),
  ).toBe(false);
  await selectWorkspace(page, "RobStride");
  await expect(page.getByRole("main", { name: "Motor test" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start monitoring", exact: true })).toBeEnabled();
});
test("recordings show identity, download individual files, and require confirmation to delete", async ({
  page,
}) => {
  await navigateRobStride(page, "Files");
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
  await navigateRobStride(page, "Files");
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
  await navigateRobStride(page, "Files");
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
  await openSettings(page);
  await page.getByRole("combobox", { name: "Appearance", exact: true }).click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass("dark");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveClass("dark");
  await navigateRobStride(page, "Files");
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
    for (const [name, title] of [
      ...robStridePages,
      ["Dynamixel", "Dynamixel setup"],
      ["Camera", "Camera verification"],
    ]) {
      if (name === "Dynamixel" || name === "Camera") {
        await selectWorkspace(page, name);
      } else {
        await navigateRobStride(page, name);
      }
      await expect(page.getByRole("main", { name: title, exact: true })).toBeVisible();
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
      await openSettings(page);
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
  const trigger = page.locator('[data-slot="sidebar-trigger"]');
  const compactTools = robStrideTools(sidebar);
  const picker = sidebar.getByRole("combobox", { name: "Workspace", exact: true });
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await trigger.click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await expect(picker).toBeInViewport();
  for (const [name] of robStridePages) {
    const tool = compactTools.getByRole("button", { name, exact: true });
    await expect(tool).toBeInViewport();
    await expect(tool.locator("svg")).toBeVisible();
  }
  await navigateRobStride(page, "Test");
  await expect(page.getByRole("main", { name: "Motor test" })).toBeVisible();
  await selectWorkspace(page, "Dynamixel");
  await expect(page.getByRole("main", { name: "Dynamixel setup" })).toBeVisible();
  await selectWorkspace(page, "RobStride");
  await expect(page.getByRole("main", { name: "Motor test" })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  const sheet = page.getByRole("dialog", { name: "Sidebar" });
  await trigger.click();
  await expect(sheet).toBeVisible();
  const mobilePicker = sheet.getByRole("combobox", { name: "Workspace", exact: true });
  await expect(mobilePicker.getByText("RobStride", { exact: true })).toBeVisible();
  await expect(robStrideTools(sheet).getByRole("button")).toHaveText(robStridePages.map(([name]) => name));
  await mobilePicker.click();
  const options = page.getByRole("listbox").getByRole("option");
  await expect(options).toHaveText(["RobStride", "Dynamixel", "Camera"]);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeVisible();
  await expect(mobilePicker).toBeFocused();
  await mobilePicker.press("Enter");
  await expect(page.getByRole("option", { name: "RobStride", selected: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sheet).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await mobilePicker.click();
  await page.getByRole("option", { name: "Camera", exact: true }).click();
  await expect(sheet).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("main", { name: "Camera verification" })).toBeVisible();
  await selectWorkspace(page, "RobStride");
  await expect(sheet).not.toBeVisible();
  await expect(page.getByRole("main", { name: "Motor test" })).toBeVisible();
  await navigateRobStride(page, "Files");
  await expect(sheet).not.toBeVisible();
  await expect(trigger).toBeFocused();
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
  await expect(page.getByRole("button", { name: "Check for update" })).toBeDisabled();
  await page.evaluate(() => window.testMotor.emit({
    type: "updateFailure", version: "0.1.17", message: "Installation was denied",
  }));
  await expect(page.getByText("Installation was denied")).toBeVisible();
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
    await navigateRobStride(page, "Calibrate");
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
  await openSettings(page);
  await page.getByRole("combobox", { name: "Appearance", exact: true }).click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("html")).toHaveClass("dark");
  await page.screenshot({
    path: info.outputPath("ready-dark.png"),
    fullPage: true,
  });
});

test("switching language preserves the motor session and persists across launches", async ({ page }) => {
  await connect(page);
  await openSettings(page);
  await page.getByRole("combobox", { name: "Language", exact: true }).click();
  await page.getByRole("option", { name: "한국어", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.getByRole("dialog", { name: "앱 설정" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "보정 시작" })).toBeVisible();
  const tools = page.getByRole("navigation", { name: "RobStride 도구" });
  const picker = page.getByRole("combobox", { name: "작업 영역", exact: true });
  await expect(picker.getByText("RobStride", { exact: true })).toBeVisible();
  await picker.click();
  await expect(page.getByRole("listbox").getByRole("option")).toHaveText(["RobStride", "다이나믹셀", "카메라"]);
  await page.keyboard.press("Escape");
  await expect(picker).toBeFocused();
  await tools.getByRole("button", { name: "테스트", exact: true }).click();
  await expect(page.getByRole("heading", { name: "모터 제어", exact: true })).toBeVisible();
  await tools.getByRole("button", { name: "설정", exact: true }).click();
  await expect(page.getByRole("heading", { name: "모터 레지스터", exact: true })).toBeVisible();
  await selectWorkspace(page, "다이나믹셀", "작업 영역");
  await expect(page.getByRole("heading", { name: "다이나믹셀 연결", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "다이나믹셀 도구", exact: true })).toBeVisible();
  await selectWorkspace(page, "카메라", "작업 영역");
  await expect(page.getByRole("main", { name: "카메라 검증", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "카메라 도구", exact: true })).toBeVisible();
  await selectWorkspace(page, "RobStride", "작업 영역");
  await expect(tools.getByRole("button", { name: "설정", exact: true })).toHaveAttribute("aria-current", "page");
  await tools.getByRole("button", { name: "파일", exact: true }).click();
  await expect(page.getByRole("heading", { name: "저장된 기록", exact: true })).toBeVisible();
  await page.reload();
  await openSettings(page, "앱 설정");
  await expect(page.getByRole("combobox", { name: "언어" })).toContainText("한국어");
  await page.getByRole("combobox", { name: "언어" }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});
