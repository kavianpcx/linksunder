function releaseNotesText(notes) {
  const value = Array.isArray(notes)
    ? notes.map((entry) => typeof entry === 'string' ? entry : entry?.note || '').filter(Boolean).join('\n\n')
    : typeof notes === 'string' ? notes : '';
  return value.slice(0, 12000);
}

function updateDetails(info = {}) {
  return {
    latestVersion: typeof info.version === 'string' ? info.version.slice(0, 80) : undefined,
    releaseNotes: releaseNotesText(info.releaseNotes),
    downloadSize: Array.isArray(info.files) && Number.isFinite(info.files[0]?.size) ? info.files[0].size : undefined,
  };
}

const CANCELLED_DOWNLOAD_MESSAGE = 'Update download cancelled. The saved partial file was removed.';
const PAUSED_DOWNLOAD_MESSAGE = 'Update paused. The downloaded data is saved and will be checked before it resumes.';

class UpdateController {
  constructor({ updater, tokenFactory, downloadManager, publish, getOperations, confirmInstall, initialState }) {
    this.updater = updater;
    this.tokenFactory = tokenFactory;
    this.downloadManager = downloadManager;
    this.publishCallback = publish;
    this.getOperations = getOperations;
    this.confirmInstall = confirmInstall;
    this.state = { ...initialState };
    this.checkPromise = undefined;
    this.downloadPromise = undefined;
    this.token = undefined;
    this.updateInfoAndProvider = undefined;
    const savedDownload = downloadManager?.getSavedDownload();
    if (savedDownload && this.state.supported) {
      this.state = {
        ...this.state,
        status: 'paused',
        latestVersion: savedDownload.version,
        progress: savedDownload.progress,
        resumeVerified: false,
        message: `A paused update for version ${savedDownload.version} is saved. Check for updates to verify it before resuming.`,
      };
    }
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on('checking-for-update', () => {
      if (this.state.supported) this.set({ status: 'checking', message: 'Checking the official LinkSunder releases…' });
    });
    updater.on('update-available', (info) => {
      if (this.state.supported) this.set({ ...updateDetails(info), status: 'available', message: 'A verified update is available. Download it when you are ready.', lastChecked: new Date().toISOString(), progress: undefined });
    });
    updater.on('update-not-available', () => {
      if (this.state.supported) this.set({ status: 'current', message: 'LinkSunder is up to date.', lastChecked: new Date().toISOString(), latestVersion: this.state.currentVersion, releaseNotes: undefined, downloadSize: undefined, progress: undefined, resumeVerified: false });
    });
    updater.on('download-progress', (progress) => {
      if (this.state.status !== 'downloading') return;
      this.set({ progress: {
        percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
        transferred: Math.max(0, Number(progress.transferred) || 0),
        total: Math.max(0, Number(progress.total) || 0),
        bytesPerSecond: Math.max(0, Number(progress.bytesPerSecond) || 0),
      } });
    });
    updater.on('update-downloaded', (event) => {
      if (!this.state.supported) return;
      this.token = undefined;
      this.set({ ...updateDetails(event), status: 'ready', message: 'Update ready. Restart and install when it suits you.', progress: undefined, cancelRequested: false });
    });
    updater.on('update-cancelled', () => {
      if (this.state.status === 'downloading') this.set({ status: 'cancelled', message: CANCELLED_DOWNLOAD_MESSAGE, progress: undefined, cancelRequested: false });
    });
    updater.on('error', () => {
      if (this.state.status === 'checking') this.set({ status: 'error', message: 'Could not check or verify the update. Check your connection, then retry.' });
    });
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.publishCallback(this.state);
    return this.state;
  }

  getState() {
    return { ...this.state, progress: this.state.progress && { ...this.state.progress } };
  }

  async check() {
    if (!this.state.supported) return this.getState();
    if (this.checkPromise) return this.checkPromise;
    if (this.downloadPromise || this.state.status === 'ready') return this.getState();
    const savedDownload = this.downloadManager?.getSavedDownload();
    this.set({ status: 'checking', message: 'Checking the official LinkSunder releases…', progress: savedDownload?.progress, cancelRequested: false });
    this.checkPromise = (async () => {
      try {
        const result = await this.updater.checkForUpdates();
        const lastChecked = new Date().toISOString();
        if (!result) throw new Error('No update result was returned.');
        this.updateInfoAndProvider = this.updater.updateInfoAndProvider || result.updateInfoAndProvider;
        if (result.isUpdateAvailable) {
          const info = result.updateInfo || {};
          const matchesSaved = this.downloadManager && this.updateInfoAndProvider
            ? await this.downloadManager.matches(this.updateInfoAndProvider)
            : false;
          if (matchesSaved) {
            const saved = this.downloadManager.getSavedDownload();
            this.set({ ...updateDetails(info), status: 'paused', message: PAUSED_DOWNLOAD_MESSAGE, lastChecked, progress: saved?.progress, resumeVerified: true, cancelRequested: false });
          } else {
            if (savedDownload) await this.downloadManager?.discard();
            this.set({ ...updateDetails(info), status: 'available', message: 'A verified update is available. Download it when you are ready.', lastChecked, progress: undefined, resumeVerified: false });
          }
        } else {
          await this.downloadManager?.discard();
          this.set({ status: 'current', latestVersion: this.state.currentVersion, releaseNotes: undefined, downloadSize: undefined, message: 'LinkSunder is up to date.', lastChecked, progress: undefined, resumeVerified: false });
        }
      } catch {
        const saved = this.downloadManager?.getSavedDownload();
        this.set({
          status: saved ? 'paused' : 'error',
          message: saved
            ? 'Could not verify the saved update. It is still paused; check again before resuming.'
            : 'Could not check or verify the update. Check your connection, then retry.',
          latestVersion: saved?.version || this.state.latestVersion,
          progress: saved?.progress,
          resumeVerified: false,
        });
      } finally {
        this.checkPromise = undefined;
      }
      return this.getState();
    })();
    return this.checkPromise;
  }

