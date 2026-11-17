import Fastify from 'fastify';
import statics from '@fastify/static';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarioSchema, demoScenario, type Run } from '../shared/schema.js';
import { networkInspectionSchema, type NetworkReport } from '../shared/network.js';
import { execute, newRun } from './runner.js';
import { validateTarget } from './security.js';
import { inspectNetworkTarget, normalizeNetworkTarget } from './network-inspector.js';
import { htmlNetworkReport, htmlReport } from './report.js';
import {
  assertWritableDirectory,
  copyReportFiles,
  isValidReportId,
  loadStoredReports,
  persistReport,
  persistReportDirectoryPreference,
  readReportDirectoryPreference,
  removeReportFiles,
} from './storage.js';
// Demo is copied into the production output by TypeScript.
import { demoPage } from '../demo/page.js';
const production =
  process.env.LINKSUNDER_PRODUCTION === '1' ||
  process.argv[1].replaceAll('\\', '/').includes('/dist/');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = production ? path.dirname(root) : root;
const defaultData = path.resolve(process.env.LINKSUNDER_DATA || path.join(projectRoot, 'data'));
const settingsFile = process.env.LINKSUNDER_SETTINGS_FILE ||
  (process.env.LINKSUNDER_DATA ? '' : path.join(os.homedir(), '.linksunder', 'settings.json'));
