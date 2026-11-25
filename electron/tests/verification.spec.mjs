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

test("camera device and resolution changes replace the stream and show the received frame size", async ({ page }) => {
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
        calls.opened.push({ id, width: video.width.ideal, height: video.height.ideal });
        const canvas = document.createElement("canvas");
        canvas.width = video.width.ideal === 3840 ? 800 : 640;
        canvas.height = video.width.ideal === 3840 ? 600 : 480;
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
  await view.getByRole("button", { name: "Start preview" }).click();
  await expect(view.getByText("640 × 480")).toBeVisible();
  await view.getByRole("combobox", { name: "Target resolution" }).click();
  await page.getByRole("option", { name: "4K", exact: true }).click();
  await expect(view.getByText("Received video · 800 × 600")).toBeVisible();
  await view.getByRole("combobox", { name: "Camera device" }).click();
  await expect(page.getByRole("option", { name: "Microphone" })).toHaveCount(0);
  await page.getByRole("option", { name: "Camera B" }).click();
  await expect.poll(() => page.evaluate(() => window.testCamera)).toEqual({
    opened: [
      { id: "camera-a", width: 1920, height: 1080 },
      { id: "camera-a", width: 3840, height: 2160 },
      { id: "camera-b", width: 3840, height: 2160 },
    ],
    stopped: ["camera-a", "camera-a"],
  });
  await page.getByRole("button", { name: "Setup", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.testCamera.stopped)).toEqual(["camera-a", "camera-a", "camera-b"]);
});
