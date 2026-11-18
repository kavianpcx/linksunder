import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { browserOptions } from '../server/browser.js';
import { HistoryIndex } from '../server/history-index.js';
import { processDeleteBatch } from '../server/history-deletion.js';

const counts = (process.env.LINKSUNDER_BENCHMARK_COUNTS || '100,10000,100000')
  .split(',').map(Number).filter((count) => Number.isSafeInteger(count) && count > 0);

function idFor(index: number) {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 0;
}

async function measureQueries(index: HistoryIndex, callback: () => unknown) {
  const timings: number[] = [];
  for (let repetition = 0; repetition < 25; repetition += 1) {
    const started = performance.now();
    callback();
    timings.push(performance.now() - started);
  }
  return { p50Ms: Number(percentile(timings, 0.5).toFixed(3)), p95Ms: Number(percentile(timings, 0.95).toFixed(3)) };
}

async function createFixtures(directory: string, count: number) {
  await mkdir(directory, { recursive: true });
  const batchSize = 200;
  const baseTime = Date.UTC(2025, 0, 1);
  for (let start = 1; start <= count; start += batchSize) {
    const end = Math.min(count + 1, start + batchSize);
    await Promise.all(Array.from({ length: end - start }, async (_, offset) => {
      const value = start + offset;
      const id = idFor(value);
      const report = {
        id,
        name: `History benchmark scenario ${value.toString().padStart(6, '0')}`,
        targetHost: value % 2 ? 'edge.example.test' : 'api.example.test',
        type: 'offline',
        status: value % 7 ? 'pass' : 'fail',
        started: new Date(baseTime + value * 1_000).toISOString(),
        duration: 120 + value % 5_000,
        steps: [],
        assertions: 2,
        passed: value % 7 ? 2 : 1,
        screenshots: [],
        network: { failed: 0, injected: 1 },
      };
      await writeFile(path.join(directory, `${id}.json`), JSON.stringify(report));
    }));
  }
}

async function deleteAll(index: HistoryIndex) {
  const job = index.createDeleteJob(`benchmark-${Date.now()}`);
  while (index.incompleteDeleteJobs().includes(job.id)) {
    const batch = index.pendingDeleteItems(job.id, 25);
    if (!batch.length) break;
    await processDeleteBatch(index, job.id, batch);
    await setImmediate();
  }
  return index.getDeleteJob(job.id);
}

