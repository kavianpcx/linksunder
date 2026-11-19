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

const CANCELLED_DOWNLOAD_MESSAGE = 'Update download cancelled. The partial file is discarded; retry starts a fresh download.';

class UpdateController {
  constructor({ updater, tokenFactory, publish, getOperations, confirmInstall, initialState }) {
    this.updater = updater;
    this.tokenFactory = tokenFactory;
    this.publishCallback = publish;
    this.getOperations = getOperations;
    this.confirmInstall = confirmInstall;
    this.state = { ...initialState };
    this.checkPromise = undefined;
    this.downloadPromise = undefined;
    this.token = undefined;
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
      if (this.state.supported) this.set({ status: 'current', message: 'LinkSunder is up to date.', lastChecked: new Date().toISOString(), latestVersion: this.state.currentVersion, releaseNotes: undefined, downloadSize: undefined, progress: undefined });
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
    this.set({ status: 'checking', message: 'Checking the official LinkSunder releases…', progress: undefined, cancelRequested: false });
    this.checkPromise = (async () => {
      try {
        const result = await this.updater.checkForUpdates();
        const lastChecked = new Date().toISOString();
        if (!result) throw new Error('No update result was returned.');
        if (result.isUpdateAvailable) {
          const info = result.updateInfo || {};
          this.set({ ...updateDetails(info), status: 'available', message: 'A verified update is available. Download it when you are ready.', lastChecked });
        } else {
          this.set({ status: 'current', latestVersion: this.state.currentVersion, releaseNotes: undefined, downloadSize: undefined, message: 'LinkSunder is up to date.', lastChecked, progress: undefined });
        }
      } catch {
        this.set({ status: 'error', message: 'Could not check or verify the update. Check your connection, then retry.', progress: undefined });
      } finally {
        this.checkPromise = undefined;
      }
      return this.getState();
    })();
    return this.checkPromise;
  }

  async download() {
    if (!this.state.supported || !['available', 'cancelled', 'error'].includes(this.state.status)) return this.getState();
    if (this.downloadPromise) return this.downloadPromise;
    const token = this.tokenFactory();
    this.token = token;
    this.set({ status: 'downloading', message: 'Downloading and verifying the update from GitHub Releases…', progress: undefined, cancelRequested: false });
    this.downloadPromise = (async () => {
      try {
        const files = await this.updater.downloadUpdate(token);
        if (token.cancelled) {
          this.set({ status: 'cancelled', message: CANCELLED_DOWNLOAD_MESSAGE, progress: undefined, cancelRequested: false });
        } else if (this.state.status === 'downloading' && files?.length) {
          this.token = undefined;
          this.set({ status: 'ready', message: 'Update ready. Restart and install when it suits you.', progress: undefined, cancelRequested: false });
        }
      } catch {
        this.set({ status: token.cancelled ? 'cancelled' : 'error', message: token.cancelled ? CANCELLED_DOWNLOAD_MESSAGE : 'The update download failed verification or was interrupted. Your current LinkSunder version is still available. Retry starts the download again.', progress: undefined, cancelRequested: false });
      } finally {
        this.token = undefined;
        this.downloadPromise = undefined;
      }
      return this.getState();
    })();
    return this.downloadPromise;
  }

  cancelDownload() {
    if (!this.token || this.state.status !== 'downloading') return false;
    this.set({ message: 'Cancelling the update download…', cancelRequested: true });
    this.token.cancel();
    return true;
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
