export interface UpdateControllerState {
  currentVersion: string;
  supported: boolean;
  status: string;
  message: string;
  latestVersion?: string;
  progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number };
}

export declare class UpdateController {
  constructor(options: unknown);
  check(): Promise<UpdateControllerState>;
  download(): Promise<UpdateControllerState>;
  cancelDownload(): boolean;
  install(): Promise<boolean>;
  getState(): UpdateControllerState;
}
