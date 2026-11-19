import { beforeAll, afterAll, it, expect } from 'vitest';
import Fastify from 'fastify';
import { demoPage } from '../demo/page';
import { demoScenario, scenarioSchema } from '../shared/schema';
import { execute, newRun } from '../server/runner';
const app = Fastify();
let base = '';
beforeAll(async () => {
  app.get('/demo/:mode', async (req, reply) =>
    reply.type('text/html').send(demoPage((req.params as { mode: string }).mode)),
  );
  app.post('/demo/api/messages', async () => ({ ok: true }));
  app.get('/health/unavailable', async (_req, reply) => reply.code(503).type('text/html').send('<!doctype html><title>Unavailable</title>'));
  app.get('/health/javascript-error', async (_req, reply) => reply.type('text/html').send('<!doctype html><script>throw new Error("fixture error")</script><h1>Loaded with a script error</h1>'));
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
});
it.each(['broken', 'fixed'] as const)('runs real offline draft preservation: %s', async (mode) => {
  const s = demoScenario(base, mode);
  const r = newRun(s);
  await execute(s, r, new AbortController().signal);
  expect(r.status).toBe(mode === 'broken' ? 'fail' : 'pass');
  expect(r.screenshots.length).toBeGreaterThan(0);
  expect(r.network.failed).toBeGreaterThan(0);
});
it.each(['fail', 'delay'] as const)('injects %s into actual requests', async (action) => {
  const s = scenarioSchema.parse({
    name: action,
    url: base + '/demo/fixed',
    steps: [
      { action: 'click', selector: '#send' },
      { action: 'check', selector: '#status[data-state="success"]' },
      { action: 'fill', selector: '#note', value: 'Draft' },
      { action, path: '/demo/api/messages', delay: 350 },
      { action: 'click', selector: '#send' },
      {
        action: 'check',
        selector:
          action === 'fail' ? '#status[data-state="error"]' : '#status[data-state="success"]',
      },
      ...(action === 'fail' ? [{ action: 'value', selector: '#note', value: 'Draft' }] : []),
      { action: 'online' },
      { action: 'click', selector: '#send' },
      { action: 'check', selector: '#status[data-state="success"]' },
    ],
  });
  const r = newRun(s);
  await execute(s, r, new AbortController().signal);
  expect(r.status).toBe('pass');
  expect(r.network.injected).toBeGreaterThan(0);
  expect(r.resilience?.baselineRequests).toBeGreaterThan(0);
  expect(r.resilience?.triggeredRequests).toBeGreaterThan(0);
  expect(r.resilience?.recoveryRequests).toBeGreaterThan(0);
  expect(r.resilience?.recoveryAssertions).toBeGreaterThan(0);
  if (action === 'delay') expect(r.duration).toBeGreaterThan(350);
});
it('never passes a quick scan without assertions', async () => {
  const s = scenarioSchema.parse({ name: 'Observe', url: base + '/demo/fixed' });
  const r = newRun(s);
  await execute(s, r, new AbortController().signal);
  expect(r.status).toBe('not-tested');
  expect(r.assertions).toBe(0);
});
it('passes a basic health check without claiming that resilience was tested', async () => {
  const s = scenarioSchema.parse({ name: 'Health only', url: base + '/demo/fixed', type: 'health' });
  const r = newRun(s);
  await execute(s, r, new AbortController().signal);
  expect(r.status).toBe('pass');
  expect(r.health?.httpStatus).toBe(200);
  expect(r.health?.readyState).toMatch(/interactive|complete/);
  expect(r.health?.checks).toHaveLength(4);
  expect(r.resilience?.faultConfigured).toBe(false);
  expect(r.advice).toContain('does not test offline recovery');
});
it.each([
  { path: '/health/unavailable', label: 'HTTP 503', status: 503 },
  { path: '/health/javascript-error', label: 'uncaught JavaScript error', status: 200 },
])('fails the health check when $label is observed', async ({ path, status }) => {
  const s = scenarioSchema.parse({ name: `Health failure ${status}`, url: base + path, type: 'health' });
  const r = newRun(s);
  await execute(s, r, new AbortController().signal);
  expect(r.status).toBe('fail');
  expect(r.health?.httpStatus).toBe(status);
  if (path.includes('javascript-error')) expect(r.health?.javascriptErrors).toBe(1);
});

