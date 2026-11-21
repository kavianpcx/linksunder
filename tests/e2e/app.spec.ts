import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, readdir, rm, writeFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
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

test('a configured API failure cannot pass when its target request never occurs', async ({ request }) => {
  const response = await request.post('/api/runs', {
    headers: { 'X-LinkSunder': 'local' },
    data: {
      name: 'API fault must be triggered',
      url: `${appURL}/demo/fixed`,
      externalConsent: true,
      type: 'failure',
      steps: [
        { action: 'fail', path: '/demo/api/messages' },
        { action: 'check', selector: '#send' },
      ],
    },
  });
  expect(response.status()).toBe(200);
  const started = await response.json() as { id: string };
  await expect.poll(async () => (await request.get(`/api/runs/${started.id}`).then((item) => item.json())).status).not.toBe('running');
  const report = await request.get(`/api/runs/${started.id}`).then((item) => item.json());
  expect(report.network.injected).toBe(0);
  expect(report.status).not.toBe('pass');
  expect(report.error).toContain('FAULT NOT TRIGGERED');
});

test('API Test Builder runs a confirmed local request and keeps previews out of saved reports', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'API Test Builder' }).click();
  await expect(page.getByRole('heading', { name: 'API Test Builder' })).toBeVisible();
  await page.getByLabel('Endpoint').fill(`${appURL}/demo/api/messages`);
  await page.getByRole('combobox', { name: 'Method' }).click();
  await page.getByRole('option', { name: 'POST', exact: true }).click();
  await page.getByRole('checkbox', { name: /I understand POST may change or delete server data/ }).check();
  await page.getByRole('checkbox', { name: 'I own this API or have permission to test it.' }).check();
  await page.getByRole('button', { name: 'Run API Test' }).click();
  await expect(page.locator('.api-test-result .panel-head .badge')).toHaveText('PASS', { timeout: 15000 });
  const jsonLink = page.getByRole('link', { name: 'JSON report' });
  const report = await request.get((await jsonLink.getAttribute('href')) || '');
  const saved = await report.json();
  expect(saved.apiTest.method).toBe('POST');
  expect(saved.apiTest.baseline.preview).toBeUndefined();
});

test('API Test Builder exposes an accessible Cancel action and stops latency without recovery replay', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'API Test Builder' }).click();
  await expect(page.getByRole('heading', { name: 'API Test Builder' })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'docs/screenshots/api-test-builder.png', fullPage: true });
  await page.getByLabel('Endpoint').fill(`${appURL}/`);
  await page.getByText('Fault, recovery and retry', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Fault simulation' }).click();
  await page.getByRole('option', { name: 'Add response delay', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Added delay (ms)' }).fill('10000');
  await page.getByRole('checkbox', { name: 'I own this API or have permission to test it.' }).check();
  await page.getByRole('button', { name: 'Run API Test' }).click();
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(page.locator('.api-test-result .panel-head .badge')).toHaveText('CANCELLED', { timeout: 3000 });
  const reportLink = page.getByRole('link', { name: 'JSON report' });
  const reportResponse = await request.get((await reportLink.getAttribute('href')) || '');
  const report = await reportResponse.json();
  expect(report.apiTest.faultTriggered).toBe(true);
  expect(report.apiTest.requestCount).toBe(2);
  expect(report.apiTest.disrupted).toBeTruthy();
  expect(report.apiTest.recovery).toBeUndefined();
});

test('blocks incomplete resilience scenarios and preserves their setup explanation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New test', exact: true }).click();
  await page.screenshot({ path: 'test-results/scenario-builder-empty.png', fullPage: true });
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.getByLabel('Scenario name').fill('Incomplete offline check');
  await page.getByLabel('Website URL').fill(`${appURL}/demo/fixed`);
  await page.getByRole('combobox', { name: 'Test type' }).click();
  await page.getByRole('option', { name: 'Offline Recovery' }).click();
  const runButton = page.getByRole('button', { name: 'Run Resilience Test', exact: true });
  await expect(runButton).toBeDisabled();
  await expect(page.getByText(/Add exactly one Go Offline step/)).toBeVisible();
  await page.getByRole('button', { name: 'Guided setup' }).click();
  await expect(page.getByRole('heading', { name: 'Guided resilience setup' })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Save scenario', exact: true }).click();
  await expect(page.getByText('Scenario saved on this computer.', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'New test', exact: true }).click();
  const savedScenarios = page.getByRole('combobox', { name: 'Saved scenarios' });
  await savedScenarios.focus();
  await savedScenarios.press('i');
  await savedScenarios.press('Enter');
  await expect(page.getByLabel('Website URL')).toHaveValue(`${appURL}/demo/fixed`);
  await expect(page.getByRole('button', { name: 'Run Resilience Test', exact: true })).toBeDisabled();
  await expect(page.getByText(/Add exactly one Go Offline step/)).toBeVisible();
});

