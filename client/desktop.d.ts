export {};

declare global {
  interface Window {
    linksunderDesktop?: {
      chooseReportDirectory: () => Promise<string | undefined>;
      openReportDirectory: () => Promise<{ ok: boolean; error?: string }>;
      minimize: () => void;
      toggleMaximize: () => Promise<boolean>;
      isMaximized: () => Promise<boolean>;
      close: () => void;
      onWindowState: (listener: (maximized: boolean) => void) => () => void;
    };
  }
}
