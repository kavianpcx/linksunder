export interface ResumableUpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export declare class ResumableUpdateDownload {
  constructor(options: {
    updater: unknown;
    directory: string;
    platform?: string;
    getAppImagePath?: () => string | undefined;
    chunkSize?: number;
    fetchImpl?: typeof fetch;
    allowLocalhost?: boolean;
  });
  getSavedDownload(): { version: string; progress: ResumableUpdateProgress } | undefined;
  matches(updateInfoAndProvider: unknown): Promise<boolean>;
  download(
    updateInfoAndProvider: unknown,
    currentVersion: string,
    onProgress?: (progress: ResumableUpdateProgress) => void,
  ): Promise<{
    downloaded?: boolean;
    paused?: boolean;
    cancelled?: boolean;
    progress?: ResumableUpdateProgress;
    usedFullFallback?: boolean;
  }>;
  pause(): void;
  cancel(): void;
  discard(): Promise<void>;
}
