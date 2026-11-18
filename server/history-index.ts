import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { NetworkReport } from '../shared/network.js';
import type { HistoryKind, HistoryPageData, HistoryQuery, HistoryRecord, HistorySummary, IndexingProgress } from '../shared/history.js';
import type { Run } from '../shared/schema.js';
import { storedReportFilenames, type StoredReportKind } from './storage.js';

interface ReportFileRecord {
  kind: HistoryKind;
  id: string;
  directory: string;
  jsonName: string;
  htmlName: string;
  status: string;
}

interface DbRecord extends Record<string, unknown> {
  kind: string;
  id: string;
  title: string;
  target: string;
  started: string;
  status: string;
  duration: number;
  assertions: number;
  passed: number;
}

interface PendingIndexFile {
  name: string;
  size: number;
  mtime: number;
  damaged: boolean;
  record?: HistoryRecord;
}

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const RUN_FILE = new RegExp(`^(${UUID})\\.json$`, 'i');
const NETWORK_FILE = new RegExp(`^network-(${UUID})\\.json$`, 'i');
const RUN_STATUSES = new Set(['running', 'pass', 'fail', 'observed', 'error', 'cancelled', 'not-tested', 'fault-not-triggered']);
const NETWORK_STATUSES = new Set(['running', 'complete', 'cancelled', 'error']);
const INDEX_SCHEMA = `
  CREATE TABLE IF NOT EXISTS reports (
    kind TEXT NOT NULL CHECK(kind IN ('run', 'network')),
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    started TEXT NOT NULL,
    status TEXT NOT NULL,
    duration INTEGER NOT NULL DEFAULT 0,
    assertions INTEGER NOT NULL DEFAULT 0,
    passed INTEGER NOT NULL DEFAULT 0,
    file_directory TEXT NOT NULL,
    json_name TEXT NOT NULL,
    html_name TEXT NOT NULL,
    PRIMARY KEY (kind, id)
  );
  CREATE INDEX IF NOT EXISTS reports_started_idx ON reports(started DESC, kind, id);
  CREATE INDEX IF NOT EXISTS reports_filter_idx ON reports(kind, status, started DESC, id);
  CREATE TABLE IF NOT EXISTS indexed_files (
    directory TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    damaged INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (directory, name)
  );
  CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS delete_jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    total INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS delete_job_items (
    job_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    report_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    PRIMARY KEY (job_id, kind, report_id),
    FOREIGN KEY (job_id) REFERENCES delete_jobs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS delete_job_pending_idx ON delete_job_items(job_id, state, report_id);
  CREATE TABLE IF NOT EXISTS delete_journal (
    kind TEXT NOT NULL,
    report_id TEXT NOT NULL,
    directory TEXT NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY(kind, report_id)
  );
`;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: DbRecord): HistoryRecord | undefined {
  if (value.kind !== 'run' && value.kind !== 'network') return undefined;
  return {
    kind: value.kind,
    id: value.id,
    title: value.title,
    target: value.target,
    started: value.started,
    status: value.status,
    duration: Number(value.duration) || 0,
    assertions: Number(value.assertions) || 0,
    passed: Number(value.passed) || 0,
  };
}

function searchTokens(query: string) {
  return (query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) || [])
    .map((token) => `${token}*`)
    .join(' AND ');
}

