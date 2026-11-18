const { app, BrowserWindow, dialog, utilityProcess, Menu, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { URL } = require('node:url');
const { setTimeout, clearTimeout } = require('node:timers');
const net = require('node:net');
const { autoUpdater } = require('electron-updater');
const { CancellationToken } = require('builder-util-runtime');
const { UpdateController } = require('./update-controller.cjs');

let engine;
let window;
let origin = '';
let shuttingDown = false;
let engineExited = false;
let updateController;
function recordUpdateTestStartup(event, details = {}) {
  const logPath = process.env.LINKSUNDER_UPDATE_TEST_START_LOG;
  if (process.env.CI !== 'true' || !logPath) return;
  try {
    fs.appendFileSync(logPath, JSON.stringify({
      event,
      version: app.getVersion(),
      pid: process.pid,
      executable: process.execPath,
      appImage: process.env.APPIMAGE,
      appDir: process.env.APPDIR,
      debugPort: process.env.LINKSUNDER_UPDATE_TEST_DEBUG_PORT,
      args: process.argv,
      ...details,
    }) + '\n');
  } catch {
    /* Diagnostics are optional and enabled only by the isolated updater integration test. */
  }
}

app.setName('LinkSunder');
recordUpdateTestStartup('startup');
if (process.env.CI === 'true' && process.env.LINKSUNDER_UPDATE_TEST_DEBUG_PORT) {
  const port = Number(process.env.LINKSUNDER_UPDATE_TEST_DEBUG_PORT);
  if (Number.isInteger(port) && port > 0 && port < 65536) {
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
    app.commandLine.appendSwitch('remote-debugging-port', String(port));
  }
}
if (process.env.LINKSUNDER_DESKTOP_DATA)
  app.setPath('userData', process.env.LINKSUNDER_DESKTOP_DATA);
if (process.platform === 'linux') {
  autoUpdater.on('appimage-filename-updated', (updatedPath) => {
    process.env.APPIMAGE = updatedPath;
  });
}
const hasSingleInstanceLock = app.requestSingleInstanceLock();
recordUpdateTestStartup('single-instance-lock', { acquired: hasSingleInstanceLock });
if (!hasSingleInstanceLock) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      await start();
      recordUpdateTestStartup('ready');
    })
    .catch((error) => {
      recordUpdateTestStartup('startup-error', { message: error?.message || String(error) });
      dialog.showErrorBox(
        'LinkSunder could not start',
        'The local test engine could not start. Close LinkSunder and try again. If the problem continues, reinstall the application. Your saved reports will be kept.',
      );
      app.quit();
    });
}

