'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron, expect } = require('@playwright/test');

async function main() {
  const [executable, ...extra] = process.argv.slice(2);
  assert.ok(executable && !extra.length, 'Usage: node test-packaged-camera.js <packaged executable>');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'motor-camera-'));
  try {
    const application = await _electron.launch({
      executablePath: path.resolve(executable),
      args: [`--user-data-dir=${profile}`, '--use-fake-device-for-media-stream'],
    });
    try {
      assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
      let nativeRequests;
      if (process.platform === 'darwin') {
        // Simulate consent at the native prompt for the synthetic device.
        nativeRequests = await application.evaluateHandle(({ systemPreferences }) => {
          const requests = [];
          systemPreferences.askForMediaAccess = async mediaType => {
            requests.push(mediaType);
            return mediaType === 'camera';
          };
          return requests;
        });
      }

      const page = await application.firstWindow();
      page.setDefaultTimeout(15_000);
      await expect(page).toHaveURL(/^file:\/\//);
      const workspace = page.getByRole('combobox', { name: /^(Workspace|작업 영역)$/ });
      if (!(await workspace.isVisible())) await page.locator('[data-slot="sidebar-trigger"]').click();
      await workspace.click();
      await page.getByRole('listbox').getByRole('option', { name: /^(Camera|카메라)$/ }).click();
      const view = page.getByRole('main', { name: /^(Camera verification|카메라 검증)$/ });
      const video = view.getByLabel(/^(Live camera image|카메라 실시간 영상)$/);
      await view.getByRole('button', { name: /^(Start preview|미리보기 시작)$/ }).click();
      await expect(view.getByText(/^(Received video|실제 수신 영상) · \d+ × \d+$/)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => video.evaluate(element => {
        const { totalVideoFrames, droppedVideoFrames } = element.getVideoPlaybackQuality();
        return totalVideoFrames - droppedVideoFrames;
      }), { message: 'Camera preview should render multiple frames' }).toBeGreaterThan(1);
      if (nativeRequests) assert.deepEqual(await nativeRequests.jsonValue(), ['camera']);

      const stream = await video.evaluateHandle(element => element.srcObject);
      assert.deepEqual(await stream.evaluate(source => source.getTracks().map(track => [track.kind, track.readyState])), [['video', 'live']]);
      await view.getByRole('button', { name: /^(Stop preview|미리보기 중지)$/ }).click();
      await expect(view.getByText(/^(Preview off|미리보기 꺼짐)$/)).toBeVisible();
      assert.equal(await video.evaluate(element => element.srcObject), null);
      assert.deepEqual(await stream.evaluate(source => source.getTracks().map(track => track.readyState)), ['ended']);
      console.log('Packaged camera preview rendered video frames and released its stream on stop.');
    } finally {
      await application.close();
    }
  } finally {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