  async download() {
    if (!this.state.supported || !['available', 'paused', 'cancelled', 'error'].includes(this.state.status)) return this.getState();
    if (this.state.status === 'paused' && !this.state.resumeVerified) return this.getState();
    if (this.downloadPromise) return this.downloadPromise;
    const token = this.downloadManager ? undefined : this.tokenFactory();
    this.token = token;
    this.set({ status: 'downloading', message: 'Downloading and verifying the update from GitHub Releases…', progress: this.state.progress, cancelRequested: false, pauseRequested: false });
    this.downloadPromise = (async () => {
      try {
        if (this.downloadManager) {
          if (!this.updateInfoAndProvider) throw new Error('Check for updates before downloading the package.');
          const result = await this.downloadManager.download(this.updateInfoAndProvider, this.state.currentVersion, (progress) => {
            if (this.state.status === 'downloading') this.set({ progress });
          });
          if (result.cancelled) {
            this.set({ status: 'cancelled', message: CANCELLED_DOWNLOAD_MESSAGE, progress: undefined, cancelRequested: false, pauseRequested: false, resumeVerified: false });
          } else if (result.paused) {
            this.set({ status: 'paused', message: PAUSED_DOWNLOAD_MESSAGE, progress: result.progress, cancelRequested: false, pauseRequested: false, resumeVerified: true });
          } else if (result.downloaded) {
            this.set({ status: 'ready', message: 'Update ready. Restart and install when it suits you.', progress: undefined, cancelRequested: false, pauseRequested: false, resumeVerified: false });
          }
        } else {
          const files = await this.updater.downloadUpdate(token);
          if (token.cancelled) {
            this.set({ status: 'cancelled', message: CANCELLED_DOWNLOAD_MESSAGE, progress: undefined, cancelRequested: false });
          } else if (this.state.status === 'downloading' && files?.length) {
            this.token = undefined;
            this.set({ status: 'ready', message: 'Update ready. Restart and install when it suits you.', progress: undefined, cancelRequested: false });
          }
        }
      } catch (error) {
        const saved = this.downloadManager?.getSavedDownload();
        if (!this.downloadManager && token?.cancelled) {
          this.set({ status: 'cancelled', message: CANCELLED_DOWNLOAD_MESSAGE, progress: undefined, cancelRequested: false, pauseRequested: false });
        } else if (saved) {
          this.set({ status: 'paused', message: `The update download stopped: ${error?.message || 'network error'}. Resume continues from the saved progress.`, progress: saved.progress, cancelRequested: false, pauseRequested: false, resumeVerified: true });
        } else {
          this.set({ status: 'error', message: `The update download failed verification or was interrupted: ${error?.message || 'check your connection and retry.'}`, progress: undefined, cancelRequested: false, pauseRequested: false, resumeVerified: false });
        }
      } finally {
        this.token = undefined;
        this.downloadPromise = undefined;
      }
      return this.getState();
    })();
    return this.downloadPromise;
  }

  async cancelDownload() {
    const status = this.state.status;
    if (!this.state.supported || !['downloading', 'paused', 'error'].includes(status)) return false;
    if (!this.downloadManager && (!this.token || status !== 'downloading')) return false;
    this.set({ message: 'Cancelling the update download…', cancelRequested: true });
    if (this.downloadManager) {
      if (status !== 'downloading') {
        await this.downloadManager.discard();
        this.set({ status: 'cancelled', message: CANCELLED_DOWNLOAD_MESSAGE, progress: undefined, cancelRequested: false, resumeVerified: false });
      } else this.downloadManager.cancel();
    } else this.token.cancel();
    return true;
  }

  pauseDownload() {
    if (!this.downloadManager || this.state.status !== 'downloading') return false;
    this.set({ message: 'Pausing the update download…', pauseRequested: true });
    this.downloadManager.pause();
    return true;
  }

  async pauseForShutdown() {
    if (this.downloadManager && this.state.status === 'downloading') {
      this.downloadManager.pause();
      await this.downloadPromise;
      return;
    }
    if (this.token && this.state.status === 'downloading') this.token.cancel();
  }

  async install() {
    if (!this.state.supported || this.state.status !== 'ready') return false;
    const operations = await this.getOperations();
    if (!operations || operations.busy) {
      this.set({ message: operations?.message || 'Finish active checks, storage changes, and report cleanup before installing.' });
      return false;
    }
    if (!await this.confirmInstall()) return false;
    const rechecked = await this.getOperations();
    if (!rechecked || rechecked.busy) {
      this.set({ message: rechecked?.message || 'An operation started. Finish it before installing the update.' });
      return false;
    }
    this.updater.quitAndInstall(true, true);
    return true;
  }
}

module.exports = { UpdateController };
