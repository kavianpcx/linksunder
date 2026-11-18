import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, link, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NetworkReport } from '../shared/network.js';
import type { Run } from '../shared/schema.js';

export type StoredReportKind = 'run' | 'network';

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidReportId(id: unknown): id is string {
  return typeof id === 'string' && UUID_PATTERN.test(id);
}

function validId(id: string) {
  return isValidReportId(id);
}

export function storedReportFilenames(kind: StoredReportKind, id: string) {
  if (!validId(id)) throw new Error('Invalid report identifier.');
  const prefix = kind === 'network' ? 'network-' : '';
  return [`${prefix}${id}.json`, `${prefix}${id}.html`];
}

export async function assertWritableDirectory(directory: string) {
  await mkdir(directory, { recursive: true });
  const marker = path.join(directory, `.linksunder-write-check-${randomUUID()}`);
  const handle = await open(marker, 'wx');
  await handle.close();
  await unlink(marker);
}

export async function readReportDirectoryPreference(settingsFile: string): Promise<string | undefined> {
  try {
    const saved: unknown = JSON.parse(await readFile(settingsFile, 'utf8'));
    if (isRecord(saved) && typeof saved.reportDirectory === 'string' && path.isAbsolute(saved.reportDirectory))
      return path.resolve(saved.reportDirectory);
  } catch {
    /* First launch or damaged preferences: use the default folder without changing the file. */
  }
  return undefined;
}

export async function readReportStoragePreferences(settingsFile: string) {
  try {
    const saved: unknown = JSON.parse(await readFile(settingsFile, 'utf8'));
    if (!isRecord(saved)) return {};
    return {
      reportDirectory: typeof saved.reportDirectory === 'string' && path.isAbsolute(saved.reportDirectory)
        ? path.resolve(saved.reportDirectory) : undefined,
      geolocationCityPath: typeof saved.geolocationCityPath === 'string' && path.isAbsolute(saved.geolocationCityPath)
        ? path.resolve(saved.geolocationCityPath) : undefined,
      geolocationAsnPath: typeof saved.geolocationAsnPath === 'string' && path.isAbsolute(saved.geolocationAsnPath)
        ? path.resolve(saved.geolocationAsnPath) : undefined,
    };
  } catch {
    return {};
  }
}

