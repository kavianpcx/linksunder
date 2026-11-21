import Fastify from 'fastify';
import statics from '@fastify/static';
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarioSchema, demoScenario, type Run } from '../shared/schema.js';
import { apiTestSchema } from '../shared/api-test.js';
import { networkInspectionSchema, type NetworkReport } from '../shared/network.js';
import type { HistoryQuery } from '../shared/history.js';
import { execute, newRun } from './runner.js';
import { createApiTestRun, executeApiTest } from './api-test.js';
import { validateTarget } from './security.js';
import { inspectNetworkTarget, normalizeNetworkTarget } from './network-inspector.js';
import { htmlNetworkReport, htmlReport } from './report.js';
import { HistoryIndex } from './history-index.js';
import { processDeleteBatch } from './history-deletion.js';
import { OfflineGeolocation } from './geolocation.js';
import {
  assertWritableDirectory,
  copyReportFiles,
  isValidReportId,
  persistReport,
  persistReportDirectoryPreference,
  persistGeolocationPreference,
  readReportDirectoryPreference,
  readReportStoragePreferences,
  purgeStagedReportFiles,
  restoreStagedReportFiles,
  storedReportFilenames,
  stageReportFiles,
  type ReportCopyProgress,
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
const storedPreferences = settingsFile ? await readReportStoragePreferences(settingsFile) : {};
const configuredReportDirectory = storedPreferences.reportDirectory ||
  (settingsFile ? await readReportDirectoryPreference(settingsFile) : undefined);
let data = path.resolve(configuredReportDirectory || defaultData);
const geolocation = new OfflineGeolocation({
  city: storedPreferences.geolocationCityPath,
  asn: storedPreferences.geolocationAsnPath,
});
await mkdir(data, { recursive: true });
const historyDatabase = path.resolve(process.env.LINKSUNDER_HISTORY_DB || path.join(settingsFile ? path.dirname(settingsFile) : data, 'history.sqlite'));
await mkdir(path.dirname(historyDatabase), { recursive: true });
const historyIndex = new HistoryIndex(historyDatabase);
historyIndex.beginIndexing(data);
const app = Fastify({ logger: false, bodyLimit: 150000 });
const port = Number(process.env.PORT || 4317);
let origin = `http://127.0.0.1:${port}`;
const runs = new Map<string, Run>();
const networkReports = new Map<string, NetworkReport>();
let active: AbortController | undefined;
let activeTask: Promise<void> | undefined;
let activeNetwork: AbortController | undefined;
let activeNetworkTask: Promise<void> | undefined;
let activeApiTest: AbortController | undefined;
let activeApiTask: Promise<void> | undefined;
let activeReservation: 'run' | 'network' | 'api' | 'storage' | undefined;
let indexingController = new AbortController();
let indexingTask: Promise<void> | undefined;
let deletionRecoveryError: string | undefined;
interface StorageMigrationJob extends ReportCopyProgress {
  id: string;
  status: 'running' | 'complete' | 'error' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  result?: { reportDirectory: string; copied: number; total: number; originalsKept: true };
}
let storageMigration: StorageMigrationJob | undefined;
let storageMigrationController: AbortController | undefined;
let storageMigrationTask: Promise<void> | undefined;
const executionBusy = () => Boolean(active || activeNetwork || activeApiTest || activeReservation);
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
  const stored = structuredClone(run);
  if (stored.apiTest) {
    delete stored.apiTest.baseline?.preview;
    delete stored.apiTest.disrupted?.preview;
    delete stored.apiTest.recovery?.preview;
  }
  await persistReport(data, stored, htmlReport(stored), 'run');
  historyIndex.upsertRun(stored, data);
}
async function persistNetwork(report: NetworkReport) {
  await persistReport(data, report, htmlNetworkReport(report), 'network');
  historyIndex.upsertNetwork(report, data);
}
function safeRunDownload(run: Run): Run {
  const safe = structuredClone(run);
  if (safe.apiTest) {
    delete safe.apiTest.baseline?.preview;
    delete safe.apiTest.disrupted?.preview;
    delete safe.apiTest.recovery?.preview;
  }
  return safe;
}
async function readStoredReport(kind: 'run' | 'network', id: string): Promise<Run | NetworkReport | undefined> {
  if (!isValidReportId(id)) return undefined;
  const file = historyIndex.getReportFile(kind, id);
  if (!file) return undefined;
  const [jsonName] = storedReportFilenames(kind, id);
  if (file.jsonName !== jsonName || !path.isAbsolute(file.directory)) return undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(file.directory, jsonName), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const report = parsed as Run | NetworkReport;
    if (report.id !== id) return undefined;
    if (report.status === 'running') {
      if (kind === 'run') {
        (report as Run).status = 'error';
        (report as Run).error = 'Interrupted by server shutdown.';
      } else {
        (report as NetworkReport).status = 'cancelled';
        (report as NetworkReport).progress = 'Interrupted';
        (report as NetworkReport).error = 'Inspection was interrupted when LinkSunder closed. Completed observations are preserved.';
      }
    }
    return report;
  } catch {
    return undefined;
  }
}
async function deleteIndexedReport(kind: 'run' | 'network', id: string) {
  const indexed = historyIndex.getReportFile(kind, id);
  if (!indexed) return false;
  if (indexed.status === 'running') throw new Error('Running checks cannot be deleted.');
  historyIndex.setDeleteJournal(kind, id, indexed.directory, 'staging');
  try {
    await stageReportFiles(indexed.directory, kind, id);
    historyIndex.commitDeletion(kind, id);
  } catch {
    try {
      await restoreStagedReportFiles(indexed.directory, kind, id);
      historyIndex.clearDeleteJournal(kind, id);
    } catch {
      throw new Error('Deletion was interrupted safely. LinkSunder will retry recovery at the next launch.');
    }
    throw new Error('The report could not be safely removed. Its files were preserved.');
  }
  try {
    await purgeStagedReportFiles(indexed.directory, kind, id);
    historyIndex.clearDeleteJournal(kind, id);
  } catch {
    // The committed deletion is complete; startup recovery will remove staged files if needed.
  }
  return true;
}