function guidedApiScenario(mode: 'fixed' | 'broken' | 'no-loading', fault: 'fail' | 'delay', path = '/demo/api/messages') {
  return scenarioSchema.parse({
    name: `Guided ${fault} ${mode}`,
    type: fault === 'fail' ? 'failure' : 'slow',
    url: `${base}/demo/${mode}`,
    steps: [
      { action: 'fill', selector: 'Your note', locator: 'label', value: 'Baseline draft' },
      { action: 'click', selector: 'Send note', locator: 'button' },
      { action: 'check', selector: 'Saved', locator: 'text' },
      { action: fault, path, delay: 350 },
      { action: 'fill', selector: 'Your note', locator: 'label', value: 'Keep this draft' },
      { action: 'click', selector: 'Send note', locator: 'button' },
      { action: 'check', selector: fault === 'fail' ? 'Could not send. Please retry.' : 'Sending…', locator: 'text' },
      ...(fault === 'delay' ? [{ action: 'check', selector: 'Saved', locator: 'text' }] : []),
      ...(fault === 'fail' ? [{ action: 'value', selector: 'Your note', locator: 'label', value: 'Keep this draft' }] : []),
      { action: 'online' },
      { action: 'fill', selector: 'Your note', locator: 'label', value: 'Recover this draft' },
      { action: 'click', selector: 'Send note', locator: 'button' },
      { action: 'check', selector: 'Saved', locator: 'text' },
    ],
  });
}

it.each(['fixed', 'broken'] as const)('guided API failure distinguishes %s draft preservation', async (mode) => {
  const s = guidedApiScenario(mode, 'fail');
  const r = newRun(s);
  await execute(s, r, new AbortController().signal);
  expect(r.status).toBe(mode === 'fixed' ? 'pass' : 'fail');
  expect(r.resilience?.triggeredRequests).toBeGreaterThan(0);
  expect(r.resilience?.path).toBe('/demo/api/messages');
});

it('guided slow response measures the injected delay and loading feedback', async () => {
  const s = guidedApiScenario('fixed', 'delay');
  const r = newRun(s);
  await execute(s, r, new AbortController().signal);
  expect(r.status).toBe('pass');
  expect(r.resilience?.observedDelayMs).toBeGreaterThanOrEqual(350);
  expect(r.resilience?.recoveryRequests).toBeGreaterThan(0);
});

it('reports a delayed response with no loading feedback as a failed assertion', async () => {
  const s = guidedApiScenario('no-loading', 'delay');
  const r = newRun(s);
  await execute(s, r, new AbortController().signal);
  expect(r.status).toBe('fail');
  expect(r.resilience?.triggeredRequests).toBeGreaterThan(0);
});

it('reports FAULT NOT TRIGGERED when the selected endpoint never matches', async () => {
  const s = guidedApiScenario('fixed', 'fail', '/demo/api/never');
  const r = newRun(s);
  await execute(s, r, new AbortController().signal);
  expect(r.status).toBe('fault-not-triggered');
  expect(r.error).toContain('FAULT NOT TRIGGERED');
  expect(r.resilience?.triggeredRequests).toBe(0);
});
it('cancels a browser during a pending step', async () => {
  const s = scenarioSchema.parse({
    name: 'Cancel',
    url: base + '/demo/fixed',
    steps: [{ action: 'check', selector: '#never' }],
  });
  const r = newRun(s);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  await execute(s, r, controller.signal);
  clearTimeout(timer);
  expect(r.status).toBe('cancelled');
});