export class HistoryIndex {
  private readonly db: DatabaseSync;
  private fullTextSearch = false;
  private progress: IndexingProgress = { status: 'idle', scanned: 0, total: 0, damaged: 0 };

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.db.exec(INDEX_SCHEMA);
    try {
      const version = this.db.prepare('SELECT value FROM index_meta WHERE key=?').get('fts_rowid_version') as { value?: string } | undefined;
      if (version?.value !== 'rowid-v1') {
        this.db.exec('BEGIN IMMEDIATE');
        this.db.exec('DROP TABLE IF EXISTS reports_fts;');
        this.db.exec("CREATE VIRTUAL TABLE reports_fts USING fts5(kind UNINDEXED, id UNINDEXED, title, target, tokenize='unicode61 remove_diacritics 2');");
        this.db.exec('INSERT INTO reports_fts(rowid,kind,id,title,target) SELECT rowid,kind,id,title,target FROM reports;');
        this.db.prepare('INSERT INTO index_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run('fts_rowid_version', 'rowid-v1');
        this.db.exec('COMMIT');
      } else {
        this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS reports_fts USING fts5(kind UNINDEXED, id UNINDEXED, title, target, tokenize='unicode61 remove_diacritics 2');");
      }
      this.fullTextSearch = true;
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* There may not be an active transaction. */ }
      this.fullTextSearch = false;
    }
    this.readProgress();
  }

  close() {
    this.db.close();
  }

  private readProgress() {
    const stored = this.db.prepare('SELECT value FROM index_meta WHERE key = ?').get('indexing') as { value?: string } | undefined;
    if (!stored?.value) return;
    try {
      const parsed: unknown = JSON.parse(stored.value);
      if (isObject(parsed) && ['idle', 'indexing', 'complete'].includes(String(parsed.status)))
        this.progress = parsed as unknown as IndexingProgress;
    } catch {
      this.progress = { status: 'idle', scanned: 0, total: 0, damaged: 0 };
    }
  }

  private writeProgress(progress: IndexingProgress) {
    this.progress = progress;
    this.db.prepare('INSERT INTO index_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('indexing', JSON.stringify(progress));
  }

  private persistBatch(directory: string, batch: Array<{ record?: HistoryRecord; file?: PendingIndexFile }>) {
    if (!batch.length) return;
    const reportExists = this.db.prepare('SELECT rowid FROM reports WHERE kind=? AND id=?');
    const reportRow = this.db.prepare('SELECT rowid FROM reports WHERE kind=? AND id=?');
    const reportUpsert = this.db.prepare(`
      INSERT INTO reports(kind,id,title,target,started,status,duration,assertions,passed,file_directory,json_name,html_name)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET
        title=excluded.title,target=excluded.target,started=excluded.started,status=excluded.status,
        duration=excluded.duration,assertions=excluded.assertions,passed=excluded.passed,
        file_directory=excluded.file_directory,json_name=excluded.json_name,html_name=excluded.html_name
    `);
    const indexFile = this.db.prepare(`INSERT INTO indexed_files(directory,name,size,mtime,damaged) VALUES(?,?,?,?,?)
      ON CONFLICT(directory,name) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,damaged=excluded.damaged`);
    const ftsDelete = this.fullTextSearch ? this.db.prepare('DELETE FROM reports_fts WHERE rowid = ?') : undefined;
    const ftsInsert = this.fullTextSearch ? this.db.prepare('INSERT INTO reports_fts(rowid,kind,id,title,target) VALUES(?,?,?,?,?)') : undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of batch) {
        const input = entry.record;
        if (input) {
          const [jsonName, htmlName] = storedReportFilenames(input.kind, input.id);
          const existed = reportExists.get(input.kind, input.id);
          reportUpsert.run(input.kind, input.id, input.title, input.target, input.started, input.status,
            input.duration, input.assertions, input.passed, path.resolve(directory), jsonName, htmlName);
          if (ftsDelete && ftsInsert) {
            const row = existed || reportRow.get(input.kind, input.id) as { rowid: number } | undefined;
            if (existed) ftsDelete.run(existed.rowid);
            if (row) ftsInsert.run(row.rowid, input.kind, input.id, input.title, input.target);
          }
        }
        const file = entry.file;
        if (file) indexFile.run(path.resolve(directory), file.name, file.size, file.mtime, file.damaged ? 1 : 0);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private upsert(input: HistoryRecord, directory: string) {
    this.persistBatch(directory, [{ record: input }]);
  }

  upsertRun(run: Run, directory: string) {
    this.upsert({
      kind: 'run',
      id: run.id,
      title: run.name,
      target: run.targetHost || '',
      started: run.started,
      status: run.status,
      duration: run.duration,
      assertions: run.assertions,
      passed: run.passed,
    }, directory);
  }

  upsertNetwork(report: NetworkReport, directory: string) {
    this.upsert({
      kind: 'network',
      id: report.id,
      title: report.hostname,
      target: report.hostname,
      started: report.started,
      status: report.status,
      duration: report.completed ? Math.max(0, Date.parse(report.completed) - Date.parse(report.started)) : 0,
      assertions: 0,
      passed: 0,
    }, directory);
  }

  private where(query: HistoryQuery) {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.kind) {
      clauses.push('r.kind = ?');
      values.push(query.kind);
    }
    if (query.status) {
      clauses.push('r.status = ?');
      values.push(query.status);
    }
    if (query.from) {
      clauses.push('r.started >= ?');
      values.push(`${query.from}T00:00:00.000Z`);
    }
    if (query.to) {
      clauses.push('r.started < ?');
      const dayAfter = new Date(`${query.to}T00:00:00.000Z`);
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
      values.push(dayAfter.toISOString());
    }
    const search = searchTokens(query.query || '');
    if (search) {
      if (this.fullTextSearch) {
        clauses.push('(r.kind, r.id) IN (SELECT kind, id FROM reports_fts WHERE reports_fts MATCH ?)');
        values.push(search);
      } else {
        clauses.push('(r.title LIKE ? OR r.target LIKE ?)');
        values.push(`%${query.query}%`, `%${query.query}%`);
      }
    } else if (query.query?.trim()) {
      clauses.push('0 = 1');
    }
    return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values };
  }

  getPage(query: HistoryQuery = {}): HistoryPageData {
    const pageSize = [10, 20, 50].includes(query.pageSize || 20) ? query.pageSize || 20 : 20;
    const clauses = this.where(query);
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS total FROM reports r${clauses.sql}`).get(...clauses.values) as { total: number };
    const total = Number(totalRow.total) || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(totalPages, Math.max(1, Math.floor(query.page || 1)));
    const direction = query.sort === 'oldest' ? 'ASC' : 'DESC';
    const rows = this.db.prepare(`
      SELECT r.kind,r.id,r.title,r.target,r.started,r.status,r.duration,r.assertions,r.passed
      FROM reports r${clauses.sql}
      ORDER BY r.started ${direction},r.id ${direction},r.kind ASC
      LIMIT ? OFFSET ?
    `).all(...clauses.values, pageSize, (page - 1) * pageSize) as unknown as DbRecord[];
    return { items: rows.map(record).filter((item): item is HistoryRecord => Boolean(item)), page, pageSize, total, totalPages };
  }

  getSummary(): HistorySummary {
    const counts = this.db.prepare(`
      SELECT kind,COUNT(*) AS total,SUM(CASE WHEN status='pass' THEN 1 ELSE 0 END) AS passed
      FROM reports GROUP BY kind
    `).all() as Array<{ kind: string; total: number; passed: number }>;
    const resilienceCount = Number(counts.find((item) => item.kind === 'run')?.total) || 0;
    const networkCount = Number(counts.find((item) => item.kind === 'network')?.total) || 0;
    const passedCount = Number(counts.find((item) => item.kind === 'run')?.passed) || 0;
    const activeCount = Number((this.db.prepare("SELECT COUNT(*) AS total FROM reports WHERE status='running'").get() as { total: number }).total) || 0;
    const latest = this.db.prepare('SELECT started,status FROM reports ORDER BY started DESC,id DESC LIMIT 1').get() as { started?: string; status?: string } | undefined;
    const recentRuns = this.db.prepare(`
      SELECT kind,id,title,target,started,status,duration,assertions,passed
      FROM reports WHERE kind='run' ORDER BY started DESC,id DESC LIMIT 8
    `).all() as unknown as DbRecord[];
    const damaged = Number((this.db.prepare('SELECT COUNT(*) AS total FROM indexed_files WHERE damaged=1').get() as { total: number }).total) || 0;
    return {
      resilienceCount,
      networkCount,
      passedCount,
      activeCount,
      lastCheck: latest?.started && latest.status ? { started: latest.started, status: latest.status } : undefined,
      recentRuns: recentRuns.map(record).filter((item): item is HistoryRecord => Boolean(item)),
      damagedReports: damaged,
      indexing: { ...this.progress },
    };
  }

  getReportFile(kind: StoredReportKind, id: string): ReportFileRecord | undefined {
    return this.db.prepare('SELECT kind,id,file_directory AS directory,json_name AS jsonName,html_name AS htmlName,status FROM reports WHERE kind=? AND id=?')
      .get(kind, id) as ReportFileRecord | undefined;
  }

  listRunningReports() {
    return this.db.prepare("SELECT kind,id,file_directory AS directory,json_name AS jsonName,html_name AS htmlName,status FROM reports WHERE status='running'")
      .all() as unknown as ReportFileRecord[];
  }

  async removeMissingReports(directory: string, names: Set<string>, signal?: AbortSignal) {
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS scan_names(name TEXT PRIMARY KEY); DELETE FROM scan_names;');
    const insert = this.db.prepare('INSERT INTO scan_names(name) VALUES(?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let inserted = 0;
      for (const name of names) {
        if (signal?.aborted) {
          this.db.exec('ROLLBACK');
          return;
        }
        insert.run(name);
        inserted += 1;
        if (inserted % 500 === 0) await setImmediate();
      }
      this.db.prepare('DELETE FROM reports WHERE file_directory=? AND json_name NOT IN (SELECT name FROM scan_names)')
        .run(path.resolve(directory));
      this.db.prepare('DELETE FROM indexed_files WHERE directory=? AND name NOT IN (SELECT name FROM scan_names)')
        .run(path.resolve(directory));
      if (this.fullTextSearch) this.db.exec('DELETE FROM reports_fts WHERE (kind,id) NOT IN (SELECT kind,id FROM reports);');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteRecord(kind: StoredReportKind, id: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const report = this.db.prepare('SELECT rowid FROM reports WHERE kind=? AND id=?').get(kind, id) as { rowid: number } | undefined;
      this.db.prepare('DELETE FROM reports WHERE kind=? AND id=?').run(kind, id);
      if (this.fullTextSearch && report) this.db.prepare('DELETE FROM reports_fts WHERE rowid=?').run(report.rowid);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  commitDeletion(kind: StoredReportKind, id: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const report = this.db.prepare('SELECT rowid FROM reports WHERE kind=? AND id=?').get(kind, id) as { rowid: number } | undefined;
      this.db.prepare('DELETE FROM reports WHERE kind=? AND id=?').run(kind, id);
      if (this.fullTextSearch && report) this.db.prepare('DELETE FROM reports_fts WHERE rowid=?').run(report.rowid);
      this.db.prepare("UPDATE delete_journal SET state='committed' WHERE kind=? AND report_id=?").run(kind, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listDeleteJournal() {
    return this.db.prepare('SELECT kind,report_id AS id,directory,state FROM delete_journal').all() as Array<{ kind: StoredReportKind; id: string; directory: string; state: 'staging' | 'committed' }>;
  }

  setDeleteJournal(kind: StoredReportKind, id: string, directory: string, state: 'staging' | 'committed') {
    this.db.prepare(`INSERT INTO delete_journal(kind,report_id,directory,state) VALUES(?,?,?,?)
      ON CONFLICT(kind,report_id) DO UPDATE SET directory=excluded.directory,state=excluded.state`)
      .run(kind, id, path.resolve(directory), state);
  }

  setDeleteJournals(items: Array<{ kind: StoredReportKind; id: string; directory: string }>) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare(`INSERT INTO delete_journal(kind,report_id,directory,state) VALUES(?,?,?,'staging')
        ON CONFLICT(kind,report_id) DO UPDATE SET directory=excluded.directory,state='staging'`);
      for (const item of items) insert.run(item.kind, item.id, path.resolve(item.directory));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  commitDeletions(items: Array<{ kind: StoredReportKind; id: string }>) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const remove = this.db.prepare('DELETE FROM reports WHERE kind=? AND id=?');
      const getRow = this.db.prepare('SELECT rowid FROM reports WHERE kind=? AND id=?');
      const removeFromSearch = this.fullTextSearch ? this.db.prepare('DELETE FROM reports_fts WHERE rowid=?') : undefined;
      const markCommitted = this.db.prepare("UPDATE delete_journal SET state='committed' WHERE kind=? AND report_id=?");
      for (const item of items) {
        const report = getRow.get(item.kind, item.id) as { rowid: number } | undefined;
        if (report) removeFromSearch?.run(report.rowid);
        remove.run(item.kind, item.id);
        markCommitted.run(item.kind, item.id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  clearDeleteJournal(kind: StoredReportKind, id: string) {
    this.db.prepare('DELETE FROM delete_journal WHERE kind=? AND report_id=?').run(kind, id);
  }

  clearDeleteJournals(items: Array<{ kind: StoredReportKind; id: string }>) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const clear = this.db.prepare('DELETE FROM delete_journal WHERE kind=? AND report_id=?');
      for (const item of items) clear.run(item.kind, item.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  moveDirectory(source: string, destination: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE reports SET file_directory=? WHERE file_directory=?')
        .run(path.resolve(destination), path.resolve(source));
      this.db.prepare('UPDATE indexed_files SET directory=? WHERE directory=?')
        .run(path.resolve(destination), path.resolve(source));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getIndexingProgress() {
    return { ...this.progress };
  }

  beginIndexing(directory: string) {
    this.writeProgress({ status: 'indexing', directory: path.resolve(directory), scanned: 0, total: 0, damaged: 0, startedAt: new Date().toISOString() });
  }

  async reconcileDirectory(directory: string, signal?: AbortSignal) {
    const resolvedDirectory = path.resolve(directory);
    const names = await readdir(resolvedDirectory);
    const files = names.filter((name) => RUN_FILE.test(name) || NETWORK_FILE.test(name)).sort();
    await this.removeMissingReports(resolvedDirectory, new Set(files), signal);
    const startedAt = new Date().toISOString();
    const damagedStart = Number((this.db.prepare('SELECT COUNT(*) AS total FROM indexed_files WHERE damaged=1').get() as { total: number }).total) || 0;
    this.writeProgress({ status: 'indexing', directory: resolvedDirectory, scanned: 0, total: files.length, damaged: damagedStart, startedAt });
    let scanned = 0;
    let damaged = 0;
    const batch: Array<{ record?: HistoryRecord; file?: PendingIndexFile }> = [];
    const flushBatch = () => {
      this.persistBatch(resolvedDirectory, batch);
      batch.length = 0;
    };
    for (const name of files) {
      if (signal?.aborted) {
        flushBatch();
        this.writeProgress({ status: 'idle', directory: resolvedDirectory, scanned, total: files.length, damaged, startedAt });
        return;
      }
      const filePath = path.join(resolvedDirectory, name);
      try {
        const info = await stat(filePath);
        const known = this.db.prepare('SELECT size,mtime,damaged FROM indexed_files WHERE directory=? AND name=?').get(resolvedDirectory, name) as { size: number; mtime: number; damaged: number } | undefined;
        if (known && known.size === info.size && known.mtime === Math.trunc(info.mtimeMs)) {
          if (known.damaged) damaged += 1;
        } else {
          const raw: unknown = JSON.parse(await readFile(filePath, 'utf8'));
          if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.started !== 'string' || typeof raw.status !== 'string')
            throw new Error('Report metadata is incomplete.');
          const runMatch = RUN_FILE.exec(name);
          const networkMatch = NETWORK_FILE.exec(name);
          if (runMatch && raw.id === runMatch[1] && typeof raw.name === 'string' &&
            typeof raw.type === 'string' && typeof raw.started === 'string' &&
            typeof raw.status === 'string' && RUN_STATUSES.has(raw.status) &&
            typeof raw.duration === 'number' && Array.isArray(raw.steps) &&
            typeof raw.assertions === 'number' && typeof raw.passed === 'number' &&
            Array.isArray(raw.screenshots) && isObject(raw.network)) {
            const run = raw as unknown as Run;
            if (run.status === 'running') {
              run.status = 'error';
              run.error = 'Interrupted by server shutdown.';
            }
            batch.push({ record: {
              kind: 'run', id: run.id, title: run.name, target: run.targetHost || '', started: run.started,
              status: run.status, duration: run.duration, assertions: run.assertions, passed: run.passed,
            } });
          } else if (networkMatch && raw.id === networkMatch[1] && raw.kind === 'network' &&
            typeof raw.target === 'string' && typeof raw.hostname === 'string' &&
            typeof raw.started === 'string' && typeof raw.status === 'string' && NETWORK_STATUSES.has(raw.status) &&
            typeof raw.progress === 'string' && isObject(raw.dns) && Array.isArray(raw.ports) &&
            Array.isArray(raw.http) && Array.isArray(raw.findings) && Array.isArray(raw.limitations)) {
            const report = raw as unknown as NetworkReport;
            if (report.status === 'running') {
              report.status = 'cancelled';
              report.progress = 'Interrupted';
              report.error = 'Inspection was interrupted when LinkSunder closed. Completed observations are preserved.';
            }
            batch.push({ record: {
              kind: 'network', id: report.id, title: report.hostname, target: report.hostname, started: report.started,
              status: report.status,
              duration: report.completed ? Math.max(0, Date.parse(report.completed) - Date.parse(report.started)) : 0,
              assertions: 0, passed: 0,
            } });
          } else {
            throw new Error('Report identity or format does not match its file name.');
          }
          batch[batch.length - 1].file = { name, size: info.size, mtime: Math.trunc(info.mtimeMs), damaged: false };
        }
      } catch {
        damaged += 1;
        try {
          const info = await stat(filePath);
          batch.push({ file: { name, size: info.size, mtime: Math.trunc(info.mtimeMs), damaged: true } });
        } catch {
          /* Keep missing or unreadable reports on disk for recovery. */
        }
      }
      scanned += 1;
      if (batch.length >= 100) flushBatch();
      if (scanned % 100 === 0) {
        this.writeProgress({ status: 'indexing', directory: resolvedDirectory, scanned, total: files.length, damaged, startedAt });
        await setImmediate();
      }
    }
    flushBatch();
    this.writeProgress({ status: 'complete', directory: resolvedDirectory, scanned, total: files.length, damaged, startedAt, completedAt: new Date().toISOString() });
  }

  createDeleteJob(id: string) {
    const created = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const total = Number((this.db.prepare("SELECT COUNT(*) AS total FROM reports WHERE status <> 'running'").get() as { total: number }).total) || 0;
      this.db.prepare('INSERT INTO delete_jobs(id,status,total,deleted,failed,created,updated) VALUES(?,?,?,?,?,?,?)')
        .run(id, total ? 'running' : 'complete', total, 0, 0, created, created);
      this.db.prepare("INSERT INTO delete_job_items(job_id,kind,report_id,state) SELECT ?,kind,id,'pending' FROM reports WHERE status <> 'running'")
        .run(id);
      this.db.exec('COMMIT');
      return this.getDeleteJob(id)!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getDeleteJob(id: string) {
    return this.db.prepare('SELECT id,status,total,deleted,failed,created,updated FROM delete_jobs WHERE id=?').get(id) as {
      id: string; status: 'running' | 'complete'; total: number; deleted: number; failed: number; created: string; updated: string;
    } | undefined;
  }

  incompleteDeleteJobs() {
    return (this.db.prepare("SELECT id FROM delete_jobs WHERE status='running' ORDER BY created").all() as Array<{ id: string }>).map((row) => row.id);
  }

  pendingDeleteItems(jobId: string, limit: number) {
    return this.db.prepare("SELECT kind,report_id AS id FROM delete_job_items WHERE job_id=? AND state='pending' ORDER BY report_id LIMIT ?")
      .all(jobId, limit) as Array<{ kind: StoredReportKind; id: string }>;
  }

  finishDeleteItems(jobId: string, items: Array<{ kind: StoredReportKind; id: string; error?: string }>) {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const finish = this.db.prepare("UPDATE delete_job_items SET state=?,error=? WHERE job_id=? AND kind=? AND report_id=? AND state='pending'");
      let deleted = 0;
      let failed = 0;
      for (const item of items) {
        const error = item.error;
        const result = finish.run(error ? 'failed' : 'deleted', error || null, jobId, item.kind, item.id);
        if (Number(result.changes) > 0) {
          if (error) failed += 1;
          else deleted += 1;
        }
      }
      const pending = Number((this.db.prepare("SELECT COUNT(*) AS total FROM delete_job_items WHERE job_id=? AND state='pending'").get(jobId) as { total: number }).total) || 0;
      this.db.prepare(`UPDATE delete_jobs SET deleted=deleted+?,failed=failed+?,status=?,updated=? WHERE id=?`)
        .run(deleted, failed, pending ? 'running' : 'complete', now, jobId);
      this.db.exec('COMMIT');
    } catch (failure) {
      this.db.exec('ROLLBACK');
      throw failure;
    }
  }

  finishDeleteItem(jobId: string, kind: StoredReportKind, id: string, error?: string) {
    this.finishDeleteItems(jobId, [{ kind, id, error }]);
  }

  resumeDeleteItem(jobId: string, kind: StoredReportKind, id: string) {
    this.db.prepare("UPDATE delete_job_items SET state='pending',error=NULL WHERE job_id=? AND kind=? AND report_id=? AND state='failed'")
      .run(jobId, kind, id);
    this.db.prepare("UPDATE delete_jobs SET status='running',failed=MAX(failed-1,0),updated=? WHERE id=?")
      .run(new Date().toISOString(), jobId);
  }

  deleteJobFailures(jobId: string) {
    return this.db.prepare("SELECT kind,report_id AS id,error FROM delete_job_items WHERE job_id=? AND state='failed'")
      .all(jobId) as Array<{ kind: StoredReportKind; id: string; error: string }>;
  }
}
