import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NetworkReport } from '../shared/network';
import type { Run } from '../shared/schema';
import { HistoryIndex } from '../server/history-index';

const roots: string[] = [];
async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

function reportId(index: number) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function run(index: number, started: string): Run {
  return {
    id: reportId(index),
    name: index % 2 ? `Resilience scenario ${index}` : `Recovery scenario ${index}`,
    targetHost: 'edge.example.test',
    type: 'offline',
    status: index % 3 ? 'pass' : 'fail',
    started,
    duration: index * 12,
    steps: [],
    assertions: 2,
    passed: index % 3 ? 2 : 1,
    screenshots: [],
    network: { failed: 0, injected: 1 },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('indexed report history', () => {
  it('returns stable backend pages, FTS host search, date, type and status filters', async () => {
    const root = await temporaryDirectory('linksunder-history-index-');
    const index = new HistoryIndex(path.join(root, 'history.sqlite'));
    try {
      const start = Date.UTC(2026, 0, 1);
      for (let entry = 0; entry < 27; entry += 1)
        index.upsertRun(run(entry + 1, new Date(start + entry * 60_000).toISOString()), root);
      const network: NetworkReport = {
        id: reportId(100), kind: 'network', target: 'https://db.example.test/', hostname: 'db.example.test',
        started: new Date(start + 30 * 60_000).toISOString(), completed: new Date(start + 31 * 60_000).toISOString(),
        status: 'complete', progress: 'Complete', dns: { A: [], AAAA: [], CNAME: [], NS: [], MX: [], reverse: [], lookupTimeMs: 1 },
        ports: [], http: [], findings: [], limitations: [],
      };
      index.upsertNetwork(network, root);

      const first = index.getPage({ page: 1, pageSize: 10 });
      const second = index.getPage({ page: 2, pageSize: 10 });
      expect(first).toMatchObject({ page: 1, pageSize: 10, total: 28, totalPages: 3 });
      expect(first.items).toHaveLength(10);
      expect(second.items).toHaveLength(10);
      expect(first.items[0].id).toBe(reportId(100));
      expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(20);
      expect(index.getPage({ query: 'edge.example.test' }).total).toBe(27);
      expect(index.getPage({ kind: 'network', status: 'complete' }).items[0].title).toBe('db.example.test');
      expect(index.getPage({ from: '2026-01-01', to: '2026-01-01', status: 'pass' }).total).toBeGreaterThan(0);
      expect(index.getPage({ page: 99, pageSize: 10 }).page).toBe(3);
    } finally {
      index.close();
    }
  });

  it('indexes legacy files incrementally, resumes unchanged files and preserves damaged reports', async () => {
    const root = await temporaryDirectory('linksunder-history-migration-');
    const reports = path.join(root, 'reports');
    await mkdir(reports);
    const interrupted = run(201, new Date().toISOString());
    interrupted.status = 'running';
    await writeFile(path.join(reports, `${interrupted.id}.json`), JSON.stringify(interrupted));
    const network: NetworkReport = {
      id: reportId(202), kind: 'network', target: 'https://db.example.test/', hostname: 'db.example.test',
      started: new Date().toISOString(), status: 'running', progress: 'Checking DNS',
      dns: { A: [], AAAA: [], CNAME: [], NS: [], MX: [], reverse: [], lookupTimeMs: 0 },
      ports: [], http: [], findings: [], limitations: [],
    };
    await writeFile(path.join(reports, `network-${network.id}.json`), JSON.stringify(network));
    const damagedPath = path.join(reports, `${reportId(203)}.json`);
    await writeFile(damagedPath, '{broken report');
    const index = new HistoryIndex(path.join(root, 'history.sqlite'));
    try {
      index.beginIndexing(reports);
      await index.reconcileDirectory(reports);
      expect(index.getPage({ pageSize: 10 }).total).toBe(2);
      expect(index.getPage({ kind: 'run' }).items[0].status).toBe('error');
      expect(index.getPage({ kind: 'network' }).items[0].status).toBe('cancelled');
      expect(index.getSummary()).toMatchObject({ damagedReports: 1, indexing: { status: 'complete', scanned: 3, total: 3 } });
      expect(await readFile(damagedPath, 'utf8')).toBe('{broken report');
      await index.reconcileDirectory(reports);
      expect(index.getPage({ pageSize: 10 }).total).toBe(2);
      expect(index.getSummary().indexing.status).toBe('complete');
    } finally {
      index.close();
    }
  });

  it('commits deletion progress in resumable batches without double-counting', async () => {
    const root = await temporaryDirectory('linksunder-history-delete-job-');
    const index = new HistoryIndex(path.join(root, 'history.sqlite'));
    try {
      const started = new Date(Date.UTC(2026, 0, 1)).toISOString();
      for (let value = 1; value <= 30; value += 1) index.upsertRun(run(value, started), root);
      const job = index.createDeleteJob('benchmark-delete-job');
      const first = index.pendingDeleteItems(job.id, 25);
      index.finishDeleteItems(job.id, first);
      expect(index.getDeleteJob(job.id)).toMatchObject({ status: 'running', total: 30, deleted: 25, failed: 0 });
      index.finishDeleteItems(job.id, first);
      expect(index.getDeleteJob(job.id)).toMatchObject({ deleted: 25, failed: 0 });

      const rest = index.pendingDeleteItems(job.id, 25);
      index.finishDeleteItems(job.id, rest.map((item, offset) => ({
        ...item,
        error: offset === 0 ? 'Synthetic filesystem failure.' : undefined,
      })));
      expect(index.getDeleteJob(job.id)).toMatchObject({ status: 'complete', total: 30, deleted: 29, failed: 1 });
    } finally {
      index.close();
    }
  });

  it('rebuilds legacy full-text rows with stable SQLite row IDs and keeps edits/deletions searchable', async () => {
    const root = await temporaryDirectory('linksunder-history-fts-migration-');
    const database = path.join(root, 'history.sqlite');
    const index = new HistoryIndex(database);
    for (let value = 1; value <= 3; value += 1) index.upsertRun(run(value, new Date(Date.UTC(2026, 0, 1)).toISOString()), root);
    index.close();

    const legacy = new DatabaseSync(database);
    legacy.exec('DROP TABLE reports_fts;');
    legacy.exec("CREATE VIRTUAL TABLE reports_fts USING fts5(kind UNINDEXED, id UNINDEXED, title, target, tokenize='unicode61 remove_diacritics 2');");
    legacy.exec('INSERT INTO reports_fts(kind,id,title,target) SELECT kind,id,title,target FROM reports;');
    legacy.prepare('DELETE FROM index_meta WHERE key=?').run('fts_rowid_version');
    legacy.close();

    const migrated = new HistoryIndex(database);
    try {
      expect(migrated.getPage({ query: 'edge.example.test' }).total).toBe(3);
      const updated = run(1, new Date(Date.UTC(2026, 0, 1)).toISOString());
      updated.targetHost = 'newtarget.example.test';
      updated.name = 'Renamed scenario marker';
      migrated.upsertRun(updated, root);
      expect(migrated.getPage({ query: 'newtarget' }).total).toBe(1);
      expect(migrated.getPage({ query: 'marker' }).total).toBe(1);
      expect(migrated.getPage({ query: 'edge.example.test' }).total).toBe(2);

      migrated.setDeleteJournals([{ kind: 'run', id: reportId(2), directory: root }]);
      migrated.commitDeletions([{ kind: 'run', id: reportId(2) }]);
      expect(migrated.getPage({ query: 'edge.example.test' }).total).toBe(1);
    } finally {
      migrated.close();
    }
  });
});
