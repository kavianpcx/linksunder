import { chromium, type BrowserContext, type Route } from 'playwright';
import { randomUUID } from 'node:crypto';
import type { Run, Scenario } from '../shared/schema.js';
import { validateTarget } from './security.js';
import { browserOptions } from './browser.js';
export function newRun(s: Scenario): Run {
  return {
    id: randomUUID(),
    name: s.name,
    targetHost: new URL(s.url).hostname,
    type: s.type,
    status: 'running',
    started: new Date().toISOString(),
    duration: 0,
    steps: [],
    assertions: 0,
    passed: 0,
    screenshots: [],
    network: { failed: 0, injected: 0 },
  };
}
export async function execute(
  s: Scenario,
  run: Run,
  signal: AbortSignal,
  update: () => void = () => {},
) {
  const start = Date.now();
  let outcome: Run['status'] = 'error';
  let context: BrowserContext | undefined;
  const browser = await chromium.launch({
    ...browserOptions(),
    headless: true,
    args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  });
  const stop = () => {
    void browser.close();
  };
  signal.addEventListener('abort', stop, { once: true });
  const totalTimer = setTimeout(
    () => {
      void browser.close();
    },
    Math.min(120000, s.timeout * Math.max(2, s.steps.length)),
  );
  try {
    if (signal.aborted) throw new Error('Cancelled');
    const target = await validateTarget(s.url, s.externalConsent);
    context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    context.setDefaultTimeout(s.timeout);
    let offline = false;
    let fault: { path: string; delay: number; fail: boolean } | undefined;
    await context.route('**/*', async (route: Route) => {
      try {
        if (offline) {
          await route.abort('internetdisconnected');
          return;
        }
        await validateTarget(route.request().url(), s.externalConsent, target.origin);
        if (fault && new URL(route.request().url()).pathname.includes(fault.path)) {
          run.network.injected++;
          update();
          if (fault.fail) {
            await route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: '{"error":"Injected by LinkSunder"}',
            });
            return;
          }
          await new Promise((r) => setTimeout(r, fault!.delay));
        }
        // fetch follows no redirects: redirected requests must re-enter the policy check.
        const response = await route.fetch({ maxRedirects: 0, timeout: s.timeout });
        await route.fulfill({ response });
      } catch {
        await route.abort().catch(() => {});
      }
    });
    const page = await context.newPage();
    page.on('requestfailed', () => {
      run.network.failed++;
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    const capture = async () => {
      if (!s.screenshots) return;
      const masks = [
        page.locator('input, textarea, [contenteditable], [data-sensitive]'),
        ...s.maskSelectors.map((x) => page.locator(x)),
      ];
      run.screenshots.push(
        'data:image/png;base64,' +
          (await page.screenshot({ mask: masks, maskColor: '#37344d', fullPage: false })).toString(
            'base64',
          ),
      );
    };
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: s.timeout });
    // Quick scans inject a fault but deliberately make no health assertion.
    const steps = s.steps.length
      ? s.steps
      : [
          {
            action: s.type === 'offline' ? 'offline' : s.type === 'failure' ? 'fail' : 'delay',
            selector: '',
            value: '',
            path: '/api/',
            delay: 1000,
          } as const,
          { action: 'online', selector: '', value: '', path: '', delay: 0 } as const,
        ];
    for (const step of steps) {
      if (signal.aborted) throw new Error('Cancelled');
      const sr: Run['steps'][number] = {
        action: step.action,
        status: 'running',
        message: 'Executing',
        duration: 0,
      };
      run.steps.push(sr);
      update();
      const t = Date.now();
      try {
        switch (step.action) {
          case 'open':
            await page.goto(target.href, { waitUntil: 'domcontentloaded' });
            break;
          case 'click':
            await page.locator(step.selector).click();
            break;
          case 'fill':
            await page.locator(step.selector).fill(step.value);
            break;
          case 'offline':
            offline = true;
            await context.setOffline(true);
            break;
          case 'online':
            offline = false;
            await context.setOffline(false);
            break;
          case 'fail':
          case 'delay':
            if (!step.path.startsWith('/')) throw new Error('API path must start with /.');
            fault = { path: step.path, delay: step.delay, fail: step.action === 'fail' };
            break;
          case 'check':
            run.assertions++;
            await page.locator(step.selector).waitFor({ state: 'visible' });
            run.passed++;
            break;
          case 'value':
            run.assertions++;
            if ((await page.locator(step.selector).inputValue()) !== step.value)
              throw new Error('Field value did not match the expected value.');
            run.passed++;
            break;
          case 'screenshot':
            await capture();
            break;
        }
        sr.status = 'pass';
        sr.message = ['check', 'value'].includes(step.action)
          ? 'Assertion passed'
          : 'Step completed';
      } catch (error) {
        sr.status = 'fail';
        sr.message =
          step.action === 'value'
            ? 'Field value did not match the expected value.'
            : 'Step could not complete. Check the selector, target availability and timeout.';
        await capture().catch(() => {});
        throw error;
      } finally {
        sr.duration = Date.now() - t;
        update();
      }
    }
    outcome = run.assertions ? 'pass' : 'observed';
  } catch {
    outcome = signal.aborted
      ? 'cancelled'
      : run.steps.some((x) => x.status === 'fail' && ['check', 'value'].includes(x.action))
        ? 'fail'
        : 'error';
    run.error = signal.aborted
      ? 'Run cancelled.'
      : run.steps.at(-1)?.message ||
        'Browser or page could not start. Restart the application and check the target URL.';
    run.advice =
      outcome === 'fail'
        ? 'Preserve drafts until the server confirms success. Handle rejected requests and show a recoverable error.'
        : 'Check page selectors, URL permissions, browser setup and timeout. No unverified assertion is counted as passed.';
  } finally {
    clearTimeout(totalTimer);
    signal.removeEventListener('abort', stop);
    await context?.setOffline(false).catch(() => {});
    await browser.close().catch(() => {});
    run.duration = Date.now() - start;
    run.status = outcome;
    update();
  }
}
