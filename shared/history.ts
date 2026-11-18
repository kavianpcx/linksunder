export type HistoryKind = 'run' | 'network';

export interface HistoryRecord {
  kind: HistoryKind;
  id: string;
  title: string;
  target: string;
  started: string;
  status: string;
  duration: number;
  assertions: number;
  passed: number;
}

export interface HistoryQuery {
  page?: number;
  pageSize?: number;
  query?: string;
  kind?: HistoryKind;
  status?: string;
  from?: string;
  to?: string;
  sort?: 'newest' | 'oldest';
}

export interface HistoryPageData {
  items: HistoryRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface IndexingProgress {
  status: 'idle' | 'indexing' | 'complete';
  directory?: string;
  scanned: number;
  total: number;
  damaged: number;
  startedAt?: string;
  completedAt?: string;
}

export interface HistorySummary {
  resilienceCount: number;
  networkCount: number;
  passedCount: number;
  activeCount: number;
  lastCheck?: { started: string; status: string };
  recentRuns: HistoryRecord[];
  damagedReports: number;
  indexing: IndexingProgress;
  deletionRecoveryError?: string;
}

export interface HistoryDeleteJob {
  id: string;
  status: 'running' | 'complete';
  total: number;
  deleted: number;
  failed: number;
  created: string;
  updated: string;
  failures: Array<{ kind: HistoryKind; id: string; error: string }>;
}

export interface ReportStorageMigration {
  id: string;
  status: 'running' | 'complete' | 'error' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  copied: number;
  processed: number;
  total: number;
  current?: string;
  error?: string;
  result?: { reportDirectory: string; copied: number; total: number; originalsKept: true };
}
