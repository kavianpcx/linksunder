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
    resilience: {
      faultConfigured: false,
      fault: 'none',
      baselineRequests: 0,
      triggeredRequests: 0,
      recoveryRequests: 0,
      disruptionAssertions: 0,
      recoveryAssertions: 0,
    },
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
    let configuredFault: { path: string; delay: number; fail: boolean } | undefined;
    let faultActionSeen = false;
    let recoveryStarted = false;
    let recoveryActionSeen = false;
    const baselinePaths = new Map<string, number>();
    const offlinePaths = new Set<string>();
    const normalizePath = (pathname: string) => pathname.replace(/\/+$/, '') || '/';
    const isFaultRequest = (url: URL) =>
      Boolean(configuredFault && normalizePath(url.pathname) === normalizePath(configuredFault.path));
    await context.route('**/*', async (route: Route) => {
      try {
        const requestUrl = new URL(route.request().url());
        if (!['http:', 'https:'].includes(requestUrl.protocol)) {
          await route.continue();
          return;
        }
        if (offline) {
          if (faultActionSeen) {
            offlinePaths.add(normalizePath(requestUrl.pathname));
            run.network.injected++;
            run.resilience!.triggeredRequests++;
            update();
          }
          await route.abort('internetdisconnected');
          return;
        }
        await validateTarget(route.request().url(), s.externalConsent, target.origin);
        const activeFault = fault;
        const faultMatches = Boolean(activeFault && isFaultRequest(requestUrl));
        if (faultMatches && activeFault && faultActionSeen) {
          run.network.injected++;
          run.resilience!.triggeredRequests++;
          update();
          if (activeFault.fail) {
            await route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: '{"error":"Injected by LinkSunder"}',
            });
            return;
          }
          const delayStarted = Date.now();
          await new Promise((r) => setTimeout(r, activeFault.delay));
          run.resilience!.observedDelayMs = Date.now() - delayStarted;
        }
        // fetch follows no redirects: redirected requests must re-enter the policy check.
        const response = await route.fetch({ maxRedirects: 0, timeout: s.timeout });
        if (
          recoveryStarted &&
          recoveryActionSeen &&
          (offlinePaths.has(normalizePath(requestUrl.pathname)) || isFaultRequest(requestUrl))
        ) {
          if (response.status() < 500) {
            run.resilience!.recoveryRequests++;
            update();
          }
        }
        if (!run.resilience!.faultConfigured && response.status() < 500) {
          const path = normalizePath(requestUrl.pathname);
          baselinePaths.set(path, (baselinePaths.get(path) || 0) + 1);
        }
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
    for (const step of s.steps) {
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
            if (run.resilience!.faultConfigured) faultActionSeen = true;
            if (recoveryStarted) recoveryActionSeen = true;
            await page.goto(target.href, { waitUntil: 'domcontentloaded' });
            break;
          case 'click':
            if (run.resilience!.faultConfigured && !recoveryStarted) faultActionSeen = true;
            if (recoveryStarted) recoveryActionSeen = true;
            await page.locator(step.selector).click();
            break;
          case 'fill':
            if (run.resilience!.faultConfigured && !recoveryStarted) faultActionSeen = true;
            if (recoveryStarted) recoveryActionSeen = true;
            await page.locator(step.selector).fill(step.value);
            break;
          case 'offline':
            if (run.resilience!.faultConfigured && run.resilience!.fault !== 'offline')
              throw new Error('Configure only one disruption type in a scenario.');
            run.resilience!.faultConfigured = true;
            run.resilience!.fault = 'offline';
            run.resilience!.baselineRequests = [...baselinePaths.values()].reduce((sum, count) => sum + count, 0);
            offline = true;
            recoveryStarted = false;
            faultActionSeen = false;
            await context.setOffline(true);
            break;
          case 'online':
            offline = false;
            fault = undefined;
            recoveryStarted = true;
            recoveryActionSeen = false;
            await context.setOffline(false);
            break;
          case 'fail':
          case 'delay':
            if (!step.path.startsWith('/')) throw new Error('API path must start with /.');
            if (run.resilience!.faultConfigured)
              throw new Error('Configure only one disruption type in a scenario.');
            configuredFault = { path: step.path, delay: step.delay, fail: step.action === 'fail' };
            fault = configuredFault;
            run.resilience!.faultConfigured = true;
            run.resilience!.fault = step.action === 'fail' ? 'failure' : 'slow';
            run.resilience!.baselineRequests = baselinePaths.get(normalizePath(step.path)) || 0;
            faultActionSeen = false;
            recoveryStarted = false;
            break;
          case 'check':
            run.assertions++;
            await page.locator(step.selector).waitFor({ state: 'visible' });
            run.passed++;
            if (recoveryStarted) run.resilience!.recoveryAssertions++;
            else if (faultActionSeen) run.resilience!.disruptionAssertions++;
            break;
          case 'value':
            run.assertions++;
            if ((await page.locator(step.selector).inputValue()) !== step.value)
              throw new Error('Field value did not match the expected value.');
            run.passed++;
            if (recoveryStarted) run.resilience!.recoveryAssertions++;
            else if (faultActionSeen) run.resilience!.disruptionAssertions++;
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
    if (!run.resilience!.faultConfigured) {
      outcome = run.assertions || run.steps.length === 0 ? 'not-tested' : 'observed';
      run.advice = run.steps.length === 0
        ? 'Quick Scan did not configure a disruption or meaningful action. Add a baseline request, disruption, trigger action, assertion and recovery check before testing resilience.'
        : run.assertions
          ? 'The configured checks ran without a network disruption. Add Offline, Fail API or Delay API, trigger it with a browser action, and verify recovery to test resilience.'
          : 'No resilience fault or assertion was configured. This run records page observations only and does not establish site health.';
    } else if (run.resilience!.triggeredRequests === 0) {
      outcome = 'fault-not-triggered';
      run.error = 'FAULT NOT TRIGGERED: no matching request occurred after the configured browser action.';
      run.advice = run.resilience!.fault === 'failure' || run.resilience!.fault === 'slow'
        ? run.resilience!.baselineRequests === 0
          ? 'Run the selected action once before the fault to record baseline behavior, then configure the fault and repeat the action.'
          : 'Check the endpoint path and choose an action that sends this request.'
        : 'Choose an action that needs the network while Offline is active.';
    } else if (run.assertions > run.passed) {
      outcome = 'fail';
    } else if (
      run.resilience!.baselineRequests === 0 ||
      run.resilience!.disruptionAssertions === 0 ||
      run.resilience!.recoveryRequests === 0 ||
      run.resilience!.recoveryAssertions === 0
    ) {
      outcome = 'not-tested';
      run.advice = 'The disruption occurred, but the scenario did not verify every stage. Record a baseline request, add an assertion after the disrupted request, restore connectivity, trigger a recovery request, and assert the recovered behavior.';
    } else {
      outcome = 'pass';
      run.advice = 'The baseline, injected disruption, application assertion and recovery request/assertion were all observed.';
    }
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
