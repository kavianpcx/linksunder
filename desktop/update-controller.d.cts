export interface UpdateControllerState {
  currentVersion: string;
  supported: boolean;
  status: string;
  message: string;
  latestVersion?: string;
  progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number };
  resumeVerified?: boolean;
  cancelRequested?: boolean;
  pauseRequested?: boolean;
}

export declare class UpdateController {
  constructor(options: unknown);
  check(): Promise<UpdateControllerState>;
  download(): Promise<UpdateControllerState>;
  cancelDownload(): Promise<boolean>;
  pauseDownload(): boolean;
  pauseForShutdown(): Promise<void>;
  install(): Promise<boolean>;
  getState(): UpdateControllerState;
}
