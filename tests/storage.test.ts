import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  copyReportFiles,
  loadStoredReports,
  persistReportDirectoryPreference,
  readReportDirectoryPreference,
  removeReportFiles,
} from '../server/storage';

const id = '00000000-0000-4000-8000-000000000011';

describe('report storage', () => {
  it('copies reports into a writable directory and preserves the originals', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'linksunder-storage-'));
    const source = path.join(root, 'old');
    const destination = path.join(root, 'new');
    await mkdir(source);
    await writeFile(path.join(source, `${id}.json`), '{"kind":"run"}');
    await writeFile(path.join(source, `${id}.html`), '<h1>Run</h1>');
    await writeFile(path.join(source, `network-${id}.json`), '{"kind":"network"}');
    try {
      const result = await copyReportFiles(source, destination);
      expect(result).toEqual({ copied: 3, total: 3 });
      expect(await readFile(path.join(source, `${id}.json`), 'utf8')).toContain('run');
      expect(await readFile(path.join(destination, `network-${id}.json`), 'utf8')).toContain('network');
      expect(await copyReportFiles(source, destination)).toEqual({ copied: 0, total: 3 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not overwrite a conflicting report or remove originals on failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'linksunder-storage-conflict-'));
    const source = path.join(root, 'old');
    const destination = path.join(root, 'new');
    await mkdir(source);
    await mkdir(destination);
    await writeFile(path.join(source, `${id}.json`), '{"source":true}');
    await writeFile(path.join(destination, `${id}.json`), '{"destination":true}');
    try {
      await expect(copyReportFiles(source, destination)).rejects.toThrow('A different file already exists');
      expect(await readFile(path.join(source, `${id}.json`), 'utf8')).toContain('source');
      expect(await readFile(path.join(destination, `${id}.json`), 'utf8')).toContain('destination');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports verified-copy progress and stops between files when cancelled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'linksunder-storage-cancel-'));
    const source = path.join(root, 'old');
    const destination = path.join(root, 'new');
    await mkdir(source);
    await writeFile(path.join(source, `${id}.json`), '{"kind":"run"}');
    await writeFile(path.join(source, `${id}.html`), '<h1>Run</h1>');
    const controller = new AbortController();
    const progress: Array<{ copied: number; processed: number; total: number; current?: string }> = [];
    try {
      await expect(copyReportFiles(source, destination, (item) => {
        progress.push(item);
        if (item.processed === 1) controller.abort();
      }, controller.signal)).rejects.toThrow('migration was interrupted');
      expect(progress.at(-1)).toMatchObject({ processed: 1, total: 2 });
      expect(await readFile(path.join(source, `${id}.json`), 'utf8')).toContain('run');
      const firstCopy = progress.at(-1)?.current;
      const secondCopy = firstCopy === `${id}.html` ? `${id}.json` : `${id}.html`;
      expect(await readFile(path.join(destination, firstCopy!), 'utf8')).toBe(firstCopy === `${id}.html` ? '<h1>Run</h1>' : '{"kind":"run"}');
      await expect(readFile(path.join(destination, secondCopy), 'utf8')).rejects.toThrow();
      expect(await readFile(path.join(source, `${id}.html`), 'utf8')).toBe('<h1>Run</h1>');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deletes only the selected report files and tolerates missing files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'linksunder-storage-delete-'));
    await writeFile(path.join(root, `${id}.json`), '{}');
    await writeFile(path.join(root, `${id}.html`), '<p>Report</p>');
    await writeFile(path.join(root, `network-${id}.json`), '{}');
    try {
      await removeReportFiles(root, 'run', id);
      await expect(access(path.join(root, `${id}.json`))).rejects.toThrow();
      await expect(access(path.join(root, `network-${id}.json`))).resolves.toBeUndefined();
      await removeReportFiles(root, 'run', id);
      await expect(removeReportFiles(root, 'network', 'bad-id')).rejects.toThrow('Invalid report identifier');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves damaged report files and marks interrupted reports for recovery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'linksunder-storage-recovery-'));
    const runId = '00000000-0000-4000-8000-000000000021';
    const networkId = '00000000-0000-4000-8000-000000000022';
    const damagedRunId = '00000000-0000-4000-8000-000000000023';
    const damagedNetworkId = '00000000-0000-4000-8000-000000000024';
    const started = new Date().toISOString();
    await writeFile(path.join(root, `${runId}.json`), JSON.stringify({
      id: runId, name: 'Interrupted run', type: 'scenario', status: 'running', started,
      duration: 0, steps: [], assertions: 0, passed: 0, screenshots: [], network: { failed: 0, injected: 0 },
    }));
    await writeFile(path.join(root, `network-${networkId}.json`), JSON.stringify({
      id: networkId, kind: 'network', target: 'https://example.test/', hostname: 'example.test',
      started, status: 'running', progress: 'Checking DNS',
      dns: { A: [], AAAA: [], CNAME: [], NS: [], MX: [], reverse: [], lookupTimeMs: 0 },
      ports: [], http: [], findings: [], limitations: [],
    }));
    const corruptRun = path.join(root, `${damagedRunId}.json`);
    const corruptNetwork = path.join(root, `network-${damagedNetworkId}.json`);
    await writeFile(corruptRun, '{broken JSON');
    await writeFile(corruptNetwork, '{broken JSON');
    try {
      const loaded = await loadStoredReports(root);
      expect(loaded.damagedReports).toBe(2);
      expect(loaded.runs[0]).toMatchObject({ status: 'error', error: 'Interrupted by server shutdown.' });
      expect(loaded.networkReports[0]).toMatchObject({ status: 'cancelled', progress: 'Interrupted' });
      expect(await readFile(corruptRun, 'utf8')).toBe('{broken JSON');
      expect(await readFile(corruptNetwork, 'utf8')).toBe('{broken JSON');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists the selected report directory and safely falls back from damaged settings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'linksunder-settings-'));
    const settings = path.join(root, 'preferences', 'settings.json');
    const selected = path.join(root, 'reports');
    try {
      await persistReportDirectoryPreference(settings, selected);
      expect(await readReportDirectoryPreference(settings)).toBe(path.resolve(selected));
      await writeFile(settings, '{damaged settings');
      expect(await readReportDirectoryPreference(settings)).toBeUndefined();
      expect(await readFile(settings, 'utf8')).toBe('{damaged settings');
      await expect(persistReportDirectoryPreference(settings, 'relative/path')).rejects.toThrow('must be absolute');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
