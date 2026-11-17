import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const appURL = `http://127.0.0.1:${process.env.LINKSUNDER_E2E_PORT || '4317'}`;
const appPort = Number(process.env.LINKSUNDER_E2E_PORT || '4317');
test('demo, reports, real history and responsive themes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Build for the unexpected.' })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole('button', { name: 'Run Demo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fixed · draft preservation' })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByRole('link', { name: 'Download HTML Report' })).toBeVisible({
    timeout: 20000,
  });
  const report = await page.request.get(
    (await page.getByRole('link', { name: 'Download HTML Report' }).getAttribute('href')) || '',
  );
  expect(await report.text()).toContain('PASS');
  await page.screenshot({ path: 'docs/screenshots/report.png', fullPage: true });
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Broken · draft preservation' })).toBeVisible();
  await expect(page.locator('tbody .fail')).toHaveCount(1);
  await expect(page.locator('tbody .pass')).toHaveCount(1);
  await page.screenshot({ path: 'docs/screenshots/dashboard.png', fullPage: true });
  await page.getByRole('button', { name: 'Light appearance' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: 'docs/screenshots/light.png', fullPage: true });
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'docs/screenshots/mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarWidth)).toBe('thin');
  await page.getByRole('button', { name: 'New test', exact: true }).click();
  await page.getByRole('button', { name: 'Add step' }).click();
  await expect(page.getByLabel('Step 1 action')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByLabel('Report storage folder')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Start new scenarios with screenshots/ })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel('Report storage folder').fill('C:\\Users\\Example\\Documents\\LinkSunder\\Reports');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'test-results/settings-page.png', fullPage: true });
  const appearance = page.getByRole('combobox', { name: 'Appearance' });
  await appearance.focus();
  await appearance.press('End');
  await expect(page.getByRole('listbox', { name: 'Appearance' })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  const lightScrollbarColor = await page.locator('html').evaluate((element) => getComputedStyle(element).scrollbarColor);
  await page.screenshot({ path: 'test-results/select-light-theme.png' });
  await page.keyboard.press('Escape');
  await expect(appearance).toBeFocused();
  await expect(appearance).toHaveAttribute('aria-expanded', 'false');
  await appearance.click();
  await page.getByRole('option', { name: 'Dark', exact: true }).click();
  await appearance.click();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  const darkScrollbarColor = await page.locator('html').evaluate((element) => getComputedStyle(element).scrollbarColor);
  expect(darkScrollbarColor).not.toBe(lightScrollbarColor);
  await page.screenshot({ path: 'test-results/select-dark-theme.png' });
  await appearance.press('d');
  await expect(page.getByRole('listbox', { name: 'Appearance' })).toBeVisible();
  await appearance.press('Enter');
  await expect(appearance).toContainText('Dark');
  await appearance.press('ArrowDown');
  await appearance.press('ArrowDown');
  await appearance.press('Enter');
  await expect(appearance).toContainText('Light');
  await page.setViewportSize({ width: 390, height: 844 });
  await appearance.press('ArrowDown');
  const mobileMenuBounds = await page.getByRole('listbox', { name: 'Appearance' }).boundingBox();
  expect(mobileMenuBounds).not.toBeNull();
  expect(mobileMenuBounds!.x).toBeGreaterThanOrEqual(0);
  expect(mobileMenuBounds!.y).toBeGreaterThanOrEqual(0);
  expect(mobileMenuBounds!.x + mobileMenuBounds!.width).toBeLessThanOrEqual(390);
  expect(mobileMenuBounds!.y + mobileMenuBounds!.height).toBeLessThanOrEqual(844);
  await page.keyboard.press('Escape');
  await expect(appearance).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  const defaultTimeout = page.getByRole('spinbutton', { name: 'Default step timeout (ms)' });
  await expect(defaultTimeout).toHaveValue('10000');
  await page.getByRole('button', { name: 'Increase Default step timeout (ms)' }).click();
  await expect(defaultTimeout).toHaveValue('10001');
  await page.getByRole('button', { name: 'Decrease Default step timeout (ms)' }).click();
  await expect(defaultTimeout).toHaveValue('10000');
  await page.getByRole('navigation').getByRole('button', { name: 'Reports & history' }).click();
  await expect(page.getByRole('heading', { name: 'Reports & history' })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.locator('.tablewrap').evaluate((element) => getComputedStyle(element).overflowX)).toBe('auto');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  const downloadJson = page.getByRole('link', { name: /Download JSON for/ }).first();
  await downloadJson.hover();
  expect(await downloadJson.evaluate((element) => getComputedStyle(element, '::after').content)).toBe('"Download JSON"');
  await expect.poll(() => downloadJson.evaluate((element) => getComputedStyle(element, '::after').opacity)).toBe('1');
  await page.screenshot({ path: 'test-results/history-tooltip.png' });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'docs/screenshots/history.png', fullPage: true });
});
test('API validates input and rejects cross-origin mutations', async ({ request }) => {
  const bad = await request.post('/api/runs', {
    headers: { 'X-LinkSunder': 'local' },
    data: { name: '' },
  });
  expect(bad.status()).toBe(400);
  const csrf = await request.post('/api/cancel', { data: {} });
  expect(csrf.status()).toBe(403);
  const cross = await request.post('/api/cancel', {
    headers: { 'X-LinkSunder': 'local', Origin: 'https://evil.example' },
    data: {},
  });
  expect(cross.status()).toBe(403);
  expect((await request.get('/api/runs/not-a-run')).status()).toBe(404);
  expect((await request.get('/api/reports/../../secret/json')).status()).not.toBe(200);
  const malformedDelete = await request.post('/api/history/delete', {
    headers: { 'X-LinkSunder': 'local' },
    data: { reports: [null] },
  });
  expect(malformedDelete.status()).toBe(400);
  const noAuthorization = await request.post('/api/network/scans', {
    headers: { 'X-LinkSunder': 'local' },
    data: { target: '127.0.0.1', ports: [80] },
  });
  expect(noAuthorization.status()).toBe(400);
  expect((await noAuthorization.json()).error).toContain('authorized');
  const invalidNetworkTarget = await request.post('/api/network/scans', {
    headers: { 'X-LinkSunder': 'local' },
    data: { target: 'file:///etc/passwd', ports: [80], authorized: true },
  });
  expect(invalidNetworkTarget.status()).toBe(400);
  const networkCsrf = await request.post('/api/network/cancel', {
    headers: { 'X-LinkSunder': 'local', Origin: 'https://evil.example' },
    data: {},
  });
  expect(networkCsrf.status()).toBe(403);
});
test('builds and runs an assertion through the no-code UI', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New test', exact: true }).click();
  await page.screenshot({ path: 'test-results/scenario-builder-empty.png', fullPage: true });
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.getByLabel('Scenario name').fill('My own UI assertion');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.getByLabel('Step 1 selector').fill('#note');
  await page.screenshot({ path: 'test-results/scenario-builder-step.png', fullPage: true });
  await page.getByRole('button', { name: 'Save scenario', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Scenario saved');
  await page.reload();
  await page.getByRole('button', { name: 'New test', exact: true }).click();
  const savedScenarios = page.getByRole('combobox', { name: 'Saved scenarios' });
  await savedScenarios.focus();
  await savedScenarios.press('m');
  await savedScenarios.press('Enter');
  await expect(page.getByLabel('Step 1 selector')).toHaveValue('#note');
  await page.getByRole('button', { name: 'Run Test', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Download JSON Report' })).toBeVisible();
  await expect(page.locator('.heading .badge')).toHaveText('pass');
});
test('duplicates a scenario step, keeps focus predictable, and edits independently at 390px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New test', exact: true }).click();
  await page.getByRole('button', { name: 'Add step' }).click();
  const actionSelect = page.getByRole('combobox', { name: 'Step 1 action' });
  await actionSelect.focus();
  await actionSelect.press('f');
  await actionSelect.press('Enter');
  await expect(actionSelect).toHaveText('Fill Field');
  await page.getByLabel('Step 1 selector').fill('#note');
  await page.getByLabel('Step 1 value').fill('original value');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.getByLabel('Step 2 selector').fill('#status');
  await page.getByRole('button', { name: 'Duplicate step' }).first().click();
  await expect(page.getByLabel('Step 2 selector')).toHaveValue('#note');
  await expect(page.getByLabel('Step 2 value')).toHaveValue('original value');
  await expect(page.getByLabel('Step 3 selector')).toHaveValue('#status');
  await expect(page.getByRole('button', { name: 'Duplicate step' }).first()).toBeFocused();
  await page.getByLabel('Step 2 selector').fill('#copy');
  await page.getByLabel('Step 2 value').fill('edited copy');
  await expect(page.getByLabel('Step 1 selector')).toHaveValue('#note');
  await expect(page.getByLabel('Step 1 value')).toHaveValue('original value');
  await expect(page.getByLabel('Step 3 selector')).toHaveValue('#status');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('does not allow adding or duplicating more than the scenario step limit', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New test', exact: true }).click();
  const addStep = page.getByRole('button', { name: 'Add step' });
  for (let count = 0; count < 50; count += 1) {
    await addStep.click();
  }
  await expect(page.locator('.stepedit')).toHaveCount(50);
  await expect(addStep).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Duplicate step' }).first()).toBeDisabled();
  await expect(page.getByText(/50 of 50 steps\. Remove a step/)).toBeVisible();
});
test('serializes runs and cancels a pending browser', async ({ request }) => {
  const headers = { 'X-LinkSunder': 'local' };
  const result = await request.post('/api/runs', {
    headers,
    data: {
      name: 'Cancel pending check',
      url: `${appURL}/demo/fixed`,
      steps: [{ action: 'check', selector: '#never' }],
    },
  });
  expect(result.status()).toBe(200);
  const run = await result.json();
  const second = await request.post('/api/runs', {
    headers,
    data: { name: 'Busy', url: `${appURL}/demo/fixed` },
  });
  expect(second.status()).toBe(409);
  await request.post('/api/cancel', { headers, data: {} });
  await expect
    .poll(async () => {
      const r = await request.get('/api/runs/' + run.id);
      return (await r.json()).status;
    })
    .toBe('cancelled');
});

test('inspects a local authorized target and exports JSON and HTML reports', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Network Inspector' }).click();
  await page.getByLabel('Network inspection target').fill(`127.0.0.1:${appPort}/demo/fixed?secret=omit`);
  await page.getByRole('combobox', { name: 'TCP port preset' }).click();
  await page.getByRole('option', { name: 'Custom list (up to 20)' }).click();
  await page.getByLabel('Custom TCP ports').fill(String(appPort));
  await page.getByRole('checkbox', { name: 'I own this system or have explicit permission to inspect it.' }).check();
  await page.getByRole('button', { name: 'Start network check' }).click();
  await expect(page.getByRole('heading', { name: 'DNS summary' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.compact-heading h2')).toHaveText(`http://127.0.0.1:${appPort}/demo/fixed`);
  const reports = await request.get('/api/network/reports').then((response) => response.json());
  const report = reports[0];
  expect(report.status).toBe('complete');
  expect(report.target).not.toContain('secret');
  expect(report.tls).toBeUndefined();
  expect(report.http[0].status).toBe(200);
  expect(report.ports[0].status).toBe('OPEN');
  expect(await request.get(`/api/network/reports/${report.id}/json`).then((response) => response.ok())).toBe(true);
  const html = await request.get(`/api/network/reports/${report.id}/html`).then((response) => response.text());
  expect(html).toContain('Network inspection');
  expect(html).not.toContain('secret=omit');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('navigation').getByRole('button', { name: 'Reports & history' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('navigation').getByRole('button', { name: 'Network Inspector' }).click();
  await page.getByLabel('Network inspection target').fill(`127.0.0.1:${appPort}/demo/fixed`);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: 'docs/screenshots/network-inspector.png', fullPage: true });
});

test('copies report storage safely and keeps source reports intact', async ({ request }) => {
  const originalInfo = await request.get('/api/info').then((response) => response.json());
  const oldFiles = await readdir(originalInfo.reportDirectory);
  expect(oldFiles.some((file) => file.endsWith('.json'))).toBe(true);
  const destination = await mkdtemp(path.join(os.tmpdir(), 'linksunder-e2e-storage-'));
  let switched = false;
  try {
    const response = await request.post('/api/settings/report-directory', {
      headers: { 'X-LinkSunder': 'local' },
      data: { path: destination },
    });
    expect(response.ok()).toBe(true);
    const result = await response.json();
    expect(result.reportDirectory).toBe(destination);
    expect(result.copied).toBeGreaterThan(0);
    expect(result.originalsKept).toBe(true);
    switched = true;
    expect((await readdir(destination)).length).toBeGreaterThan(0);
    expect((await readdir(originalInfo.reportDirectory)).length).toBeGreaterThan(0);
    const restore = await request.post('/api/settings/report-directory', {
      headers: { 'X-LinkSunder': 'local' },
      data: { path: originalInfo.reportDirectory },
    });
    expect(restore.ok()).toBe(true);
    switched = false;
  } finally {
    if (switched) {
      await request.post('/api/settings/report-directory', {
        headers: { 'X-LinkSunder': 'local' },
        data: { path: originalInfo.reportDirectory },
      });
    }
    await rm(destination, { recursive: true, force: true });
  }
});

test('deletes a single report only after confirmation', async ({ page, request }) => {
  const runs = await request.get('/api/runs').then((response) => response.json());
  const selected = runs.find((run: { status: string }) => run.status !== 'running');
  expect(selected).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: 'Reports & history' }).click();
  await expect(page.getByRole('heading', { name: 'Reports & history' })).toBeVisible();
  await page.getByRole('button', { name: `Delete report ${selected.name}` }).click();
  await expect(page.getByRole('dialog')).toContainText('permanently removes');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Delete reports' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Delete reports' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Delete report ${selected.name}` })).toBeFocused();
  expect((await request.get(`/api/runs/${selected.id}`)).status()).toBe(200);
  await page.getByRole('button', { name: `Delete report ${selected.name}` }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await request.get(`/api/runs/${selected.id}`)).status()).toBe(200);
  await page.getByRole('button', { name: `Delete report ${selected.name}` }).click();
  await page.getByRole('button', { name: 'Delete reports' }).click();
  await expect(page.getByRole('status')).toContainText('1 report deleted');
  expect((await request.get(`/api/runs/${selected.id}`)).status()).toBe(404);
});

test('bulk deletion and clear-all history require confirmation', async ({ page, request }) => {
  const runs = await request.get('/api/runs').then((response) => response.json());
  const network = await request.get('/api/network/reports').then((response) => response.json());
  const available = [
    ...runs.filter((run: { status: string }) => run.status !== 'running').map((run: { id: string; name: string }) => ({ ...run, kind: 'run' })),
    ...network.filter((report: { status: string }) => report.status !== 'running').map((report: { id: string; hostname: string }) => ({ ...report, name: report.hostname, kind: 'network' })),
  ];
  expect(available.length).toBeGreaterThanOrEqual(2);
  await page.goto('/');
  await page.getByRole('button', { name: 'Reports & history' }).click();
  for (const item of available.slice(0, 2)) {
    await page.getByRole('checkbox', { name: `Select ${item.name}` }).first().check();
  }
  await page.getByRole('button', { name: 'Delete selected (2)' }).click();
  await page.getByRole('button', { name: 'Delete reports' }).click();
  await expect(page.getByRole('status')).toContainText('2 reports deleted');
  await page.getByRole('button', { name: 'Clear all history' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Clear all history' }).click();
  await page.getByRole('button', { name: 'Delete reports' }).click();
  await expect(page.getByRole('heading', { name: 'No reports yet' })).toBeVisible();
  expect(await request.get('/api/runs').then((response) => response.json())).toHaveLength(0);
  expect(await request.get('/api/network/reports').then((response) => response.json())).toHaveLength(0);
});
