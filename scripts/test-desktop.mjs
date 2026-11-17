/* global document, getComputedStyle */
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import assert from 'node:assert/strict';
import console from 'node:console';
import { URL } from 'node:url';
import { setTimeout } from 'node:timers';
const data = await mkdtemp(path.join(tmpdir(), 'linksunder-desktop-'));
const options = process.env.LINKSUNDER_PACKAGED_EXE
  ? { executablePath: process.env.LINKSUNDER_PACKAGED_EXE, args: [] }
  : { args: ['.'] };
const app = await electron.launch({
  ...options,
  env: { ...process.env, LINKSUNDER_DESKTOP_DATA: data },
  timeout: 45000,
});
try {
  const page = await app.firstWindow({ timeout: 45000 });
  await page.getByRole('heading', { name: 'Build for the unexpected.' }).waitFor();
  const preferences = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  );
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  await page.getByRole('toolbar', { name: 'Window controls' }).waitFor();
  assert.equal(
    await page.locator('.window-chrome').evaluate((element) => getComputedStyle(element).webkitAppRegion),
    'drag',
  );
  assert.equal(
    await page.locator('.window-controls').evaluate((element) => getComputedStyle(element).webkitAppRegion),
    'no-drag',
  );
  assert.equal(await page.locator('main').evaluate((element) => getComputedStyle(element).overflowY), 'auto');
  assert.equal(await page.locator('aside').evaluate((element) => getComputedStyle(element).overflowY), 'auto');
  assert.equal(await page.locator('html').evaluate((element) => getComputedStyle(element).scrollbarWidth), 'thin');
  const main = page.locator('main');
  assert.ok(
    await main.evaluate((element) => element.scrollHeight > element.clientHeight),
    'The main workspace must contain scrollable content at the smoke-test window size.',
  );
  await main.evaluate((element) => { element.scrollTop = 0; });
  const mainBounds = await main.boundingBox();
  assert.ok(mainBounds, 'The main workspace must have a visible window area.');
  await page.mouse.move(mainBounds.x + mainBounds.width / 2, mainBounds.y + mainBounds.height / 2);
  await page.mouse.wheel(0, 240);
  await page.waitForFunction(
    () => (document.querySelector('main')?.scrollTop || 0) > 0,
    undefined,
    { timeout: 3000 },
  );
  assert.ok(await main.evaluate((element) => element.scrollTop > 0), 'The main workspace must respond to wheel scrolling.');
  await main.evaluate((element) => element.scrollTo(0, 0));
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/desktop-titlebar.png' });
  await page.getByRole('button', { name: 'Maximize window' }).click();
  await page.getByRole('button', { name: 'Restore window' }).waitFor();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), true);
  await page.getByRole('button', { name: 'Restore window' }).click();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), false);
  await page.locator('.window-app-title').dblclick();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), true);
  await page.locator('.window-app-title').dblclick();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), false);
  await page.getByRole('button', { name: 'Minimize window' }).click();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  await page.getByRole('button', { name: 'New test', exact: true }).click();
  await page.getByLabel('Scenario name').fill('Desktop application smoke test');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.getByLabel('Step 1 selector').fill('#note');
  await page.getByRole('checkbox', { name: 'I own this server or have permission to test it.' }).check();
  await page.getByRole('button', { name: 'Run Test', exact: true }).click();
  await page.getByRole('link', { name: 'Download JSON Report' }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.heading .badge').textContent(), 'pass');
  const origin = new URL(page.url()).origin;
  const runs = await page.evaluate(async () => (await fetch('/api/runs')).json());
  assert.equal(runs.length, 1);
  assert.ok(runs[0].duration > 0);
  const closed = page.waitForEvent('close');
  await page.getByRole('button', { name: 'Close window' }).click();
  await closed;
  await app.close().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await assert.rejects(fetch(origin + '/api/runs'), 'Closing the app must stop its local server');
  console.log(
    'Desktop smoke passed: app window, isolated renderer, real browser assertion, report and engine shutdown.',
  );
} finally {
  await app.close().catch(() => {});
  if (
    !path.resolve(data).startsWith(path.resolve(tmpdir()) + path.sep) ||
    !path.basename(data).startsWith('linksunder-desktop-')
  )
    assert.fail('Unexpected test directory');
  await rm(data, { recursive: true, force: true });
}
