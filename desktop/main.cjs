const { app, BrowserWindow, dialog, utilityProcess, Menu, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { URL } = require('node:url');
const { setTimeout, clearTimeout } = require('node:timers');
const net = require('node:net');

let engine;
let window;
let origin = '';
let shuttingDown = false;
let engineExited = false;
app.setName('LinkSunder');
if (process.env.LINKSUNDER_DESKTOP_DATA)
  app.setPath('userData', process.env.LINKSUNDER_DESKTOP_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app
    .whenReady()
    .then(start)
    .catch(() => {
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
  if (!engine || engineExited || shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  engine.once('exit', () => app.quit());
  engine.kill();
  setTimeout(() => app.exit(0), 5000).unref();
});
