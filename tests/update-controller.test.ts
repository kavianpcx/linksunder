import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { UpdateController } from '../desktop/update-controller.cjs';

class FakeToken extends EventEmitter {
  cancelled = false;
  cancel() { this.cancelled = true; this.emit('cancel'); }
}

interface UpdateMock extends EventEmitter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  updateInfoAndProvider?: { info: { version: string }; provider: unknown };
  checkForUpdates: () => Promise<{ isUpdateAvailable: boolean; updateInfo?: { version: string; releaseNotes?: string; files?: Array<{ size: number }> } } | null>;
  downloadUpdate: (token: FakeToken) => Promise<string[]>;
  quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) => void;
}

function makeController(overrides: Record<string, unknown> = {}) {
  const updater = new EventEmitter() as UpdateMock;
  updater.checkForUpdates = vi.fn(async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: '0.4.0', releaseNotes: 'Scalable reports and offline location.', files: [{ size: 123456 }] },
  }));
  updater.downloadUpdate = vi.fn(async () => ['/tmp/verified-update.exe']);
  updater.quitAndInstall = vi.fn();
  const token = new FakeToken();
  const publish = vi.fn();
  const getOperations = vi.fn(async (): Promise<{ busy: boolean; message?: string }> => ({ busy: false }));
  const confirmInstall = vi.fn(async () => true);
  const controller = new UpdateController({
    updater,
    tokenFactory: () => token,
    publish,
    getOperations,
    confirmInstall,
    initialState: { currentVersion: '0.3.0', supported: true, status: 'idle', message: 'Manual check only.' },
    ...overrides,
  });
  return { controller, updater, token, publish, getOperations, confirmInstall };
}

describe('desktop update workflow', () => {
  it('checks only on request and does not download until the user starts it', async () => {
    const { controller, updater } = makeController();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    const available = await controller.check();
    expect(available).toMatchObject({ status: 'available', latestVersion: '0.4.0' });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    updater.downloadUpdate = vi.fn(async () => {
      updater.emit('download-progress', { percent: 45.2, transferred: 452, total: 1000, bytesPerSecond: 88 });
      expect(controller.getState()).toMatchObject({ status: 'downloading', progress: { percent: 45.2 } });
      updater.emit('update-downloaded', { version: '0.4.0', releaseNotes: 'Scalable reports and offline location.', files: [{ size: 123456 }] });
      return ['/tmp/verified-update.exe'];
    });
    await controller.download();
    expect(controller.getState().status).toBe('ready');
  });

  it('cancels a real updater download token and keeps the installed version available', async () => {
    const { controller, updater, token } = makeController();
    await controller.check();
    updater.downloadUpdate = vi.fn((downloadToken: FakeToken) => new Promise<string[]>((_resolve, reject) => {
      downloadToken.once('cancel', () => reject(new Error('cancelled')));
    }));
    const download = controller.download();
    expect(await controller.cancelDownload()).toBe(true);
    await download;
    expect(token.cancelled).toBe(true);
    expect(controller.getState()).toMatchObject({ status: 'cancelled', message: expect.stringContaining('partial file was removed') });
  });

  it('pauses a resumable download and resumes only after saved release metadata is checked', async () => {
    let finishDownload: ((result: { paused: true; progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } }) => void) | undefined;
    const downloadManager = {
      getSavedDownload: vi.fn(() => ({ version: '0.4.0', progress: { percent: 25, transferred: 250, total: 1000, bytesPerSecond: 0 } })),
      matches: vi.fn(async () => true),
      download: vi.fn(() => new Promise((resolve) => { finishDownload = resolve; })),
      pause: vi.fn(),
      cancel: vi.fn(),
      discard: vi.fn(async () => undefined),
    };
    const { controller, updater } = makeController({ downloadManager });
    updater.updateInfoAndProvider = { info: { version: '0.4.0' }, provider: {} };

    expect(controller.getState()).toMatchObject({ status: 'paused', resumeVerified: false });
    expect((await controller.check())).toMatchObject({ status: 'paused', resumeVerified: true });
    const downloading = controller.download();
    expect(controller.getState().status).toBe('downloading');
    expect(controller.pauseDownload()).toBe(true);
    expect(downloadManager.pause).toHaveBeenCalledOnce();
    finishDownload?.({ paused: true, progress: { percent: 25, transferred: 250, total: 1000, bytesPerSecond: 0 } });
    await downloading;
    expect(controller.getState()).toMatchObject({ status: 'paused', resumeVerified: true, progress: { transferred: 250 } });
  });

  it('blocks installation during active work and asks before restart', async () => {
    const { controller, updater, getOperations, confirmInstall } = makeController();
    await controller.check();
    updater.downloadUpdate = vi.fn(async () => {
      updater.emit('update-downloaded', { version: '0.4.0', files: [{ size: 123456 }] });
      return ['/tmp/verified-update.exe'];
    });
    await controller.download();
    getOperations.mockResolvedValueOnce({ busy: true, message: 'Finish the running network inspection before installing.' });
    expect(await controller.install()).toBe(false);
    expect(confirmInstall).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(controller.getState().message).toContain('running network inspection');
    expect(await controller.install()).toBe(true);
    expect(confirmInstall).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('reports offline checks and up-to-date results without hanging', async () => {
    const { controller, updater } = makeController();
    updater.checkForUpdates = vi.fn().mockRejectedValue(new Error('offline'));
    expect((await controller.check()).status).toBe('error');
    updater.checkForUpdates = vi.fn(async () => ({ isUpdateAvailable: false, updateInfo: { version: '0.3.0' } }));
    expect((await controller.check()).status).toBe('current');
  });

  it('keeps saved progress locked when release verification fails after restart', async () => {
    const downloadManager = {
      getSavedDownload: vi.fn(() => ({ version: '0.4.0', progress: { percent: 25, transferred: 250, total: 1000, bytesPerSecond: 0 } })),
      matches: vi.fn(async () => true),
      download: vi.fn(),
      pause: vi.fn(),
      cancel: vi.fn(),
      discard: vi.fn(async () => undefined),
    };
    const { controller, updater } = makeController({ downloadManager });
    updater.checkForUpdates = vi.fn().mockRejectedValue(new Error('offline'));
    expect(controller.getState()).toMatchObject({ status: 'paused', resumeVerified: false });
    expect(await controller.check()).toMatchObject({ status: 'paused', resumeVerified: false, progress: { transferred: 250 } });
    expect(await controller.download()).toMatchObject({ status: 'paused', resumeVerified: false });
    expect(downloadManager.download).not.toHaveBeenCalled();
  });

  it('leaves unsupported packages on a manual release path', async () => {
    const { controller, updater } = makeController({
      initialState: { currentVersion: '0.3.0', supported: false, status: 'unsupported', message: 'Manual install.' },
    });
    expect((await controller.check()).status).toBe('unsupported');
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(await controller.download()).toMatchObject({ status: 'unsupported' });
  });
});
