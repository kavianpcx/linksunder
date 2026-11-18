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