async function start() {
  Menu.setApplicationMenu(null);
  const resources = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'build');
  const browserDirectory = path.join(resources, 'browsers');
  const portFile = path.join(app.getPath('userData'), 'engine-port.json');
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  let previousPort = 4317;
  try {
    const saved = JSON.parse(fs.readFileSync(portFile, 'utf8'));
    if (Number.isInteger(saved.port) && saved.port > 1024 && saved.port < 65536)
      previousPort = saved.port;
  } catch {
    /* First launch. */
  }
  const port = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => {
      const fallback = net.createServer();
      fallback.listen(0, '127.0.0.1', () => {
        const free = fallback.address().port;
        fallback.close(() => resolve(free));
      });
    });
    probe.listen(previousPort, '127.0.0.1', () => probe.close(() => resolve(previousPort)));
  });
  fs.writeFileSync(portFile, JSON.stringify({ port }));
  const env = {
    ...process.env,
    PORT: String(port),
    LINKSUNDER_PRODUCTION: '1',
    LINKSUNDER_DATA: path.join(app.getPath('userData'), 'reports'),
    LINKSUNDER_SETTINGS_FILE: path.join(app.getPath('userData'), 'settings.json'),
  };
  if (fs.existsSync(browserDirectory)) env.PLAYWRIGHT_BROWSERS_PATH = browserDirectory;
  engine = utilityProcess.fork(path.join(app.getAppPath(), 'dist/server/index.js'), [], {
    env,
    cwd: app.isPackaged ? process.resourcesPath : app.getAppPath(),
    serviceName: 'LinkSunder test engine',
    stdio: 'pipe',
  });
  origin = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Engine startup timed out')), 30000);
    engine.stdout.on('data', (data) => {
      output = (output + data.toString()).slice(-2000);
      const match = output.match(/LinkSunder ready: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    engine.on('exit', () => {
      engineExited = true;
      clearTimeout(timer);
      reject(new Error('Engine exited'));
      if (window && !shuttingDown) {
        dialog.showErrorBox(
          'Test engine stopped',
          'The test engine stopped unexpectedly. Reopen LinkSunder to continue. Saved reports are preserved.',
        );
        app.quit();
      }
    });
  });
  window = new BrowserWindow({
    icon: path.join(app.getAppPath(), 'desktop/icon.png'),
    title: 'LinkSunder',
    width: 1280,
    height: 900,
    minWidth: 390,
    minHeight: 600,
    frame: false,
    show: false,
    backgroundColor: '#10121b',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'desktop/preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  registerWindowIpc();
  createUpdateController();
  window.on('maximize', () => window?.webContents.send('linksunder:window-state', true));
  window.on('unmaximize', () => window?.webContents.send('linksunder:window-state', false));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  window.webContents.session.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({
      defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())),
    });
  });
  window.once('ready-to-show', () => window.show());
  await window.loadURL(origin);
}

function restoreVersionedAppImagePath() {
  const previousPath = process.env.APPIMAGE;
  if (process.platform !== 'linux' || !previousPath || fs.existsSync(previousPath)) return;
  try {
    const directory = path.dirname(previousPath);
    const currentPrefix = `LinkSunder-${app.getVersion()}-Linux-`;
    const currentName = fs.readdirSync(directory).find((name) => name.startsWith(currentPrefix) && name.toLowerCase().endsWith('.appimage'));
    if (!currentName) return;
    const currentPath = path.join(directory, currentName);
    const file = fs.statSync(currentPath);
    if (file.isFile() && (file.mode & 0o111) !== 0) process.env.APPIMAGE = currentPath;
  } catch {
    // Keep manual-update mode if the installed AppImage cannot be located safely.
  }
}

function updateSupport() {
  restoreVersionedAppImagePath();
  if (!app.isPackaged) return { supported: false, reason: 'In-app updates are available in supported installed desktop packages.' };
  if (process.platform === 'win32') {
    const installDirectory = path.dirname(app.getPath('exe'));
    const uninstaller = path.join(installDirectory, 'Uninstall LinkSunder.exe');
    return fs.existsSync(uninstaller)
      ? { supported: true, reason: 'Windows NSIS installer.' }
      : { supported: false, reason: 'This Windows portable ZIP must be updated manually from the official releases page.' };
  }
  if (process.platform === 'linux' && process.env.APPIMAGE && fs.existsSync(process.env.APPIMAGE))
    return { supported: true, reason: 'Linux AppImage.' };
  if (process.platform === 'linux')
    return { supported: false, reason: 'Linux DEB packages are updated manually through the system package installer to preserve its permission and signature protections.' };
  return { supported: false, reason: 'This package uses manual updates from the official releases page.' };
}