test('authorization gates scenario and network actions and resets after target changes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New test', exact: true }).click();
  const scenarioTarget = page.getByLabel('Website URL');
  await scenarioTarget.fill(`${appURL}/demo/fixed`);
  const scenarioConsent = page.getByRole('checkbox', { name: 'I own this server or have permission to test it.' });
  const runButton = page.getByRole('button', { name: 'Run Health Check', exact: true });
  await expect(runButton).toBeDisabled();
  await expect(page.getByText('Confirm that you own or have permission to test this target before starting.')).toBeVisible();
  await expect(scenarioConsent).toHaveAttribute('aria-describedby', 'scenario-authorization-help');
  await scenarioConsent.focus();
  await scenarioConsent.press('Space');
  await expect(runButton).toBeEnabled();
  await scenarioTarget.fill(`${appURL}/demo/broken`);
  await expect(scenarioConsent).not.toBeChecked();
  await expect(runButton).toBeDisabled();
  await page.getByRole('button', { name: 'Light appearance' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(runButton).toBeDisabled();

  await page.getByRole('navigation').getByRole('button', { name: 'Network Inspector' }).click();
  const networkTarget = page.getByLabel('Network inspection target');
  const scanConsent = page.getByRole('checkbox', { name: 'I own this server or have permission to test it.' });
  const scanButton = page.getByRole('button', { name: 'Start Scan', exact: true });
  await networkTarget.fill('127.0.0.1');
  await expect(scanButton).toBeDisabled();
  await expect(page.getByText('Confirm that you own or have permission to test this target before starting.')).toBeVisible();
  await scanConsent.focus();
  await scanConsent.press('Space');
  await expect(scanButton).toBeEnabled();
  await networkTarget.fill(`127.0.0.1:${appPort}`);
  await expect(scanConsent).not.toBeChecked();
  await expect(scanButton).toBeDisabled();
  await page.getByRole('button', { name: 'Dark appearance' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('New Test runs an evidence-based health check and a guided API failure workflow', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New test', exact: true }).click();
  await page.getByLabel('Website URL').fill(`${appURL}/demo/fixed`);
  await expect(page.getByText(/does not test resilience/i)).toBeVisible();
  await page.getByRole('checkbox', { name: 'I own this server or have permission to test it.' }).check();
  await page.getByRole('button', { name: 'Run Health Check', exact: true }).click();
  await expect(page.locator('.heading .badge')).toHaveText('PASS', { timeout: 15000 });
  const healthEvidence = page.getByRole('region', { name: 'Basic website health evidence' });
  await expect(healthEvidence).toContainText('HTTP response');
  await expect(healthEvidence).toContainText('Document ready state');
  await expect(healthEvidence).toContainText('do not prove offline recovery or API resilience');

  await page.getByRole('button', { name: 'New test', exact: true }).click();
  await page.getByLabel('Scenario name').fill('Guided API failure check');
  await page.getByLabel('Website URL').fill(`${appURL}/demo/fixed`);
  const authorization = page.getByRole('checkbox', { name: 'I own this server or have permission to test it.' });
  if (await authorization.isChecked()) await authorization.uncheck();
  await page.getByRole('combobox', { name: 'Test type' }).click();
  await page.getByRole('option', { name: 'API Failure' }).click();
  await page.getByRole('button', { name: 'Guided setup' }).click();
  await page.getByLabel('Button or link name').fill('Send note');
  await page.getByLabel('Optional form field label').fill('Your note');
  await page.getByLabel('Value to enter before each request').fill('Baseline draft');
  await page.getByLabel('API request path').fill('/demo/api/messages');
  await page.getByLabel('Expected baseline text').fill('Saved');
  await page.getByLabel('Expected text during disruption').fill('Could not send. Please retry.');
  await page.getByLabel('Expected text after recovery').fill('Saved');
  await page.getByRole('button', { name: 'Add guided test steps' }).click();
  const runResilience = page.getByRole('button', { name: 'Run Resilience Test', exact: true });
  await expect(runResilience).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I own this server or have permission to test it.' }).check();
  await expect(runResilience).toBeEnabled();
  await runResilience.click();
  await expect(page.locator('.heading .badge')).toHaveText('PASS', { timeout: 20000 });
  const resilienceEvidence = page.getByRole('region', { name: 'Resilience test evidence' });
  await expect(resilienceEvidence).toContainText('/demo/api/messages');
  await expect(resilienceEvidence).toContainText('Assertions during disruption');
  const jsonReport = page.getByRole('link', { name: 'Download JSON Report' });
  const reportResponse = await page.request.get((await jsonReport.getAttribute('href')) || '');
  const report = await reportResponse.json();
  expect(report.resilience.triggeredRequests).toBeGreaterThan(0);
  expect(report.resilience.disruptionAssertions).toBeGreaterThan(0);
  expect(report.resilience.recoveryRequests).toBeGreaterThan(0);
  expect(report.resilience.recoveryAssertions).toBeGreaterThan(0);

  await page.getByRole('navigation').getByRole('button', { name: 'Reports & history' }).click();
  const rerun = page.getByRole('button', { name: 'Run again for Guided API failure check' });
  await expect(rerun).toBeVisible();
  await rerun.click();
  await expect(page.getByLabel('Scenario name')).toHaveValue('Guided API failure check');
  await expect(page.getByLabel('Website URL')).toHaveValue(`${appURL}/demo/fixed`);
  await expect(page.getByRole('checkbox', { name: 'I own this server or have permission to test it.' })).not.toBeChecked();
  await expect(page.getByLabel('Step 4 action')).toContainText('Fail API Request');
  await page.getByRole('combobox', { name: 'Test type' }).click();
  await page.getByRole('option', { name: 'Slow API Response' }).click();
  await expect(page.getByLabel('Step 4 action')).toContainText('Delay API Response');
  await page.getByRole('checkbox', { name: 'I own this server or have permission to test it.' }).check();
  await page.getByRole('button', { name: 'Run Resilience Test', exact: true }).click();
  await expect(page.locator('.heading .badge')).toHaveText('PASS', { timeout: 20000 });
});

test('Scenario Builder starts a real run and cancels it accessibly', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New test', exact: true }).click();
  await page.getByLabel('Scenario name').fill('Cancelable delayed request');
  await page.getByLabel('Website URL').fill(`${appURL}/demo/fixed`);
  await page.getByRole('combobox', { name: 'Test type' }).click();
  await page.getByRole('option', { name: 'Slow API Response' }).click();
  await page.getByRole('button', { name: 'Guided setup' }).click();
  await page.getByLabel('Button or link name').fill('Send note');
  await page.getByLabel('Optional form field label').fill('Your note');
  await page.getByLabel('Value to enter before each request').fill('A draft to keep');
  await page.getByLabel('API request path').fill('/demo/api/messages');
  await page.getByRole('spinbutton', { name: 'Added API delay (ms)' }).fill('15000');
  await page.getByLabel('Expected baseline text').fill('Saved');
  await page.getByLabel('Expected text during disruption').fill('Sending…');
  await page.getByLabel('Expected text after recovery').fill('Saved');
  await page.getByRole('button', { name: 'Add guided test steps' }).click();
  await expect(page.getByText(/Add exactly one Delay API Response step/)).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'I own this server or have permission to test it.' }).check();
  await expect(page.getByRole('button', { name: 'Run Resilience Test', exact: true })).toBeEnabled();

  const started = page.waitForResponse((response) => response.url().endsWith('/api/runs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Run Resilience Test', exact: true }).click();
  const run = await (await started).json() as { id: string };
  await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel run', exact: true }).focus();
  await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stopping…', exact: true })).toBeDisabled();
  await expect.poll(async () => (await page.request.get(`${appURL}/api/runs/${run.id}`).then((response) => response.json())).status).toBe('cancelled');
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

test('reserves execution admission across simultaneous run and network requests', async ({ request }) => {
  const headers = { 'X-LinkSunder': 'local' };
  const [firstRun, secondRun, networkScan] = await Promise.all([
    request.post('/api/runs', {
      headers,
      data: { name: 'Concurrent admission one', url: `${appURL}/demo/fixed`, externalConsent: true, steps: [{ action: 'check', selector: '#never' }] },
    }),
    request.post('/api/runs', {
      headers,
      data: { name: 'Concurrent admission two', url: `${appURL}/demo/fixed`, externalConsent: true, steps: [{ action: 'check', selector: '#never' }] },
    }),
    request.post('/api/network/scans', {
      headers,
      data: { target: '127.0.0.1', ports: [appPort], timeout: 3000, authorized: true },
    }),
  ]);
  const accepted = [firstRun, secondRun, networkScan].filter((response) => response.status() === 200);
  const rejected = [firstRun, secondRun, networkScan].filter((response) => response.status() === 409);
  expect(accepted).toHaveLength(1);
  expect(rejected).toHaveLength(2);

  const headersForCancel = { 'X-LinkSunder': 'local' };
  if (accepted[0] === networkScan) {
    const report = await networkScan.json();
    await request.post('/api/network/cancel', { headers: headersForCancel, data: {} });
    await expect.poll(async () => (await request.get(`/api/network/reports/${report.id}`).then((response) => response.json())).status).toBe('cancelled');
  } else {
    const run = await accepted[0].json();
    await request.post('/api/cancel', { headers: headersForCancel, data: {} });
    await expect.poll(async () => (await request.get(`/api/runs/${run.id}`).then((response) => response.json())).status).toBe('cancelled');
  }
});

test('inspects a local authorized target and exports JSON and HTML reports', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Network Inspector' }).click();
  await page.getByLabel('Network inspection target').fill(`127.0.0.1:${appPort}/demo/fixed?secret=omit`);
  await page.getByRole('combobox', { name: 'TCP port preset' }).click();
  await page.getByRole('option', { name: 'Custom list (up to 20)' }).click();
  await page.getByLabel('Custom TCP ports').fill(String(appPort));
  const authorization = page.getByRole('checkbox', { name: 'I own this server or have permission to test it.' });
  const startScan = page.getByRole('button', { name: 'Start Scan', exact: true });
  await expect(startScan).toBeDisabled();
  await expect(page.getByText('Confirm that you own or have permission to test this target before starting.')).toBeVisible();
  await authorization.check();
  await expect(startScan).toBeEnabled();
  await startScan.click();
  await expect(page.getByRole('heading', { name: 'DNS summary' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.compact-heading h2')).toHaveText(`http://127.0.0.1:${appPort}/demo/fixed`);
  const reports = await request.get('/api/history?kind=network&page=1&pageSize=10').then((response) => response.json());
  const report = await request.get(`/api/network/reports/${reports.items[0].id}`).then((response) => response.json());
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

test('Network Inspector starts a local authorized scan and cancels while HTTP is pending', async ({ page }) => {
  let responseTimer: NodeJS.Timeout | undefined;
  const delayedServer = createServer((_request, response) => {
    responseTimer = setTimeout(() => response.writeHead(200, { 'content-type': 'text/plain' }).end('ready'), 10000);
    response.once('close', () => {
      if (responseTimer) clearTimeout(responseTimer);
    });
  });
  await new Promise<void>((resolve, reject) => {
    delayedServer.once('error', reject);
    delayedServer.listen(0, '127.0.0.1', resolve);
  });
  const port = (delayedServer.address() as AddressInfo).port;
  try {
    await page.goto('/');
    await page.getByRole('navigation').getByRole('button', { name: 'Network Inspector' }).click();
    await page.getByLabel('Network inspection target').fill(`http://127.0.0.1:${port}/slow`);
    await page.getByRole('combobox', { name: 'TCP port preset' }).click();
    await page.getByRole('option', { name: 'Custom list (up to 20)' }).click();
    await page.getByLabel('Custom TCP ports').fill(String(port));
    await page.getByRole('combobox', { name: 'Connection timeout' }).click();
    await page.getByRole('option', { name: '3 seconds · slower networks' }).click();
    await page.getByRole('checkbox', { name: 'I own this server or have permission to test it.' }).check();
    const started = page.waitForResponse((response) => response.url().endsWith('/api/network/scans') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Start Scan', exact: true }).click();
    const report = await (await started).json() as { id: string };
    await expect(page.getByRole('button', { name: 'Cancel scan', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel scan', exact: true }).focus();
    await expect(page.getByRole('button', { name: 'Cancel scan', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Cancel scan', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stopping…', exact: true })).toBeDisabled();
    await expect.poll(async () => (await page.request.get(`${appURL}/api/network/reports/${report.id}`).then((response) => response.json())).status).toBe('cancelled');
  } finally {
    if (responseTimer) clearTimeout(responseTimer);
    await new Promise<void>((resolve, reject) => delayedServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('Network Inspector distinguishes HTTP client and server errors from successful responses', async ({ page }) => {
  const statusServer = createServer((request, response) => {
    const status = request.url?.startsWith('/not-found') ? 404 : 503;
    response.writeHead(status, { 'content-type': 'text/plain' }).end('controlled response');
  });
  await new Promise<void>((resolve, reject) => {
    statusServer.once('error', reject);
    statusServer.listen(0, '127.0.0.1', resolve);
  });
  const port = (statusServer.address() as AddressInfo).port;
  try {
    await page.goto('/');
    await page.getByRole('navigation').getByRole('button', { name: 'Network Inspector' }).click();
    const target = page.getByLabel('Network inspection target');
    await target.fill(`http://127.0.0.1:${port}/not-found`);
    await page.getByRole('combobox', { name: 'TCP port preset' }).click();
    await page.getByRole('option', { name: 'Custom list (up to 20)' }).click();
    await page.getByLabel('Custom TCP ports').fill(String(port));
    await page.getByRole('checkbox', { name: 'I own this server or have permission to test it.' }).check();
    await page.getByRole('button', { name: 'Start Scan', exact: true }).click();
    await expect(page.locator('.http-results .badge.error')).toHaveText('HTTP 404 · client error');

    await target.fill(`http://127.0.0.1:${port}/server-error`);
    await page.getByRole('checkbox', { name: 'I own this server or have permission to test it.' }).check();
    await page.getByRole('button', { name: 'Start Scan', exact: true }).click();
    await expect(page.locator('.http-results .badge.error')).toHaveText('HTTP 503 · server error');
  } finally {
    await new Promise<void>((resolve, reject) => statusServer.close((error) => error ? reject(error) : resolve()));
  }
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
    expect(response.status()).toBe(202);
    const started = await response.json() as { id: string; status: string };
    expect(started.status).toBe('running');
    const runDuringMigration = await request.post('/api/runs', {
      headers: { 'X-LinkSunder': 'local' },
      data: { name: 'Blocked during storage move', url: `${appURL}/demo/fixed`, externalConsent: true },
    });
    expect(runDuringMigration.status()).toBe(409);
    await expect.poll(async () => request.get(`/api/settings/report-directory/${started.id}`).then((job) => job.json().then((body) => body.status))).toBe('complete');
    const result = await request.get(`/api/settings/report-directory/${started.id}`).then((job) => job.json());
    expect(result.result.reportDirectory).toBe(destination);
    expect(result.result.copied).toBeGreaterThan(0);
    expect(result.result.originalsKept).toBe(true);
    switched = true;
    expect((await readdir(destination)).length).toBeGreaterThan(0);
    expect((await readdir(originalInfo.reportDirectory)).length).toBeGreaterThan(0);
    const restore = await request.post('/api/settings/report-directory', {
      headers: { 'X-LinkSunder': 'local' },
      data: { path: originalInfo.reportDirectory },
    });
    expect(restore.ok()).toBe(true);
    if (restore.status() === 202) {
      const restoreJob = await restore.json() as { id: string };
      await expect.poll(async () => request.get(`/api/settings/report-directory/${restoreJob.id}`).then((job) => job.json().then((body) => body.status))).toBe('complete');
    }
    switched = false;
  } finally {
    if (switched) {
      const restore = await request.post('/api/settings/report-directory', {
        headers: { 'X-LinkSunder': 'local' },
        data: { path: originalInfo.reportDirectory },
      });
      if (restore.status() === 202) {
        const restoreJob = await restore.json() as { id: string };
        await expect.poll(async () => request.get(`/api/settings/report-directory/${restoreJob.id}`).then((job) => job.json().then((body) => body.status))).toBe('complete');
      }
    }
    await rm(destination, { recursive: true, force: true });
  }
});

test('cancels a report folder migration without switching away from the original folder', async ({ request }) => {
  const originalInfo = await request.get('/api/info').then((response) => response.json());
  const destination = await mkdtemp(path.join(os.tmpdir(), 'linksunder-e2e-storage-cancel-'));
  const slowFixture = path.join(originalInfo.reportDirectory, `${randomUUID()}.json`);
  try {
    await writeFile(slowFixture, Buffer.alloc(24 * 1024 * 1024, 120));
    const startedResponse = await request.post('/api/settings/report-directory', {
      headers: { 'X-LinkSunder': 'local' },
      data: { path: destination },
    });
    expect(startedResponse.status()).toBe(202);
    const started = await startedResponse.json() as { id: string };
    const cancel = await request.post(`/api/settings/report-directory/${started.id}/cancel`, {
      headers: { 'X-LinkSunder': 'local' },
    });
    expect(cancel.ok()).toBe(true);
    await expect.poll(async () => request.get(`/api/settings/report-directory/${started.id}`).then((job) => job.json().then((body) => body.status))).toBe('cancelled');
    const info = await request.get('/api/info').then((response) => response.json());
    expect(info.reportDirectory).toBe(originalInfo.reportDirectory);
  } finally {
    await unlink(slowFixture).catch(() => {});
    await rm(destination, { recursive: true, force: true });
  }
});

test('deletes a single report only after confirmation', async ({ page, request }) => {
  test.setTimeout(120000);
  const started = await request.post('/api/runs', {
    headers: { 'X-LinkSunder': 'local' },
    data: { name: `Single delete ${Date.now()}`, url: `${appURL}/demo/fixed`, externalConsent: true },
  }).then((response) => response.json()) as { id: string };
  await expect.poll(async () => (await request.get(`/api/runs/${started.id}`).then((response) => response.json())).status, { timeout: 30000 }).not.toBe('running');
  const selected = await request.get(`/api/runs/${started.id}`).then((response) => response.json()) as { id: string; name: string };
  const selectedTitle = selected.name;
  await page.goto('/');
  await page.getByRole('button', { name: 'Reports & history' }).click();
  await expect(page.getByRole('heading', { name: 'Reports & history' })).toBeVisible();
  await page.getByRole('button', { name: `Delete report ${selectedTitle}` }).click();
  await expect(page.getByRole('dialog')).toContainText('This removes report files');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Delete reports' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Delete reports' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Delete report ${selectedTitle}` })).toBeFocused();
  expect((await request.get(`/api/runs/${selected.id}`)).status()).toBe(200);
  await page.getByRole('button', { name: `Delete report ${selectedTitle}` }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await request.get(`/api/runs/${selected.id}`)).status()).toBe(200);
  await page.getByRole('button', { name: `Delete report ${selectedTitle}` }).click();
  await page.getByRole('button', { name: 'Delete reports' }).click();
  await expect(page.locator('.notice[role="status"]')).toContainText('1 report deleted');
  expect((await request.get(`/api/runs/${selected.id}`)).status()).toBe(404);
});

test('bulk deletion and clear-all history require confirmation', async ({ page, request }) => {
  test.setTimeout(120000);
  const runStart = await request.post('/api/runs', {
    headers: { 'X-LinkSunder': 'local' },
    data: { name: `Bulk delete ${Date.now()}`, url: `${appURL}/demo/fixed`, externalConsent: true },
  }).then((response) => response.json()) as { id: string };
  await expect.poll(async () => (await request.get(`/api/runs/${runStart.id}`).then((response) => response.json())).status, { timeout: 30000 }).not.toBe('running');
  const networkStart = await request.post('/api/network/scans', {
    headers: { 'X-LinkSunder': 'local' },
    data: { target: '127.0.0.1', ports: [appPort], timeout: 1200, authorized: true },
  }).then((response) => response.json()) as { id: string };
  await expect.poll(async () => (await request.get(`/api/network/reports/${networkStart.id}`).then((response) => response.json())).status, { timeout: 30000 }).not.toBe('running');
  const keepStart = await request.post('/api/runs', {
    headers: { 'X-LinkSunder': 'local' },
    data: { name: `Clear all remains ${Date.now()}`, url: `${appURL}/demo/fixed`, externalConsent: true },
  }).then((response) => response.json()) as { id: string };
  await expect.poll(async () => (await request.get(`/api/runs/${keepStart.id}`).then((response) => response.json())).status, { timeout: 30000 }).not.toBe('running');
  const runs = await request.get('/api/runs').then((response) => response.json());
  const network = await request.get('/api/network/reports').then((response) => response.json());
  const available = [
    ...runs.filter((run: { status: string }) => run.status !== 'running').map((run: { id: string; title: string }) => ({ ...run, kind: 'run' })),
    ...network.filter((report: { status: string }) => report.status !== 'running').map((report: { id: string; title: string }) => ({ ...report, kind: 'network' })),
  ];
  expect(available.length).toBeGreaterThanOrEqual(3);
  await page.goto('/');
  await page.getByRole('button', { name: 'Reports & history' }).click();
  for (const item of available.slice(0, 2)) {
    await page.getByRole('checkbox', { name: `Select ${item.title}` }).first().check();
  }
  await page.getByRole('button', { name: 'Delete selected (2)' }).click();
  await page.getByRole('button', { name: 'Delete reports' }).click();
  await expect(page.locator('.notice[role="status"]')).toContainText('2 reports deleted');
  await page.getByRole('button', { name: 'Clear all history' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Clear all history' }).click();
  await page.getByRole('button', { name: 'Delete all reports' }).click();
  await expect(page.getByRole('heading', { name: 'No reports yet' })).toBeVisible({ timeout: 15000 });
  expect(await request.get('/api/runs').then((response) => response.json())).toHaveLength(0);
  expect(await request.get('/api/network/reports').then((response) => response.json())).toHaveLength(0);
});
