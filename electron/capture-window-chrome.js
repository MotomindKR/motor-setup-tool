'use strict';
// Native screenshots for visual review; DOM screenshots omit window controls.
// Run only in an isolated desktop/CI session. Startup only enumerates adapters.
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron } = require('playwright');

(async () => {
  const [executablePath, output] = process.argv.slice(2);
  await fs.mkdir(output, { recursive: true });
  const application = await _electron.launch({ executablePath: path.resolve(executablePath), args: ['--no-sandbox', `--user-data-dir=${path.join(output, 'profile')}`] });
  try {
    const page = await application.firstWindow();
    await page.locator('.app-header').waitFor();
    for (const theme of ['Light', 'Dark']) {
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 10, y: 10, width: 1000, height: 700 }));
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).click();
      await page.getByRole('option', { name: theme, exact: true }).click();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme.toLowerCase());
      const nativeHeight = await page.evaluate(() => navigator.windowControlsOverlay.getTitlebarAreaRect().height);
      for (const width of [1000, 760]) {
        await application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setBounds({ x: 10, y: 10, width: value, height: 700 }), width);
        for (const [state, height] of [['before', 40], ['current', nativeHeight]]) {
          await application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setTitleBarOverlay({ height: value }), height);
          await page.waitForFunction(value => navigator.windowControlsOverlay.getTitlebarAreaRect().height === value, height);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const name = `${process.platform}-${theme.toLowerCase()}-${width}-${state}`;
          const geometry = await page.evaluate(() => ({
            header: document.querySelector('.app-header').getBoundingClientRect().toJSON(),
            overlay: navigator.windowControlsOverlay.getTitlebarAreaRect().toJSON(),
            border: getComputedStyle(document.querySelector('.app-header')).borderBottomWidth,
          }));
          const png = await application.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
            const window = BrowserWindow.getAllWindows()[0];
            const { width, height } = window.getBounds();
            const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height } });
            const source = sources.find(item => item.id === window.getMediaSourceId());
            if (!source || source.thumbnail.isEmpty()) throw new Error('Native window capture unavailable');
            return source.thumbnail.toPNG().toString('base64');
          });
          await fs.writeFile(path.join(output, `${name}.png`), Buffer.from(png, 'base64'));
          await fs.writeFile(path.join(output, `${name}.json`), JSON.stringify(geometry));
          console.log(`${name}: ${JSON.stringify(geometry)}`);
        }
      }
    }
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
