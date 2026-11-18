import type { HistoryIndex } from './history-index.js';
import { purgeStagedReportFiles, restoreStagedReportFiles, stageReportFiles } from './storage.js';

type DeleteItem = { kind: 'run' | 'network'; id: string };
type DeleteOutcome = DeleteItem & { error?: string };
type Candidate = DeleteItem & { directory: string };

async function mapWithConcurrency<T, R>(items: T[], limit: number, callback: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await callback(items[index]);
    }
  }));
  return results;
}

/** Stages files first, commits index removals as one transaction, and records progress in one batch. */
export async function processDeleteBatch(index: HistoryIndex, jobId: string, items: DeleteItem[]) {
  const outcomes: DeleteOutcome[] = [];
  const candidates: Candidate[] = [];
  for (const item of items) {
    const report = index.getReportFile(item.kind, item.id);
    if (!report) outcomes.push(item);
    else if (report.status === 'running') outcomes.push({ ...item, error: 'Running checks cannot be deleted.' });
    else candidates.push({ ...item, directory: report.directory });
  }

  try {
    index.setDeleteJournals(candidates);
  } catch (error) {
    for (const item of candidates) outcomes.push({ kind: item.kind, id: item.id, error: (error as Error).message });
    candidates.length = 0;
  }

  const staged = await mapWithConcurrency(candidates, 8, async (item) => {
    try {
      await stageReportFiles(item.directory, item.kind, item.id);
      return { item, error: undefined as string | undefined };
    } catch (error) {
      return { item, error: (error as Error).message };
    }
  });
  const readyToCommit: Candidate[] = [];
  const journalsToClear: DeleteItem[] = [];
  for (const result of staged) {
    if (!result.error) readyToCommit.push(result.item);
    else {
      await restoreStagedReportFiles(result.item.directory, result.item.kind, result.item.id).then(
        () => journalsToClear.push(result.item),
        () => undefined,
      );
      outcomes.push({ kind: result.item.kind, id: result.item.id, error: result.error });
    }
  }

  if (readyToCommit.length) {
    try {
      index.commitDeletions(readyToCommit);
      for (const item of readyToCommit) outcomes.push({ kind: item.kind, id: item.id });
      const purged = await mapWithConcurrency(readyToCommit, 8, async (item) => {
        try {
          await purgeStagedReportFiles(item.directory, item.kind, item.id);
          return item;
        } catch {
          return undefined;
        }
      });
      journalsToClear.push(...purged.filter((item): item is Candidate => Boolean(item)));
    } catch (error) {
      for (const item of readyToCommit) {
        await restoreStagedReportFiles(item.directory, item.kind, item.id).then(
          () => journalsToClear.push(item),
          () => undefined,
        );
        outcomes.push({ kind: item.kind, id: item.id, error: (error as Error).message });
      }
    }
  }

  if (journalsToClear.length) index.clearDeleteJournals(journalsToClear);
  if (outcomes.length) index.finishDeleteItems(jobId, outcomes);
}
