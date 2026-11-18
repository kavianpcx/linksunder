export type UpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'cancelled'
  | 'error';

export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdateState {
  currentVersion: string;
  supported: boolean;
  supportReason?: string;
  status: UpdateStatus;
  message: string;
  latestVersion?: string;
  releaseNotes?: string;
  downloadSize?: number;
  lastChecked?: string;
  progress?: UpdateProgress;
  cancelRequested?: boolean;
}
