export {};
import type { UpdateState } from '../shared/updates';

declare global {
  interface Window {
    linksunderDesktop?: {
      chooseReportDirectory: () => Promise<string | undefined>;
      chooseGeolocationDatabase: (kind: 'city' | 'asn') => Promise<string | undefined>;
      openGeolocationSignup: () => void;
      openReleasePage: () => void;
      getUpdateState: () => Promise<UpdateState | undefined>;
      checkForUpdates: () => Promise<UpdateState | undefined>;
      downloadUpdate: () => Promise<UpdateState | undefined>;
      pauseUpdateDownload: () => Promise<boolean>;
      cancelUpdateDownload: () => Promise<boolean>;
      installUpdate: () => Promise<boolean>;
      openReportDirectory: () => Promise<{ ok: boolean; error?: string }>;
      minimize: () => void;
      toggleMaximize: () => Promise<boolean>;
      isMaximized: () => Promise<boolean>;
      close: () => void;
      onWindowState: (listener: (maximized: boolean) => void) => () => void;
      onUpdateState: (listener: (state: UpdateState) => void) => () => void;
    };
  }
}
