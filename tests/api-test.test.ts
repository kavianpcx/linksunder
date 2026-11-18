import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { apiTestSchema } from '../shared/api-test';
import { createApiTestRun, executeApiTest } from '../server/api-test';

let server: Server;
let base = '';
let requests = 0;
let retryRequests = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    requests += 1;
    const parsedUrl = new URL(request.url || '/', 'http://fixture.local');
    const slow = parsedUrl.searchParams.has('slow') && requests % 2 === 0;
    const transientFailure = parsedUrl.searchParams.has('retry') && ++retryRequests === 1;
    const respond = () => {
      response.statusCode = transientFailure ? 503 : 200;
      response.setHeader('content-type', 'application/json');
      response.setHeader('x-fixture', 'present');
      response.setHeader('set-cookie', 'session=must-not-appear');
      response.end(JSON.stringify({ result: 'ready', token: 'secret-in-body' }));
    };
    if (slow) setTimeout(respond, 300);
    else respond();
  });
  base = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe('API Test Builder', () => {
  it('requires explicit confirmation for data-changing requests and blocks their replay', () => {
    expect(apiTestSchema.safeParse({ name: 'delete', url: `${base}/item`, method: 'DELETE' }).success).toBe(false);
    expect(apiTestSchema.safeParse({ name: 'post', url: `${base}/item`, method: 'POST', confirmUnsafe: true, retries: 1 }).success).toBe(false);
    expect(apiTestSchema.safeParse({ name: 'post', url: `${base}/item`, method: 'POST', confirmUnsafe: true, fault: 'latency' }).success).toBe(false);
    expect(apiTestSchema.parse({ name: 'safe', url: `${base}/health` }).method).toBe('GET');
  });

  it('runs baseline, locally injected 503 and recovery with assertions and redacted previews', async () => {
    requests = 0;
    const config = apiTestSchema.parse({
      name: 'Local API 503 recovery', url: `${base}/resource`, expectedStatus: 200,
      expectedHeaders: ['x-fixture'], jsonAssertions: [{ path: 'result', operator: 'equals', expected: '"ready"' }],
      jsonSchema: JSON.stringify({ type: 'object', required: ['result'], properties: { result: { type: 'string' } } }),
      fault: 'http-503',
    });
    const run = createApiTestRun(config);
    await executeApiTest(config, run, new AbortController().signal);
    expect(run.status).toBe('pass');
    expect(run.apiTest?.requestCount).toBe(3);
    expect(run.apiTest?.faultTriggered).toBe(true);
    expect(run.apiTest?.baseline?.statusCode).toBe(200);
    expect(run.apiTest?.disrupted).toMatchObject({ statusCode: 503, originalStatusCode: 200 });
    expect(run.apiTest?.recovery?.statusCode).toBe(200);
    expect(run.apiTest?.baseline?.responseHeaders).not.toHaveProperty('set-cookie');
    expect(run.apiTest?.baseline?.preview).toContain('[redacted]');
    expect(run.apiTest?.baseline?.preview).not.toContain('secret-in-body');
    expect(run.assertions).toBeGreaterThan(0);
    expect(run.passed).toBe(run.assertions);
  });

  it('measures injected latency and does not persist a private response body by default', async () => {
    const config = apiTestSchema.parse({ name: 'Local latency', url: `${base}/resource`, fault: 'latency', faultDelayMs: 80, expectedStatus: 200 });
    const run = createApiTestRun(config);
    await executeApiTest(config, run, new AbortController().signal);
    expect(run.status).toBe('pass');
    expect(run.apiTest?.disrupted?.responseTimeMs).toBeGreaterThanOrEqual(80);
    const safe = structuredClone(run);
    if (safe.apiTest) {
      delete safe.apiTest.baseline?.preview;
      delete safe.apiTest.disrupted?.preview;
      delete safe.apiTest.recovery?.preview;
    }
    expect(JSON.stringify(safe)).not.toContain('secret-in-body');
  });

  it('cancels an artificial delay promptly and does not send a recovery request', async () => {
    requests = 0;
    const config = apiTestSchema.parse({ name: 'Cancel latency', url: `${base}/resource`, fault: 'latency', faultDelayMs: 10000 });
    const run = createApiTestRun(config);
    const controller = new AbortController();
    const cancelTimer = setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    await executeApiTest(config, run, controller.signal);
    clearTimeout(cancelTimer);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(run.status).toBe('cancelled');
    expect(run.apiTest?.faultTriggered).toBe(true);
    expect(run.apiTest?.requestCount).toBe(2);
    expect(run.apiTest?.disrupted?.responseTimeMs).toBeLessThan(1000);
    expect(run.apiTest?.recovery).toBeUndefined();
  });

  it('applies only explicitly configured bounded retries to a safe GET', async () => {
    retryRequests = 0;
    const config = apiTestSchema.parse({ name: 'Safe GET retry', url: `${base}/resource?retry=true`, retries: 1, expectedStatus: 200 });
    const run = createApiTestRun(config);
    await executeApiTest(config, run, new AbortController().signal);
    expect(run.status).toBe('pass');
    expect(run.apiTest?.requestCount).toBe(2);
    expect(run.apiTest?.baseline?.statusCode).toBe(200);
  });

  it('recognizes a real injected timeout on a slow fixture and records recovery', async () => {
    requests = 0;
    const config = apiTestSchema.parse({ name: 'Local timeout', url: `${base}/resource?slow=true`, fault: 'timeout', timeout: 500, expectedStatus: 200 });
    const run = createApiTestRun(config);
    await executeApiTest(config, run, new AbortController().signal);
    expect(run.apiTest?.faultTriggered).toBe(true);
    expect(run.apiTest?.disrupted?.failureReason).toMatch(/timed out/i);
    expect(run.apiTest?.recovery?.statusCode).toBe(200);
    expect(run.apiTest?.requestCount).toBe(3);
  });
});