export async function persistReportDirectoryPreference(settingsFile: string, directory: string) {
  if (!path.isAbsolute(directory)) throw new Error('Report storage path must be absolute.');
  await mkdir(path.dirname(settingsFile), { recursive: true });
  const temporary = `${settingsFile}.${randomUUID()}.tmp`;
  try {
    let saved: Record<string, unknown> = {};
    try {
      const existing: unknown = JSON.parse(await readFile(settingsFile, 'utf8'));
      if (isRecord(existing)) saved = existing;
    } catch {
      /* Replace a missing or damaged preference file with the selected path. */
    }
    await writeFile(temporary, JSON.stringify({ ...saved, reportDirectory: path.resolve(directory) }, null, 2), { flag: 'wx' });
    await rename(temporary, settingsFile);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function persistGeolocationPreference(
  settingsFile: string,
  kind: 'city' | 'asn',
  databasePath?: string,
) {
  if (databasePath && !path.isAbsolute(databasePath)) throw new Error('Geolocation database path must be absolute.');
  await mkdir(path.dirname(settingsFile), { recursive: true });
  const key = kind === 'city' ? 'geolocationCityPath' : 'geolocationAsnPath';
  const temporary = `${settingsFile}.${randomUUID()}.tmp`;
  try {
    let saved: Record<string, unknown> = {};
    try {
      const existing: unknown = JSON.parse(await readFile(settingsFile, 'utf8'));
      if (isRecord(existing)) saved = existing;
    } catch {
      /* Replace a missing or damaged preference file with the selected database. */
    }
    if (databasePath) saved[key] = path.resolve(databasePath);
    else delete saved[key];
    await writeFile(temporary, JSON.stringify(saved, null, 2), { flag: 'wx' });
    await rename(temporary, settingsFile);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function loadStoredReports(directory: string) {
  const entries = await readdir(directory);
  const runs: Run[] = [];
  const networkReports: NetworkReport[] = [];
  let damagedReports = 0;

  const runStatus = new Set(['running', 'pass', 'fail', 'observed', 'error', 'cancelled', 'not-tested', 'fault-not-triggered']);
  const networkStatus = new Set(['running', 'complete', 'cancelled', 'error']);
  for (const file of entries) {
    const runMatch = /^([a-f0-9]{8}-[a-f0-9]{4}-[1-8a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.json$/i.exec(file);
    const networkMatch = /^network-([a-f0-9]{8}-[a-f0-9]{4}-[1-8a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.json$/i.exec(file);
    if (!runMatch && !networkMatch) continue;
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
      if (runMatch) {
        if (!isRecord(parsed) || parsed.id !== runMatch[1] || typeof parsed.name !== 'string' ||
          typeof parsed.type !== 'string' || typeof parsed.started !== 'string' ||
          typeof parsed.status !== 'string' || !runStatus.has(parsed.status) ||
          typeof parsed.duration !== 'number' || !Array.isArray(parsed.steps) ||
          typeof parsed.assertions !== 'number' || typeof parsed.passed !== 'number' ||
          !Array.isArray(parsed.screenshots) || !isRecord(parsed.network)) {
          damagedReports += 1;
          continue;
        }
        const run = parsed as unknown as Run;
        if (run.status === 'running') {
          run.status = 'error';
          run.error = 'Interrupted by server shutdown.';
        }
        runs.push(run);
        continue;
      }

      if (!isRecord(parsed) || parsed.kind !== 'network' || parsed.id !== networkMatch?.[1] ||
        typeof parsed.target !== 'string' || typeof parsed.hostname !== 'string' ||
        typeof parsed.started !== 'string' || typeof parsed.status !== 'string' || !networkStatus.has(parsed.status) ||
        typeof parsed.progress !== 'string' || !isRecord(parsed.dns) ||
        !Array.isArray(parsed.ports) || !Array.isArray(parsed.http) || !Array.isArray(parsed.findings) ||
        !Array.isArray(parsed.limitations)) {
        damagedReports += 1;
        continue;
      }
      const report = parsed as unknown as NetworkReport;
      if (report.status === 'running') {
        report.status = 'cancelled';
        report.progress = 'Interrupted';
        report.error = 'Inspection was interrupted when LinkSunder closed. Completed observations are preserved.';
      }
      networkReports.push(report);
    } catch {
      damagedReports += 1;
      /* Keep damaged report files unchanged so the user can recover them. */
    }
  }
  return { runs, networkReports, damagedReports };
}

async function hashFile(filePath: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

export interface ReportCopyProgress {
  copied: number;
  processed: number;
  total: number;
  current?: string;
}

export async function copyReportFiles(
  sourceDirectory: string,
  destinationDirectory: string,
  onProgress: (progress: ReportCopyProgress) => void = () => undefined,
  signal?: AbortSignal,
) {
  await assertWritableDirectory(destinationDirectory);
  const names = (await readdir(sourceDirectory)).filter((name) =>
    /^(?:network-)?[a-f0-9-]{36}\.(?:json|html)$/i.test(name),
  ).sort();
  let copied = 0;
  let processed = 0;
  onProgress({ copied, processed, total: names.length });
  for (const name of names) {
    if (signal?.aborted) throw new Error('Report folder migration was interrupted. The current folder and original reports remain selected.');
    const source = path.join(sourceDirectory, name);
    const destination = path.join(destinationDirectory, name);
    const temporary = path.join(destinationDirectory, `.${name}.${randomUUID()}.linksunder-copying`);
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile()) {
      processed += 1;
      onProgress({ copied, processed, total: names.length, current: name });
      continue;
    }
    const sourceHash = await hashFile(source);
    try {
      try {
        await lstat(destination);
        if (await hashFile(destination) !== sourceHash)
          throw new Error(`A different file already exists at ${destination}. Your original reports remain unchanged.`);
        processed += 1;
        onProgress({ copied, processed, total: names.length, current: name });
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await copyFile(source, temporary, constants.COPYFILE_EXCL);
      if (await hashFile(temporary) !== sourceHash)
        throw new Error(`A report could not be verified at ${destination}. Your original reports remain unchanged.`);
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await hashFile(destination) !== sourceHash)
          throw new Error(`A different file already exists at ${destination}. Your original reports remain unchanged.`, { cause: error });
      }
      copied += 1;
      processed += 1;
      onProgress({ copied, processed, total: names.length, current: name });
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  return { copied, total: names.length };
}

export async function removeReportFiles(directory: string, kind: StoredReportKind, id: string) {
  for (const name of storedReportFilenames(kind, id)) {
    try {
      await unlink(path.join(directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function stagedReportFilename(name: string) {
  return `.${name}.linksunder-deleting`;
}

export async function stageReportFiles(directory: string, kind: StoredReportKind, id: string) {
  const moved: string[] = [];
  try {
    for (const name of storedReportFilenames(kind, id)) {
      const source = path.join(directory, name);
      const staged = path.join(directory, stagedReportFilename(name));
      try {
        await lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      try {
        await lstat(staged);
        throw new Error(`A previous report deletion is awaiting recovery for ${name}.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(source, staged);
      moved.push(name);
    }
    return moved;
  } catch (error) {
    for (const name of moved.reverse()) {
      const source = path.join(directory, name);
      const staged = path.join(directory, stagedReportFilename(name));
      await rename(staged, source).catch(() => {});
    }
    throw error;
  }
}

export async function restoreStagedReportFiles(directory: string, kind: StoredReportKind, id: string) {
  for (const name of storedReportFilenames(kind, id)) {
    const original = path.join(directory, name);
    const staged = path.join(directory, stagedReportFilename(name));
    try {
      await lstat(staged);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    try {
      await lstat(original);
      throw new Error(`Cannot restore ${name} because a file with that name already exists.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(staged, original);
  }
}

export async function purgeStagedReportFiles(directory: string, kind: StoredReportKind, id: string) {
  for (const name of storedReportFilenames(kind, id)) {
    try {
      await unlink(path.join(directory, stagedReportFilename(name)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export async function persistReport<T extends Run | NetworkReport>(
  directory: string,
  report: T,
  html: string,
  kind: StoredReportKind,
) {
  const [jsonName, htmlName] = storedReportFilenames(kind, report.id);
  const jsonPath = path.join(directory, jsonName);
  const htmlPath = path.join(directory, htmlName);
  const jsonTemp = `${jsonPath}.tmp`;
  const htmlTemp = `${htmlPath}.tmp`;
  try {
    await writeFile(jsonTemp, JSON.stringify(report));
    await rename(jsonTemp, jsonPath);
    await writeFile(htmlTemp, html);
    await rename(htmlTemp, htmlPath);
  } catch (error) {
    await Promise.all([unlink(jsonTemp).catch(() => {}), unlink(htmlTemp).catch(() => {})]);
    throw error;
  }
}
