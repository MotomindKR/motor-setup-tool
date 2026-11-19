import { test, expect } from "@playwright/test";
import { fixture, installBridge } from "./fixtures.mjs";

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
  expect(
    await page.evaluate(() => window.testMotor.calls.map((c) => c.operation)),
  ).toEqual(["interfaces", "usbAdapters"]);
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
  await page.keyboard.press("Shift+Tab");
  await expect(disable).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.testMotor.intents.at(-1)?.direction))
    .toBe(0);
  await page.keyboard.up("Space");
  await page
    .getByRole("button", { name: "Disable motor", exact: true })
    .click();
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
  await expect(page.getByRole("button", { name: "Install update" })).toBeEnabled();
  await page.getByRole("button", { name: "Check for update" }).click();
  await expect(page.getByText("You have the latest version.")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dot).toHaveCount(0);
});

test("number fields show short decimals and retain the precise preset", async ({
  page,
}) => {
  await connect(page);
  const speed = page.getByLabel("Speed cutoff");
  await expect(speed).toHaveValue("14.844");
  await speed.focus();
  await speed.press("Tab");
  await page
    .getByRole("button", { name: "Advanced settings", exact: true })
    .click();
  await expect(page.getByLabel("Armature")).toHaveValue("0.000001");
  await page
    .getByRole("button", { name: "Advanced settings", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Motor secured · limits reviewed" })
    .check();
  await page
    .getByRole("button", { name: "Start calibration", exact: true })
    .click();
  const config = await page.evaluate(
    () =>
      window.testMotor.calls.find((call) => call.operation === "calibrate")
        .params.config,
  );
  expect(config.speed_limit).toBe(fixture.preset.speed_limit);
  expect(config.baseline.armature).toBe(fixture.preset.baseline.armature);
  await expect(page.getByRole("main", { name: "Recordings", exact: true })).toBeVisible();
  await navigate(page, "Calibrate");
  await expect(
    page.getByRole("checkbox", { name: "Motor secured · limits reviewed" }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Start calibration", exact: true }),
  ).toBeDisabled();
});

test.describe("editing localized travel limits", () => {
  test.use({ locale: "de-DE" });

  test("only accepted numeric edits can authorize calibration", async ({ page }) => {
    await connect(page);
    const travel = page.getByLabel("Travel limit");
    const review = page.getByRole("checkbox", { name: "Motor secured · limits reviewed" });
    const start = page.getByRole("button", { name: "Start calibration", exact: true });
    const paste = text => travel.evaluate((input, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    }, text);
    await review.check();
    await expect(start).toBeEnabled();

    await travel.fill("invalid");
    await travel.selectText();
    await paste("invalid");
    await expect(travel).toHaveValue("3");
    await expect(review).toBeChecked();
    await travel.fill(",");
    await expect(travel).toHaveValue(",");
    await expect(review).not.toBeChecked();
    await travel.press("Tab");
    await expect(page.getByText("Fill in all calibration settings.")).toBeVisible();
    await review.check();
    await expect(start).toBeDisabled();

    await travel.fill("");
    await travel.pressSequentially(",5");
    await travel.press("Tab");
    await expect(travel).toHaveValue("0,5");
    await travel.selectText();
    await paste("2,5");
    await expect(travel).toHaveValue("2,5");
    await review.check();
    await start.click();
    const limit = await page.evaluate(() =>
      window.testMotor.calls.find((call) => call.operation === "calibrate").params.config.travel_limit
    );
    expect(limit).toBe(2.5);
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