async function recoverStagedDeletions() {
  for (const entry of historyIndex.listDeleteJournal()) {
    if (entry.state === 'staging')
      await restoreStagedReportFiles(entry.directory, entry.kind, entry.id);
    else
      await purgeStagedReportFiles(entry.directory, entry.kind, entry.id);
    historyIndex.clearDeleteJournal(entry.kind, entry.id);
  }
}

const deleteWorkerController = new AbortController();
let deleteWorkerTask: Promise<void> | undefined;
async function processDeleteJobs() {
  if (deleteWorkerTask) return deleteWorkerTask;
  deleteWorkerTask = (async () => {
    try {
      while (!deleteWorkerController.signal.aborted) {
        const jobId = historyIndex.incompleteDeleteJobs()[0];
        if (!jobId) return;
        const batch = historyIndex.pendingDeleteItems(jobId, 25);
        if (!batch.length) return;
        await processDeleteBatch(historyIndex, jobId, batch);
        if (deleteWorkerController.signal.aborted) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      deleteWorkerTask = undefined;
    }
  })();
  return deleteWorkerTask;
}

async function queryHistoryAtStartup(directory = data) {
  indexingController.abort();
  await indexingTask?.catch(() => {});
  indexingController = new AbortController();
  indexingTask = historyIndex.reconcileDirectory(directory, indexingController.signal)
    .catch((error) => console.error('History indexing could not finish:', (error as Error).message));
  return indexingTask;
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
    historyIndex.upsertRun(run, data);
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
          historyIndex.upsertRun(run, data);
        } finally {
          runs.delete(run.id);
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
async function startApiTest(raw: unknown) {
  if (executionBusy()) throw Object.assign(new Error('Another run is active. Cancel it or wait.'), { statusCode: 409 });
  const parsed = apiTestSchema.safeParse(raw);
  if (!parsed.success)
    throw Object.assign(new Error('Invalid API test: ' + parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')), { statusCode: 400 });
  activeReservation = 'api';
  try {
    await validateTarget(parsed.data.url, parsed.data.externalConsent);
    const run = createApiTestRun(parsed.data);
    runs.set(run.id, run);
    historyIndex.upsertRun(run, data);
    try {
      await persist(run);
    } catch {
      runs.delete(run.id);
      historyIndex.deleteRecord('run', run.id);
      throw Object.assign(new Error('The API test could not start because the report folder is not writable.'), { statusCode: 500 });
    }
    const controller = new AbortController();
    activeApiTest = controller;
    activeApiTask = executeApiTest(parsed.data, run, controller.signal)
      .then(() => persist(run))
      .catch(async () => {
        run.status = controller.signal.aborted ? 'cancelled' : 'error';
        run.error = controller.signal.aborted ? 'API test cancelled.' : 'The API report could not be saved. Check available storage and permissions.';
        await persist(run).catch(() => undefined);
      })
      .finally(() => {
        activeApiTest = undefined;
        activeApiTask = undefined;
        activeReservation = undefined;
        const cleanup = setTimeout(() => runs.delete(run.id), 120000);
        cleanup.unref();
      });
    return safeRunDownload(run);
  } catch (error) {
    if (!activeApiTest) activeReservation = undefined;
    throw error;
  }
}
app.get('/api/info', async () => ({ reportDirectory: data, ...historyIndex.getSummary(), deletionRecoveryError, storageMigration }));
app.get('/api/summary', async () => ({ ...historyIndex.getSummary(), deletionRecoveryError }));
app.get('/api/operations', async () => {
  const activeLabels = [
    active || activeReservation === 'run' ? 'a resilience test' : undefined,
    activeNetwork || activeReservation === 'network' ? 'a network inspection' : undefined,
    activeApiTest || activeReservation === 'api' ? 'an API test' : undefined,
    activeReservation === 'storage' ? 'a report folder change' : undefined,
    deleteWorkerTask || historyIndex.incompleteDeleteJobs().length ? 'report cleanup' : undefined,
  ].filter(Boolean);
  return {
    busy: activeLabels.length > 0,
    message: activeLabels.length ? `Finish ${activeLabels.join(', ')} before installing the update.` : undefined,
  };
});
app.get('/api/settings/geolocation', async () => geolocation.getAllInfo());
app.post('/api/settings/geolocation', async (req, reply) => {
  if (executionBusy()) return reply.code(409).send({ error: 'Wait for the active check or report migration to finish before changing geolocation data.' });
  const body = req.body as { kind?: unknown; path?: unknown };
  if (body?.kind !== 'city' && body?.kind !== 'asn')
    return reply.code(400).send({ error: 'Choose a City or ASN database.' });
  const kind = body.kind;
  const candidate = typeof body.path === 'string' ? body.path.trim() : '';
  const previous = geolocation.getInfo(kind).path;
  try {
    const info = await geolocation.configure(kind, candidate || undefined);
    if (settingsFile) {
      try {
        await persistGeolocationPreference(settingsFile, kind, candidate || undefined);
      } catch (error) {
        geolocation.setPath(kind, previous);
        throw error;
      }
    }
    return { ...info, databases: geolocation.getAllInfo() };
  } catch (error) {
    return reply.code(400).send({ error: `Geolocation database was not changed. ${(error as Error).message}` });
  }
});
app.get('/api/history', async (req, reply) => {
  const raw = req.query as Record<string, unknown>;
  const page = Number(raw.page ?? 1);
  const pageSize = Number(raw.pageSize ?? 20);
  const kind = raw.kind === 'run' || raw.kind === 'network' ? raw.kind : undefined;
  const status = typeof raw.status === 'string' ? raw.status : undefined;
  const query = typeof raw.q === 'string' ? raw.q.trim() : '';
  const from = typeof raw.from === 'string' ? raw.from : undefined;
  const to = typeof raw.to === 'string' ? raw.to : undefined;
  const sort = raw.sort === 'oldest' ? 'oldest' : raw.sort === undefined || raw.sort === 'newest' ? 'newest' : undefined;
  const validDate = (value?: string) => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)));
  if (!Number.isInteger(page) || page < 1 || page > 10000000 || ![10, 20, 50].includes(pageSize))
    return reply.code(400).send({ error: 'Choose a valid page and a page size of 10, 20 or 50.' });
  if (raw.kind !== undefined && !kind)
    return reply.code(400).send({ error: 'Choose resilience or network reports.' });
  if (status && !['running', 'pass', 'fail', 'observed', 'error', 'cancelled', 'not-tested', 'fault-not-triggered', 'complete'].includes(status))
    return reply.code(400).send({ error: 'Choose a valid report status.' });
  if (query.length > 200 || !validDate(from) || !validDate(to) || !sort || (from && to && from > to))
    return reply.code(400).send({ error: 'Check the search, date range and sort settings.' });
  const filters: HistoryQuery = { page, pageSize: pageSize as 10 | 20 | 50, query, kind, status, from, to, sort };
  return historyIndex.getPage(filters);
});
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
  if (samePath) return { reportDirectory: data, copied: 0, total: 0, originalsKept: true };
  activeReservation = 'storage';
  const job: StorageMigrationJob = {
    id: randomUUID(),
    status: 'running',
    startedAt: new Date().toISOString(),
    copied: 0,
    processed: 0,
    total: 0,
  };
  storageMigration = job;
  const controller = new AbortController();
  storageMigrationController = controller;
  const previous = data;
  storageMigrationTask = (async () => {
    try {
      await assertWritableDirectory(destination);
      const migrated = await copyReportFiles(previous, destination, (progress) => {
        Object.assign(job, progress);
      }, controller.signal);
      if (controller.signal.aborted) throw new Error('Report folder migration was interrupted. The current folder and original reports remain selected.');

      // Persist settings first. If SQLite metadata cannot be moved, restore the previous preference.
      if (settingsFile) await persistReportDirectoryPreference(settingsFile, destination);
      try {
        historyIndex.moveDirectory(previous, destination);
      } catch (error) {
        if (settingsFile) await persistReportDirectoryPreference(settingsFile, previous).catch(() => {});
        throw error;
      }
      data = destination;
      void queryHistoryAtStartup(destination);
      job.status = 'complete';
      job.finishedAt = new Date().toISOString();
      job.result = { reportDirectory: destination, ...migrated, originalsKept: true };
    } catch (error) {
      job.status = controller.signal.aborted ? 'cancelled' : 'error';
      job.finishedAt = new Date().toISOString();
      job.error = controller.signal.aborted
        ? 'Report folder migration was cancelled. The current folder and original reports remain selected.'
        : `Could not change report storage. The current folder and its reports were kept. ${(error as Error).message}`;
    } finally {
      activeReservation = undefined;
      storageMigrationController = undefined;
      storageMigrationTask = undefined;
    }
  })();
  return reply.code(202).send({ id: job.id, status: job.status });
});
app.get<{ Params: { id: string } }>('/api/settings/report-directory/:id', async (req, reply) => {
  if (!isValidReportId(req.params.id) || storageMigration?.id !== req.params.id)
    return reply.code(404).send({ error: 'Report folder migration was not found.' });
  return storageMigration;
});
app.post<{ Params: { id: string } }>('/api/settings/report-directory/:id/cancel', async (req, reply) => {
  if (!isValidReportId(req.params.id) || storageMigration?.id !== req.params.id)
    return reply.code(404).send({ error: 'Report folder migration was not found.' });
  if (storageMigration.status !== 'running') return reply.code(409).send({ error: 'Report folder migration is no longer running.' });
  storageMigrationController?.abort();
  return { ok: true };
});
app.get('/api/runs', async () => historyIndex.getPage({ kind: 'run', page: 1, pageSize: 20 }).items);
app.get<{ Params: { id: string } }>(
  '/api/runs/:id',
  async (req, reply) => {
    const run = runs.get(req.params.id) || await readStoredReport('run', req.params.id);
    return run || reply.code(404).send({ error: 'Run not found.' });
  },
);
app.get('/api/network/reports', async () => historyIndex.getPage({ kind: 'network', page: 1, pageSize: 20 }).items);
app.get<{ Params: { id: string } }>('/api/network/reports/:id', async (req, reply) => {
  const report = networkReports.get(req.params.id) || await readStoredReport('network', req.params.id);
  return report || reply.code(404).send({ error: 'Network report not found.' });
});
app.get<{ Params: { id: string; format: string } }>(
  '/api/network/reports/:id/:format',
  async (req, reply) => {
    const report = networkReports.get(req.params.id) as NetworkReport | undefined ||
      await readStoredReport('network', req.params.id) as NetworkReport | undefined;
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
  historyIndex.upsertNetwork(report, data);
  activeReservation = 'network';
  try {
    await persistNetwork(report);
  } catch {
    networkReports.delete(id);
    historyIndex.deleteRecord('network', id);
    activeReservation = undefined;
    return reply.code(500).send({ error: 'The inspection could not be started because the report folder is not writable.' });
  }
  activeNetwork = controller;
  activeNetworkTask = inspectNetworkTarget(parsed.data, id, controller.signal, (progress) => {
    report.progress = progress;
  })
    .then(async (completed) => {
      const addresses = [...new Set([...completed.dns.A, ...completed.dns.AAAA])].slice(0, 16);
      if (addresses.length && (geolocation.getInfo('city').configured || geolocation.getInfo('asn').configured))
        completed.geolocation = await Promise.all(addresses.map((address) => geolocation.lookup(address)));
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
      networkReports.delete(id);
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
    const report = historyIndex.getReportFile(kind, id);
    if (!report) return reply.code(404).send({ error: 'A selected report is no longer available.' });
    if (report.status === 'running') return reply.code(409).send({ error: 'Running checks cannot be deleted.' });
  }
  let deleted = 0;
  const failed: Array<{ id: string; kind: string; error: string }> = [];
  for (const item of unique) {
    const kind = item.kind as 'run' | 'network';
    const id = item.id as string;
    try {
      if (await deleteIndexedReport(kind, id)) deleted += 1;
    } catch (error) {
      failed.push({ id, kind, error: (error as Error).message });
    }
  }
  return failed.length ? reply.code(207).send({ deleted, failed }) : { deleted, failed: [] };
});
app.post('/api/history/delete-all', async (_req, reply) => {
  if (historyIndex.getIndexingProgress().status !== 'complete')
    return reply.code(409).send({ error: 'Wait for report indexing to finish before clearing all history.' });
  const job = historyIndex.createDeleteJob(randomUUID());
  void processDeleteJobs();
  return { id: job.id, status: job.status, total: job.total };
});
app.get<{ Params: { id: string } }>('/api/history/delete-all/:id', async (req, reply) => {
  if (!isValidReportId(req.params.id)) return reply.code(400).send({ error: 'Invalid deletion job identifier.' });
  const job = historyIndex.getDeleteJob(req.params.id);
  if (!job) return reply.code(404).send({ error: 'Deletion job not found.' });
  return { ...job, failures: historyIndex.deleteJobFailures(req.params.id) };
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
app.post('/api/api-tests', async (req, reply) => {
  try {
    return await startApiTest(req.body);
  } catch (error) {
    return reply.code((error as { statusCode?: number }).statusCode || 400).send({ error: (error as Error).message });
  }
});
app.post('/api/api-tests/cancel', async () => {
  activeApiTest?.abort();
  return { ok: true };
});
app.post('/api/cancel', async () => {
  active?.abort();
  activeApiTest?.abort();
  return { ok: true };
});
app.post('/api/demo', async (_req, reply) => {
  if (executionBusy()) return reply.code(409).send({ error: 'Another check is active.' });
  const firstScenario = demoScenario(origin, 'broken');
  const first = await start(firstScenario);
  return { id: first.id, first: firstScenario, next: demoScenario(origin, 'fixed') };
});
app.get<{ Params: { id: string; format: string } }>(
  '/api/reports/:id/:format',
  async (req, reply) => {
    const live = runs.get(req.params.id);
    const stored = live ? safeRunDownload(live) : await readStoredReport('run', req.params.id) as Run | undefined;
    const run = stored;
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
  storageMigrationController?.abort();
  indexingController.abort();
  deleteWorkerController.abort();
  await Promise.all([activeTask, activeNetworkTask, activeApiTask, storageMigrationTask, indexingTask, deleteWorkerTask]);
  historyIndex.close();
});
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
try {
  await recoverStagedDeletions();
} catch {
  deletionRecoveryError = 'A report deletion could not be recovered safely. Existing report files were preserved.';
  console.error(deletionRecoveryError);
}
origin = await app.listen({ host: '127.0.0.1', port });
console.log(`LinkSunder ready: ${origin}`);
void queryHistoryAtStartup(data);
if (!deletionRecoveryError && historyIndex.incompleteDeleteJobs().length) void processDeleteJobs();