const configuredReportDirectory = settingsFile ? await readReportDirectoryPreference(settingsFile) : undefined;
let data = path.resolve(configuredReportDirectory || defaultData);
await mkdir(data, { recursive: true });
const app = Fastify({ logger: false, bodyLimit: 150000 });
const port = Number(process.env.PORT || 4317);
let origin = `http://127.0.0.1:${port}`;
const runs = new Map<string, Run>();
const networkReports = new Map<string, NetworkReport>();
const loadedReports = await loadStoredReports(data);
for (const run of loadedReports.runs) runs.set(run.id, run);
for (const report of loadedReports.networkReports) networkReports.set(report.id, report);
const damagedReports = loadedReports.damagedReports;
let active: AbortController | undefined;
let activeTask: Promise<void> | undefined;
let activeNetwork: AbortController | undefined;
let activeNetworkTask: Promise<void> | undefined;
let activeReservation: 'run' | 'network' | undefined;
const executionBusy = () => Boolean(active || activeNetwork || activeReservation);
app.addHook('onRequest', async (req, reply) => {
  if (req.headers.host !== new URL(origin).host)
    return reply.code(403).send({ error: 'Invalid host.' });
  if (req.headers.origin && req.headers.origin !== origin)
    return reply.code(403).send({ error: 'Cross-origin requests are blocked.' });
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  if (req.url.startsWith('/api/')) {
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-linksunder'] !== 'local')
      return reply.code(403).send({ error: 'Use the local dashboard.' });
  }
});
async function persist(run: Run) {
  await persistReport(data, run, htmlReport(run), 'run');
}
async function persistNetwork(report: NetworkReport) {
  await persistReport(data, report, htmlNetworkReport(report), 'network');
}
async function persistSettings() {
  if (!settingsFile) return;
  await persistReportDirectoryPreference(settingsFile, data);
}
async function start(raw: unknown) {
  if (executionBusy())
    throw Object.assign(new Error('Another run is active. Cancel it or wait.'), {
      statusCode: 409,
    });
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success)
    throw Object.assign(
      new Error(
        'Invalid scenario: ' +
          parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; '),
      ),
      { statusCode: 400 },
    );
  activeReservation = 'run';
  try {
    await validateTarget(parsed.data.url, parsed.data.externalConsent);
    const run = newRun(parsed.data);
    runs.set(run.id, run);
    const controller = new AbortController();
    active = controller;
    activeTask = execute(parsed.data, run, controller.signal)
      .catch(() => {
        run.status = controller.signal.aborted ? 'cancelled' : 'error';
        run.error =
          'The test browser could not start. Restart LinkSunder or reinstall the desktop application.';
      })
      .finally(async () => {
        try {
          await persist(run);
        } catch {
          run.status = 'error';
          run.error = 'Report could not be saved. Check disk permissions.';
        } finally {
          active = undefined;
          activeTask = undefined;
          activeReservation = undefined;
        }
      });
    return run;
  } catch (error) {
    if (!active) activeReservation = undefined;
    throw error;
  }
}
app.get('/api/info', async () => ({ reportDirectory: data, damagedReports }));
app.post('/api/settings/report-directory', async (req, reply) => {
  if (executionBusy()) return reply.code(409).send({ error: 'Wait for the current check to finish before changing report storage.' });
  const body = req.body as { path?: unknown };
  const selectedPath = typeof body?.path === 'string' ? body.path.trim() : '';
  if (!selectedPath || !path.isAbsolute(selectedPath))
    return reply.code(400).send({ error: 'Choose an absolute folder path.' });
  const destination = path.resolve(selectedPath);
  const samePath = process.platform === 'win32'
    ? destination.toLowerCase() === data.toLowerCase()
    : destination === data;
  if (samePath) return { reportDirectory: data, copied: 0, total: 0 };
  try {
    await assertWritableDirectory(destination);
    const migrated = await copyReportFiles(data, destination);
    const previous = data;
    data = destination;
    try {
      await persistSettings();
    } catch (error) {
      data = previous;
      throw error;
    }
    return { reportDirectory: data, ...migrated, originalsKept: true };
  } catch (error) {
    return reply.code(400).send({
      error: `Could not change report storage. The current folder and its reports were kept. ${(error as Error).message}`,
    });
  }
});
app.get('/api/runs', async () =>
  [...runs.values()].reverse().map((r) => ({ ...r, screenshots: [] })),
);
app.get<{ Params: { id: string } }>(
  '/api/runs/:id',
  async (req, reply) =>
    runs.get(req.params.id) || reply.code(404).send({ error: 'Run not found.' }),
);
app.get('/api/network/reports', async () => [...networkReports.values()].reverse());
app.get<{ Params: { id: string } }>('/api/network/reports/:id', async (req, reply) =>
  networkReports.get(req.params.id) || reply.code(404).send({ error: 'Network report not found.' }),
);
app.get<{ Params: { id: string; format: string } }>(
  '/api/network/reports/:id/:format',
  async (req, reply) => {
    const report = networkReports.get(req.params.id);
    if (!report) return reply.code(404).send({ error: 'Network report not found.' });
    if (!['json', 'html'].includes(req.params.format))
      return reply.code(400).send({ error: 'Choose json or html.' });
    reply.header(
      'Content-Disposition',
      `attachment; filename="linksunder-network-${report.id}.${req.params.format}"`,
    );
    return req.params.format === 'html'
      ? reply.type('text/html').send(htmlNetworkReport(report))
      : reply.type('application/json').send(JSON.stringify(report, null, 2));
  },
);
app.post('/api/network/scans', async (req, reply) => {
  if (executionBusy()) return reply.code(409).send({ error: 'Wait for the current check to finish before starting another.' });
  const parsed = networkInspectionSchema.safeParse(req.body);
  if (!parsed.success) {
    const authorizationMissing = parsed.error.issues.some((issue) => issue.path[0] === 'authorized');
    return reply.code(400).send({
      error: authorizationMissing
        ? 'Confirm that you own or are authorized to inspect this target.'
        : `Invalid inspection request: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
    });
  }
  let target;
  try {
    target = normalizeNetworkTarget(parsed.data.target);
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }
  const id = randomUUID();
  const report: NetworkReport = {
    id,
    kind: 'network',
    target: target.target,
    hostname: target.hostname,
    started: new Date().toISOString(),
    status: 'running',
    progress: 'Starting inspection…',
    dns: { A: [], AAAA: [], CNAME: [], NS: [], MX: [], reverse: [], lookupTimeMs: 0 },
    ports: [],
    http: [],
    findings: [],
    limitations: [],
  };
  const controller = new AbortController();
  networkReports.set(id, report);
  activeReservation = 'network';
  try {
    await persistNetwork(report);
  } catch {
    networkReports.delete(id);
    activeReservation = undefined;
    return reply.code(500).send({ error: 'The inspection could not be started because the report folder is not writable.' });
  }
  activeNetwork = controller;
  activeNetworkTask = inspectNetworkTarget(parsed.data, id, controller.signal, (progress) => {
    report.progress = progress;
  })
    .then(async (completed) => {
      Object.assign(report, completed);
      await persistNetwork(report);
    })
    .catch(async () => {
      report.status = controller.signal.aborted ? 'cancelled' : 'error';
      report.progress = controller.signal.aborted ? 'Cancelled' : 'Stopped';
      report.error = 'The network report could not be saved. Check available storage and permissions.';
      report.completed = new Date().toISOString();
      await persistNetwork(report).catch(() => undefined);
    })
    .finally(() => {
      activeNetwork = undefined;
      activeNetworkTask = undefined;
      activeReservation = undefined;
    });
  return report;
});
app.post('/api/network/cancel', async () => {
  activeNetwork?.abort();
  return { ok: true };
});
app.post('/api/history/delete', async (req, reply) => {
  const body = req.body as { reports?: unknown };
  if (!Array.isArray(body?.reports) || body.reports.length < 1 || body.reports.length > 1000)
    return reply.code(400).send({ error: 'Select between 1 and 1000 reports.' });
  if (body.reports.some((item) => !item || typeof item !== 'object' || Array.isArray(item)))
    return reply.code(400).send({ error: 'One or more report selections are invalid.' });
  const requested = body.reports as Array<{ id?: unknown; kind?: unknown }>;
  const unique = [...new Map(requested.map((item) => [`${item.kind}:${item.id}`, item])).values()];
  for (const item of unique) {
    if (!['run', 'network'].includes(item.kind as string) || !isValidReportId(item.id))
      return reply.code(400).send({ error: 'One or more report selections are invalid.' });
    const kind = item.kind as 'run' | 'network';
    const id = item.id;
    const report = kind === 'run' ? runs.get(id) : networkReports.get(id);
    if (!report) return reply.code(404).send({ error: 'A selected report is no longer available.' });
    if (report.status === 'running') return reply.code(409).send({ error: 'Running checks cannot be deleted.' });
  }
  try {
    for (const item of unique) {
      const kind = item.kind as 'run' | 'network';
      const id = item.id as string;
      await removeReportFiles(data, kind, id);
      if (kind === 'run') runs.delete(id);
      else networkReports.delete(id);
    }
    return { deleted: unique.length };
  } catch {
    return reply.code(500).send({ error: 'Some report files could not be removed. Check folder permissions and try again.' });
  }
});
app.post('/api/runs', async (req, reply) => {
  try {
    return await start(req.body);
  } catch (e) {
    return reply
      .code((e as { statusCode?: number }).statusCode || 400)
      .send({ error: (e as Error).message });
  }
});
app.post('/api/cancel', async () => {
  active?.abort();
  return { ok: true };
});
app.post('/api/demo', async (_req, reply) => {
  if (executionBusy()) return reply.code(409).send({ error: 'Another check is active.' });
  const first = await start(demoScenario(origin, 'broken'));
  return { id: first.id, next: demoScenario(origin, 'fixed') };
});
app.get<{ Params: { id: string; format: string } }>(
  '/api/reports/:id/:format',
  async (req, reply) => {
    const run = runs.get(req.params.id);
    if (!run) return reply.code(404).send({ error: 'Run not found.' });
    if (!['json', 'html'].includes(req.params.format))
      return reply.code(400).send({ error: 'Choose json or html.' });
    reply.header(
      'Content-Disposition',
      `attachment; filename="linksunder-${run.id}.${req.params.format}"`,
    );
    return req.params.format === 'html'
      ? reply.type('text/html').send(htmlReport(run))
      : reply.type('application/json').send(JSON.stringify(run, null, 2));
  },
);
app.get<{ Params: { mode: string } }>('/demo/:mode', async (req, reply) =>
  reply.type('text/html').send(demoPage(req.params.mode === 'broken' ? 'broken' : 'fixed')),
);
app.post('/demo/api/messages', async () => ({ saved: true }));
if (production) {
  await app.register(statics, { root: path.join(root, 'client') });
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: path.join(root, 'vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.setNotFoundHandler(async (req, reply) => {
    const pathname = req.url.split('?')[0];
    if (pathname !== '/' && !pathname.includes('.') && !pathname.startsWith('/@'))
      return reply.code(404).send({ error: 'Route not found.' });
    reply.hijack();
    vite.middlewares(req.raw, reply.raw, () => {
      reply.raw.statusCode = 404;
      reply.raw.end();
    });
  });
  app.addHook('onClose', async () => {
    await vite.close();
  });
}
app.addHook('onClose', async () => {
  active?.abort();
  activeNetwork?.abort();
  await Promise.all([activeTask, activeNetworkTask]);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
origin = await app.listen({ host: '127.0.0.1', port });
console.log(`LinkSunder ready: ${origin}`);