function createUpdateController() {
  const support = updateSupport();
  updateController = new UpdateController({
    updater: autoUpdater,
    tokenFactory: () => new CancellationToken(),
    initialState: {
      currentVersion: app.getVersion(),
      supported: support.supported,
      supportReason: support.reason,
      status: support.supported ? 'idle' : 'unsupported',
      message: support.supported ? 'Check for updates when you are ready. LinkSunder does not check automatically.' : support.reason,
    },
    publish: (state) => {
      if (window && !window.isDestroyed()) window.webContents.send('linksunder:update-state', state);
    },
    getOperations: async () => {
      try {
        const response = await globalThis.fetch(`${origin}/api/operations`);
        if (!response.ok) return { busy: true, message: 'LinkSunder could not confirm that reports are idle. Close any active work before installing.' };
        return await response.json();
      } catch {
        return { busy: true, message: 'LinkSunder could not confirm that reports are idle. Close any active work before installing.' };
      }
    },
    confirmInstall: async () => {
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Restart to install LinkSunder update',
        message: 'Restart LinkSunder and install the downloaded update?',
        detail: 'Saved reports, preferences, and scenarios remain on this computer. Any unsaved edits in the current window will be lost.',
        buttons: ['Install later', 'Restart & install'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    },
  });
}

function isTrustedWindow(event) {
  if (!window || event.sender !== window.webContents) return false;
  try {
    return new URL(event.senderFrame.url).origin === origin;
  } catch {
    return false;
  }
}

function registerWindowIpc() {
  ipcMain.handle('linksunder:choose-report-directory', async (event) => {
    if (!isTrustedWindow(event)) return undefined;
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose report storage folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle('linksunder:open-report-directory', async (event) => {
    if (!isTrustedWindow(event)) return { ok: false, error: 'The request did not come from LinkSunder.' };
    let directory = path.join(app.getPath('userData'), 'reports');
    try {
      const preferences = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
      if (typeof preferences.reportDirectory === 'string' && path.isAbsolute(preferences.reportDirectory))
        directory = preferences.reportDirectory;
    } catch {
      /* Use the default reports folder before preferences have been saved. */
    }
    const error = await shell.openPath(directory);
    return error ? { ok: false, error } : { ok: true };
  });
  ipcMain.handle('linksunder:choose-geolocation-database', async (event, kind) => {
    if (!isTrustedWindow(event) || !['city', 'asn'].includes(kind)) return undefined;
    const result = await dialog.showOpenDialog(window, {
      title: `Choose a MaxMind ${kind === 'city' ? 'City' : 'ASN'} database`,
      properties: ['openFile'],
      filters: [{ name: 'MaxMind database', extensions: ['mmdb'] }],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle('linksunder:open-geolocation-signup', (event) => {
    if (isTrustedWindow(event)) void shell.openExternal('https://www.maxmind.com/en/geolite2/signup');
  });
  ipcMain.handle('linksunder:open-release-page', (event) => {
    if (isTrustedWindow(event)) void shell.openExternal('https://github.com/kavianpcx/linksunder/releases');
  });
  ipcMain.handle('linksunder:update-state', (event) =>
    isTrustedWindow(event) ? updateController?.getState() : undefined,
  );
  ipcMain.handle('linksunder:check-updates', async (event) =>
    isTrustedWindow(event) ? updateController?.check() : undefined,
  );
  ipcMain.handle('linksunder:download-update', async (event) =>
    isTrustedWindow(event) ? updateController?.download() : undefined,
  );
  ipcMain.handle('linksunder:cancel-update-download', (event) =>
    isTrustedWindow(event) ? updateController?.cancelDownload() : false,
  );
  ipcMain.handle('linksunder:install-update', async (event) =>
    isTrustedWindow(event) ? updateController?.install() : false,
  );
  ipcMain.handle('linksunder:is-maximized', (event) =>
    isTrustedWindow(event) ? window.isMaximized() : false,
  );
  ipcMain.handle('linksunder:toggle-maximize', (event) => {
    if (!isTrustedWindow(event)) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });
  ipcMain.on('linksunder:minimize', (event) => {
    if (isTrustedWindow(event)) window.minimize();
  });
  ipcMain.on('linksunder:close', (event) => {
    if (isTrustedWindow(event)) window.close();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  updateController?.cancelDownload();
  if (!engine || engineExited || shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  engine.once('exit', () => app.quit());
  engine.kill();
  setTimeout(() => app.exit(0), 5000).unref();
});

