import { expect, test } from "@playwright/test";
import { fixture, installBridge } from "./fixtures.mjs";
import { teachingIds } from "../src/teaching-pose.mjs";

test.use({ launchOptions: { args: ["--enable-unsafe-swiftshader"] } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installBridge, fixture);
  await page.goto("/");
});

test("MILLY preview renders and stops requesting positions after a failed sample", async ({ page }) => {
  const motors = teachingIds.map((motor_id, index) => ({
    motor_id, name: index === 6 ? "XL330-M077-T" : "XL330-M288-T",
    position: 2048, baud_rate: 1_000_000, operating_mode: 5,
    radians: Math.PI, joint_radians: 0, joint_degrees: 0, torque: 0,
  }));
  let loseSignal = false;
  const reads = [];
  await page.exposeFunction("mockTeaching", (operation, params) => {
    switch (operation) {
      case "ports": return { connected: false, result: { ports: ["/dev/ttyACM0"] } };
      case "connect":
      case "poll": return { connected: true, result: { baud: 1_000_000, motors } };
      case "readPositions":
        reads.push(params.ids);
        return loseSignal
          ? { connected: true, error: "Serial timeout" }
          : { connected: true, result: { positions: [Math.PI + 0.25, ...Array(6).fill(Math.PI)] } };
      default: throw new Error(`Unexpected Dynamixel operation: ${operation}`);
    }
  });
  await page.evaluate(() => { window.motorApp.dxl = window.mockTeaching; });
  await page.getByRole("button", { name: "Dynamixel", exact: true }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "MILLY preview", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "MILLY teaching preview" });
  await expect(preview.locator("canvas")).toBeVisible({ timeout: 15_000 });
  await expect(preview.getByText("0.250 rad", { exact: true })).toBeVisible();
  expect(reads[0]).toEqual(teachingIds);
  loseSignal = true;
  await expect(preview.getByText(/Preview stopped/)).toBeVisible();
  await expect(preview.getByText("Stale", { exact: true })).toBeVisible();
  await expect(preview.getByText("0.250 rad", { exact: true })).toBeVisible();
  const stoppedAt = reads.length;
  await preview.getByRole("button", { name: "Reset view" }).click();
  await expect(preview.getByText("Stale", { exact: true })).toBeVisible();
  expect(reads.length).toBe(stoppedAt);
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
});

test("camera switching requests at most Full HD and shows the received frame size", async ({ page }) => {
  await page.evaluate(() => {
    const calls = window.testCamera = { opened: [], stopped: [] };
    const cameras = [
      { kind: "videoinput", label: "Camera A", deviceId: "camera-a" },
      { kind: "audioinput", label: "Microphone", deviceId: "audio" },
      { kind: "videoinput", label: "Camera B", deviceId: "camera-b" },
    ];
    Object.defineProperty(window.navigator, "mediaDevices", { value: Object.assign(new EventTarget(), {
      async enumerateDevices() { return cameras; },
      async getUserMedia({ audio, video }) {
        if (audio !== false) throw new Error("Unexpected audio capture");
        const id = video.deviceId?.exact ?? "camera-a";
        calls.opened.push({ id, width: video.width, height: video.height });
        const canvas = document.createElement("canvas");
        canvas.width = id === "camera-a" ? 640 : 800;
        canvas.height = id === "camera-a" ? 480 : 600;
        const ctx = canvas.getContext("2d");
        const stream = canvas.captureStream();
        const [track] = stream.getVideoTracks();
        track.getSettings = () => ({ deviceId: id });
        const stop = track.stop.bind(track);
        track.stop = () => { calls.stopped.push(id); stop(); };
        requestAnimationFrame(() => ctx.fillRect(0, 0, canvas.width, canvas.height));
        return stream;
      },
    }) });
  });
  await page.getByRole("button", { name: "Camera", exact: true }).click();
  const view = page.getByRole("main", { name: "Camera verification" });
  expect(await page.evaluate(() => window.testCamera.opened)).toEqual([]);
  await expect(view.getByRole("combobox")).toHaveCount(1);
  await view.getByRole("button", { name: "Start preview" }).click();
  await expect(view.getByText("Received video · 640 × 480")).toBeVisible();
  await view.getByRole("combobox", { name: "Camera device" }).click();
  await expect(page.getByRole("option", { name: "Microphone" })).toHaveCount(0);
  await page.getByRole("option", { name: "Camera B" }).click();
  await expect(view.getByText("Received video · 800 × 600")).toBeVisible();
  const width = { ideal: 1920, max: 1920 };
  const height = { ideal: 1080, max: 1080 };
  await expect.poll(() => page.evaluate(() => window.testCamera)).toEqual({
    opened: [
      { id: "camera-a", width, height },
      { id: "camera-b", width, height },
    ],
    stopped: ["camera-a"],
  });
  await page.getByRole("button", { name: "Setup", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.testCamera.stopped)).toEqual(["camera-a", "camera-b"]);
});

test("refreshing cameras clears discovery errors and preserves preview errors", async ({ page }) => {
  await page.evaluate(() => {
    const camera = window.testCamera = { deviceId: "" };
    Object.defineProperty(window.navigator, "mediaDevices", { value: Object.assign(new EventTarget(), {
      async enumerateDevices() {
        if (!camera.deviceId) throw new Error("Camera discovery failed");
        return [{ kind: "videoinput", label: camera.deviceId, deviceId: camera.deviceId }];
      },
      async getUserMedia() { throw new DOMException("", "NotReadableError"); },
    }) });
  });
  await page.getByRole("button", { name: "Camera", exact: true }).click();
  const view = page.getByRole("main", { name: "Camera verification" });
  const alerts = view.getByRole("alert");
  const discoveryError = alerts.filter({ hasText: "Camera list could not be refreshed." });
  const previewError = alerts.filter({ hasText: "Camera could not start. Close other apps using it and try again." });
  const refresh = view.getByRole("button", { name: "Refresh cameras" });
  const picker = view.getByRole("combobox", { name: "Camera device" });
  await expect(discoveryError).toBeVisible();

  await page.evaluate(() => { window.testCamera.deviceId = "Camera A"; });
  await refresh.click();
  await picker.click();
  await page.getByRole("option", { name: "Camera A" }).click();
  await expect(alerts).toHaveCount(0);

  await view.getByRole("button", { name: "Start preview" }).click();
  await expect(previewError).toBeVisible();

  await page.evaluate(() => { window.testCamera.deviceId = ""; });
  await refresh.click();
  await expect(discoveryError).toBeVisible();
  await expect(previewError).toBeVisible();

  await page.evaluate(() => { window.testCamera.deviceId = "Camera B"; });
  await refresh.click();
  await picker.click();
  await page.getByRole("option", { name: "Camera B" }).click();
  await expect(discoveryError).toHaveCount(0);
  await expect(previewError).toBeVisible();
});
