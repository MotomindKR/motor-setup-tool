'use strict';
// Native screenshots for visual review; DOM screenshots omit window controls.
// Run only in an isolated desktop/CI session. Startup only enumerates adapters.
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron } = require('playwright');

(async () => {
  const [executable, output] = process.argv.slice(2);
  const executablePath = path.resolve(executable);
  await fs.mkdir(output, { recursive: true });
  if (process.argv.includes('--source')) {
    // Reuse a released backend/runtime in a disposable CI installation.
    const app = path.join(path.dirname(executablePath), 'resources', 'app', 'electron');
    for (const name of ['main.js', 'preload.js']) await fs.copyFile(path.join(__dirname, name), path.join(app, name));
    await fs.rm(path.join(app, 'ui-dist'), { recursive: true, force: true });
    await fs.cp(path.join(__dirname, 'ui-dist'), path.join(app, 'ui-dist'), { recursive: true });
  }
  const application = await _electron.launch({ executablePath, args: ['--no-sandbox', `--user-data-dir=${path.join(output, 'profile')}`] });
  try {
    const page = await application.firstWindow();
    await page.locator('.app-header').waitFor();
    const backdrops = '[data-slot="dialog-overlay"], [data-slot="sheet-overlay"]';
    async function settle() {
      await page.evaluate(async selector => {
        await Promise.all([...document.querySelectorAll(selector)].flatMap(element => element.getAnimations()).map(animation => animation.finished.catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, backdrops);
    }
    async function capture(theme, width, state) {
      await settle();
      const name = `${process.platform}-${theme.toLowerCase()}-${width}-${state}`;
      const geometry = await page.evaluate(selector => ({
        header: document.querySelector('.app-header').getBoundingClientRect().toJSON(),
        overlay: navigator.windowControlsOverlay.getTitlebarAreaRect().toJSON(),
        backdrops: [...document.querySelectorAll(selector)].map(element => ({ color: getComputedStyle(element).backgroundColor, opacity: getComputedStyle(element).opacity })),
      }), backdrops);
      const png = await application.evaluate(async ({ BrowserWindow, desktopCapturer, screen }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const { width, height } = window.getBounds();
        const linux = process.platform === 'linux';
        const sources = await desktopCapturer.getSources({ types: [linux ? 'screen' : 'window'], thumbnailSize: linux ? screen.getPrimaryDisplay().size : { width, height } });
        const source = linux ? sources[0] : sources.find(item => item.id === window.getMediaSourceId());
        if (!source || source.thumbnail.isEmpty()) throw new Error('Native window capture unavailable');
        return source.thumbnail.toPNG().toString('base64');
      });
      await fs.writeFile(path.join(output, `${name}.png`), Buffer.from(png, 'base64'));
      await fs.writeFile(path.join(output, `${name}.json`), JSON.stringify(geometry));
      console.log(`${name}: ${JSON.stringify(geometry)}`);
    }
    for (const theme of ['Light', 'Dark']) {
      for (const width of [1000, 760]) {
        await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 10, y: 10, width: 1000, height: 700 }));
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('combobox', { name: 'Appearance', exact: true }).click();
        await page.getByRole('option', { name: theme, exact: true }).click();
        await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme.toLowerCase());
        await application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setBounds({ x: 10, y: 10, width: value, height: 700 }), width);
        await capture(theme, width, 'modal');
        await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
        await page.locator(backdrops).waitFor({ state: 'detached' });
        await capture(theme, width, 'restored');
        if (width === 760) {
          await page.locator('[data-slot="sidebar-trigger"]').click();
          await capture(theme, width, 'sidebar');
          await page.keyboard.press('Escape');
          await page.locator(backdrops).waitFor({ state: 'detached' });
        }
      }
    }
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