async function benchmarkHistoryUi(reports: string, database: string) {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local UI benchmark port.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));

  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), LINKSUNDER_DATA: reports, LINKSUNDER_HISTORY_DB: database, LINKSUNDER_SETTINGS_FILE: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const origin = `http://127.0.0.1:${port}`;
  const readyStart = performance.now();
  let ready = false;
  while (performance.now() - readyStart < 30_000) {
    if (child.exitCode !== null) throw new Error(`History UI benchmark server exited: ${stderr}`);
    try {
      const response = await fetch(`${origin}/api/info`);
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for the local development server to listen. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) {
    child.kill();
    throw new Error(`History UI benchmark server did not start: ${stderr}`);
  }

  try {
    const browser = await chromium.launch({ ...browserOptions(), headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      const indexingStart = performance.now();
      while (performance.now() - indexingStart < 120_000) {
        const infoResponse = await page.request.get(`${origin}/api/info`);
        const info = await infoResponse.json() as { indexing?: { status?: string } };
        if (info.indexing?.status === 'complete') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const info = await (await page.request.get(`${origin}/api/info`)).json() as { indexing?: { status?: string } };
      if (info.indexing?.status !== 'complete') throw new Error('History UI benchmark indexing timed out.');

      const historyLink = page.getByRole('navigation').getByRole('button', { name: 'Reports & history' });
      const pageStart = performance.now();
      await historyLink.click();
      await page.locator('.history-table tbody tr').nth(19).waitFor();
      const pageLoadMs = Number((performance.now() - pageStart).toFixed(2));
      const visibleRows = await page.locator('.history-table tbody tr').count();
      const firstTitle = (await page.locator('.history-open').first().textContent())?.trim() || '';

      const search = page.getByRole('textbox', { name: 'Search report history' });
      const searchStart = performance.now();
      await search.fill('edge.example.test');
      await page.waitForFunction(() => document.querySelector('.history-actions > span')?.textContent?.trim() === '50,000 reports');
      const searchMs = Number((performance.now() - searchStart).toFixed(2));
      const nextPageStart = performance.now();
      const previousTitle = (await page.locator('.history-open').first().textContent())?.trim();
      await page.getByRole('button', { name: 'Page 2', exact: true }).click();
      await page.waitForFunction((prior) => document.querySelector('.history-open')?.textContent?.trim() !== prior, previousTitle);
      const nextPageMs = Number((performance.now() - nextPageStart).toFixed(2));
      return { pageLoadMs, searchMs, nextPageMs, visibleRows, firstTitle, filteredTotal: 50_000 };
    } finally {
      await browser.close();
    }
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), 'linksunder-history-benchmark-'));
const results: Array<Record<string, unknown>> = [];
try {
  for (const count of counts) {
    const reports = path.join(root, `reports-${count}`);
    const database = path.join(root, `history-${count}.sqlite`);
    const fixtureStart = performance.now();
    await createFixtures(reports, count);
    const fixtureMs = performance.now() - fixtureStart;

    const memoryBeforeIndex = process.memoryUsage().rss;
    const index = new HistoryIndex(database);
    const indexStart = performance.now();
    await index.reconcileDirectory(reports);
    const indexingMs = performance.now() - indexStart;
    const indexedMemory = process.memoryUsage().rss;

    const pageQuery = await measureQueries(index, () => index.getPage({ page: Math.ceil(count / 2 / 20), pageSize: 20 }));
    const searchQuery = await measureQueries(index, () => index.getPage({ page: 1, pageSize: 20, query: `benchmark scenario ${String(count).padStart(6, '0')}` }));
    const searchMatches = index.getPage({ page: 1, pageSize: 20, query: `benchmark scenario ${String(count).padStart(6, '0')}` }).total;
    const firstPageStart = performance.now();
    const firstPage = index.getPage({ page: 1, pageSize: 20 });
    const initialPageMs = performance.now() - firstPageStart;
    const startupStart = performance.now();
    index.close();
    const reopened = new HistoryIndex(database);
    try {
    const reopenIndexMs = performance.now() - startupStart;

    const ui = count >= 100_000 ? await benchmarkHistoryUi(reports, database) : undefined;

    const deleteStart = performance.now();
    const deletion = await deleteAll(reopened);
    const deletionMs = performance.now() - deleteStart;
    const remainingFiles = (await readdir(reports)).filter((name) => name.endsWith('.json')).length;
    const result = {
      reports: count,
      fixtureGenerationMs: Math.round(fixtureMs),
      indexingMs: Math.round(indexingMs),
      indexReopenMs: Number(reopenIndexMs.toFixed(3)),
      firstPageMs: Number(initialPageMs.toFixed(3)),
      firstPageRows: firstPage.items.length,
      pageQuery,
      searchQuery,
      searchMatches,
      ui,
      rssBeforeIndexMiB: Number((memoryBeforeIndex / 1_048_576).toFixed(1)),
      rssAfterIndexMiB: Number((indexedMemory / 1_048_576).toFixed(1)),
      rssIncreaseMiB: Number(((indexedMemory - memoryBeforeIndex) / 1_048_576).toFixed(1)),
      sqliteBytesBeforeDelete: (await stat(database)).size,
      deletionMs: Math.round(deletionMs),
      deleted: deletion?.deleted,
      deletionFailures: deletion?.failed,
      remainingJsonFiles: remainingFiles,
    };
    results.push(result);
    console.log(JSON.stringify({ completed: result }, null, 2));
    } finally {
      reopened.close();
    }
  }
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, cpu: os.cpus()[0]?.model, memoryGiB: Number((os.totalmem() / 1_073_741_824).toFixed(1)), results }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
