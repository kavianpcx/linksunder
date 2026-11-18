/* global window, document, location */
import assert from 'node:assert/strict';
import console from 'node:console';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { URL } from 'node:url';
import { chromium } from 'playwright';

const oldVersion = '0.4.0';
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const currentVersion = packageJson.version;
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : undefined;
assert.ok(platform, 'The cross-version update test supports Windows NSIS and Linux AppImage only.');
assert.equal(process.env.CI, 'true', 'This destructive-to-installation test must run only on an isolated CI runner.');

let currentPhase = 'initialize isolated test';
function phase(label) {
  currentPhase = label;
  console.log(`[update-integration] ${label}`);
}

function withTimeout(label, operation, timeoutMs = 15000) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out during ${currentPhase}: ${label}.`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

const watchdog = setTimeout(() => {
  console.error(`[update-integration] 30 minute safety limit reached during ${currentPhase}.`);
  try { oldProcess?.kill(); } catch { /* The app may already have exited. */ }
  try { void oldBrowser?.close(); } catch { /* The browser connection may already be closed. */ }
  process.exit(1);
}, 30 * 60 * 1000);

const testRoot = await mkdtemp(path.join(tmpdir(), 'linksunder-update-integration-'));
const quitLogPath = path.join(testRoot, 'update-quit-events.log');
const startupLogPath = path.join(testRoot, 'update-start-events.log');
const stopFilePath = path.join(testRoot, 'stop-updated-app');
await writeFile(quitLogPath, '', 'utf8');
await writeFile(startupLogPath, '', 'utf8');
assert.ok(path.resolve(testRoot).startsWith(path.resolve(tmpdir()) + path.sep));
assert.ok(path.basename(testRoot).startsWith('linksunder-update-integration-'));
const dataDirectory = path.join(testRoot, 'user-data');
const cacheDirectory = path.join(testRoot, 'updater-cache');
const installDirectory = path.join(testRoot, 'installed-app');
const feedDirectory = path.resolve('release');
const assetName = platform === 'windows'
  ? `LinkSunder-${currentVersion}-Windows-x64.exe`
  : `LinkSunder-${currentVersion}-Linux-x86_64.AppImage`;
const manifestName = platform === 'windows' ? 'latest.yml' : 'latest-linux.yml';
const oldAssetName = platform === 'windows'
  ? `LinkSunder-${oldVersion}-Windows-x64.exe`
  : `LinkSunder-${oldVersion}-Linux-x86_64.AppImage`;
const oldAssetPath = path.join(testRoot, oldAssetName);
const currentAssetPath = path.join(feedDirectory, assetName);
const manifestPath = path.join(feedDirectory, manifestName);
const configName = 'app-update.yml';
const packageInfo = await stat(currentAssetPath);
await stat(manifestPath);

let server;
let oldProcess;
let oldBrowser;
let appImagePath;
let windowsUninstaller;

function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(executable)} exited with ${signal || code}.`));
    });
  });
}


function waitForInspector(child, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for app inspector: ' + output)), timeoutMs);
    const onData = (chunk) => {
      output = (output + chunk.toString()).slice(-8000);
      const marker = 'Debugger listening on ';
      const start = output.indexOf(marker);
      if (start < 0) return;
      const url = output.slice(start + marker.length).split(/\s/)[0];
      if (!url.startsWith('ws://')) return;
      clearTimeout(timer);
      child.stderr?.off('data', onData);
      resolve(url);
    };
    child.stderr?.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error('App exited before inspector startup: ' + (signal || code)));
    });
  });
}

function evaluateMain(inspectorUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new globalThis.WebSocket(inspectorUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Timed out configuring the isolated update confirmation.'));
    }, 15000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true },
      }));
    }, { once: true });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); }
      catch (error) {
        clearTimeout(timer);
        socket.close();
        reject(error);
        return;
      }
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error || message.result?.exceptionDetails) {
        const details = message.result?.exceptionDetails;
        const description = details?.exception?.description || details?.text || 'The app inspector evaluation failed.';
        reject(new Error(message.error?.message || description));
      } else resolve(message.result?.result?.value);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Could not connect to the isolated app inspector.'));
    }, { once: true });
  });
}

async function downloadOldRelease() {
  phase(`download published v${oldVersion} package`);
  const response = await fetch(`https://github.com/kavianpcx/linksunder/releases/download/v${oldVersion}/${oldAssetName}`, {
    signal: globalThis.AbortSignal.timeout(180000),
  });
  if (!response.ok || !response.body) throw new Error(`Could not download the published ${oldVersion} test package (${response.status}).`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(oldAssetPath));
  phase(`prepare isolated v${oldVersion} installation`);
}

function startFeedServer() {
  const requests = [];
  server = createServer(async (request, response) => {
    const requestPath = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    const requestedName = path.posix.basename(requestPath);
    const isManifest = requestedName === manifestName;
    const isAsset = requestedName === assetName;
    if (!isManifest && !isAsset) {
      response.writeHead(404).end('Not found');
      return;
    }
    const filePath = isManifest ? manifestPath : currentAssetPath;
    const fileInfo = await stat(filePath);
    if (isManifest) {
      response.writeHead(200, { 'content-length': fileInfo.size, 'content-type': 'text/yaml', 'cache-control': 'no-store' });
      if (request.method === 'HEAD') response.end();
      else await pipeline(createReadStream(filePath), response).catch(() => {});
      return;
    }
    const range = request.headers.range;
    const match = typeof range === 'string' ? /^bytes=(\d+)-(\d*)$/.exec(range) : undefined;
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), fileInfo.size - 1) : fileInfo.size - 1;
    if (start > end || start >= fileInfo.size) {
      response.writeHead(416, { 'content-range': `bytes */${fileInfo.size}` }).end();
      return;
    }
    response.writeHead(match ? 206 : 200, {
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      ...(match ? { 'content-range': `bytes ${start}-${end}/${fileInfo.size}` } : {}),
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    requests.push({ rangeStart: start });
    const stream = createReadStream(filePath, { start, end, highWaterMark: 256 * 1024 });
    response.once('close', () => stream.destroy());
    try {
      if (requests.length === 1) {
        for await (const chunk of stream) {
          if (response.destroyed) break;
          if (!response.write(chunk)) await new Promise((resolve) => response.once('drain', resolve));
          await delay(100);
        }
        if (!response.destroyed) response.end();
      } else {
        await pipeline(stream, response);
      }
    } catch {
      if (!response.destroyed) response.destroy();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('Could not open the local update feed.'));
      else resolve({ url: `http://127.0.0.1:${address.port}/updates`, requests });
    });
  });
}

async function waitUntil(description, readValue, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await withTimeout(`read state while waiting for ${description}`, Promise.resolve().then(readValue));
    if (predicate(latest)) return latest;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${description}. Last value: ${JSON.stringify(latest)}`);
}

async function updateState(page) {
  return withTimeout('read updater state from the application', page.evaluate(() => window.linksunderDesktop.getUpdateState()));
}

async function connectToUpdatedApp(port) {
  phase('connect to the application window');
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  let browser;
  let pageUrls = [];
  try {
    while (Date.now() < deadline) {
      if (!browser) {
        try {
          browser = await chromium.connectOverCDP(endpoint, { timeout: 2000 });
        } catch {
          await delay(500);
          continue;
        }
      }
      const pages = browser.contexts().flatMap((context) => context.pages());
      pageUrls = pages.map((candidate) => candidate.url());
      const page = pages.find((candidate) => candidate.url().startsWith('http://127.0.0.1:'));
      if (page) return { browser, page };
      if (!browser.isConnected()) browser = undefined;
      await delay(500);
    }
    const startupEvents = await readFile(startupLogPath, 'utf8').catch((error) => 'Could not read startup events: ' + error.message);
    const quitEvents = await readFile(quitLogPath, 'utf8').catch((error) => 'Could not read quit events: ' + error.message);
    const debugEndpoints = await Promise.all(['json/version', 'json/list'].map(async (name) => {
      try {
        const response = await fetch(`${endpoint}/${name}`, { signal: globalThis.AbortSignal.timeout(1500) });
        return { name, status: response.status, body: (await response.text()).slice(0, 2000) };
      } catch (error) {
        return { name, error: error.message };
      }
    }));
    throw new Error('The updated application did not restart with its isolated verification window. Startup events: ' + (startupEvents || '(none)') + '; previous-app quit events: ' + (quitEvents || '(none)') + '; CDP pages: ' + JSON.stringify(pageUrls) + '; debug endpoints: ' + JSON.stringify(debugEndpoints));
  } catch (error) {
    if (browser) await withTimeout('close an unverified updated application', browser.close(), 10000).catch(() => {});
    throw error;
  }
}

async function prepareOldInstallation(feedUrl) {
  await downloadOldRelease();
  if (platform === 'windows') {
    phase(`install isolated v${oldVersion} Windows package`);
    await runProcess(oldAssetPath, ['/S', `/D=${installDirectory}`], { timeout: 180000 });
    const updateConfig = path.join(installDirectory, 'resources', configName);
    await writeFile(updateConfig, `provider: generic\nurl: ${feedUrl}\nupdaterCacheDirName: linksunder-update-integration\nchannel: latest\n`, 'utf8');
    windowsUninstaller = path.join(installDirectory, 'Uninstall LinkSunder.exe');
    return path.join(installDirectory, 'LinkSunder.exe');
  }

  phase(`extract isolated v${oldVersion} Linux package`);
  appImagePath = path.join(testRoot, oldAssetName);
  await chmod(appImagePath, 0o755);
  await runProcess(appImagePath, ['--appimage-extract'], { cwd: testRoot, env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' }, timeout: 180000 });
  const extractedRoot = path.join(testRoot, 'squashfs-root');
  const configCandidates = [path.join(extractedRoot, 'usr', 'resources', configName), path.join(extractedRoot, 'resources', configName)];
  let updateConfig;
  for (const candidate of configCandidates) {
    try {
      await access(candidate);
      updateConfig = candidate;
      break;
    } catch {
      // AppImage layouts place Electron resources under usr/resources or resources.
    }
  }
  assert.ok(updateConfig, 'The extracted v0.4.0 AppImage must contain resources/app-update.yml.');
  await writeFile(updateConfig, `provider: generic\nurl: ${feedUrl}\nupdaterCacheDirName: linksunder-update-integration\nchannel: latest\n`, 'utf8');
  return path.join(extractedRoot, 'AppRun');
}

async function readUpdatedStartupEvents() {
  const contents = await readFile(startupLogPath, 'utf8').catch(() => '');
  return contents.split(/\r?\n/).map((line) => {
    try { return JSON.parse(line); } catch { return undefined; }
  }).filter(Boolean);
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function stopUpdatedApplication() {
  const started = (await readUpdatedStartupEvents())
    .filter((entry) => entry.event === 'startup' && entry.version === currentVersion)
    .at(-1);
  if (!Number.isInteger(started?.pid) || started.pid === process.pid || !isProcessRunning(started.pid)) return;
  await writeFile(stopFilePath, 'stop', 'utf8');
  try {
    await waitUntil('the updated application to close', () => isProcessRunning(started.pid), (running) => !running, 15000);
  } catch {
    try { process.kill(started.pid); } catch { /* The isolated app may already have exited. */ }
    await waitUntil('the updated application process to stop', () => isProcessRunning(started.pid), (running) => !running, 5000).catch(() => {});
  }
}

try {
  phase('start local update feed');
  const feed = await startFeedServer();
  const oldExecutable = await prepareOldInstallation(feed.url);
  phase('prepare isolated restart diagnostics');
  const debugPortServer = createServer();
  await new Promise((resolve) => debugPortServer.listen(0, '127.0.0.1', resolve));
  const debugAddress = debugPortServer.address();
  assert.ok(debugAddress && typeof debugAddress !== 'string');
  const debugPort = debugAddress.port;
  await new Promise((resolve) => debugPortServer.close(resolve));

  const appEnvironment = {
    ...process.env,
    LINKSUNDER_DESKTOP_DATA: dataDirectory,
    LINKSUNDER_UPDATE_TEST_DEBUG_PORT: String(debugPort),
    LINKSUNDER_UPDATE_TEST_START_LOG: startupLogPath,
    LINKSUNDER_UPDATE_TEST_STOP_FILE: stopFilePath,
    CI: 'true',
    LINKSUNDER_UPDATE_TEST_QUIT_LOG: quitLogPath,
    ...(platform === 'windows'
      ? { LOCALAPPDATA: path.join(testRoot, 'local-app-data'), APPDATA: path.join(testRoot, 'roaming-app-data') }
      : {
          XDG_CONFIG_HOME: path.join(testRoot, 'config'),
          XDG_CACHE_HOME: cacheDirectory,
          APPIMAGE: appImagePath,
          // Let the new AppImage set its APPDIR; inheriting v0.4's extracted tree relaunches stale binaries.
          APPIMAGE_EXTRACT_AND_RUN: '1',
        }),
  };
  phase(`launch isolated v${oldVersion} application`);
  oldProcess = spawn(oldExecutable, ['--inspect=0', `--remote-debugging-port=${debugPort}`], {
    env: appEnvironment,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  const inspectorUrl = await waitForInspector(oldProcess);
  const opened = await connectToUpdatedApp(debugPort);
  oldBrowser = opened.browser;
  const page = opened.page;
  phase(`verify v${oldVersion} baseline and preserved report`);
  await page.getByRole('heading', { name: 'Build for the unexpected.' }).waitFor({ timeout: 30000 });
  const initialState = await updateState(page);
  assert.equal(initialState.currentVersion, oldVersion);
  assert.equal(initialState.supported, true);

  const sentinel = `Update persistence ${Date.now()}`;
  const created = await page.evaluate(async (title) => {
    const response = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-LinkSunder': 'local' },
      body: JSON.stringify({ name: title, url: `${location.origin}/demo/fixed`, externalConsent: true }),
    });
    if (!response.ok) throw new Error(`Could not create a persistence report: ${response.status}`);
    return response.json();
  }, sentinel);
  phase('wait for the baseline report to complete');
  await waitUntil('the report to finish', async () => page.evaluate(async (id) => (await fetch(`/api/runs/${id}`).then((response) => response.json())).status, created.id), (status) => status !== 'running', 60000);
  await page.getByRole('button', { name: 'Light appearance', exact: true }).click();
  await waitUntil('the light preference to apply', () => page.evaluate(() => document.documentElement.dataset.theme), (theme) => theme === 'light');
  const originBeforeUpdate = new URL(page.url()).origin;

  phase('check for the v0.5.0 update');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Check for Updates', exact: true }).click();
  const available = await waitUntil('v0.5.0 to be discovered', () => updateState(page), (state) => state.status === 'available' || state.status === 'error');
  assert.equal(available.status, 'available', `Update discovery failed: ${available.message}`);
  assert.equal(available.latestVersion, currentVersion);
  assert.equal(available.downloadSize, packageInfo.size);

  phase('download a partial update and confirm real progress');
  await page.getByRole('button', { name: 'Download Update', exact: true }).click();
  await waitUntil('download progress to advance', () => updateState(page), (state) => state.status === 'downloading' && (state.progress?.transferred || 0) > 0, 90000);
  phase('cancel the partial update download');
  await page.getByRole('button', { name: 'Cancel Download', exact: true }).click();
  const cancelled = await waitUntil('the download cancellation', () => updateState(page), (state) => state.status === 'cancelled' || state.status === 'error', 30000);
  assert.equal(cancelled.status, 'cancelled', `The update download did not cancel cleanly: ${cancelled.message}`);
  assert.equal((await updateState(page)).currentVersion, oldVersion);

  phase('retry from byte zero and verify the complete update');
  await page.getByRole('button', { name: 'Retry Download', exact: true }).click();
  const ready = await waitUntil('the retry to download and verify the package', () => updateState(page), (state) => state.status === 'ready' || state.status === 'error', 600000);
  assert.equal(ready.status, 'ready', `The update did not pass package verification: ${ready.message}`);
  assert.ok(feed.requests.length >= 2, 'Cancel and retry should issue separate package requests.');
  assert.equal(feed.requests[1].rangeStart, 0, 'A cancelled partial package must be discarded; retry must start at byte zero.');

  const confirmationExpression = [
    "const path = process.getBuiltinModule('node:path');",
    "const moduleApi = process.getBuiltinModule('node:module');",
    "const { app, dialog } = moduleApi.createRequire(path.join(process.resourcesPath, 'app.asar', 'desktop', 'main.cjs'))('electron');",
    "const fs = process.getBuiltinModule('node:fs');",
    "const record = (event) => fs.appendFileSync(process.env.LINKSUNDER_UPDATE_TEST_QUIT_LOG, event + String.fromCharCode(10));",
    "app.on('before-quit', () => record('before-quit'));",
    "app.on('will-quit', () => record('will-quit'));",
    "for (const method of ['quit', 'exit']) { const original = app[method].bind(app); app[method] = (...args) => { record(method + '(' + args.join(',') + ')'); return original(...args); } }",
    "dialog.showMessageBox = async () => ({ response: 1 });",
    "setTimeout(() => process.getBuiltinModule('node:inspector').close(), 500);",
    "'ready';",
  ].join('\n');
  const configured = await evaluateMain(inspectorUrl, confirmationExpression);
  assert.equal(configured, 'ready', 'The test could not configure the old app confirmation dialog.');
  await delay(600);
  phase('install the verified update and wait for v0.4.0 to close');
  const oldAppClosed = oldProcess.exitCode !== null || oldProcess.signalCode !== null
    ? Promise.resolve({ code: oldProcess.exitCode, signal: oldProcess.signalCode })
    : withTimeout('old app process exit', new Promise((resolve) => {
      oldProcess.once('exit', (code, signal) => resolve({ code, signal }));
    }), 30000);
  await page.getByRole('button', { name: 'Restart & Install', exact: true }).click();
  let oldExit;
  try {
    oldExit = await oldAppClosed;
  } catch (error) {
    const events = await readFile(quitLogPath, 'utf8').catch((readError) => 'Could not read quit events: ' + readError.message);
    assert.fail('The verified update did not close the previous app. Quit events: ' + (events || '(none)') + '; ' + error.message);
  }
  assert.equal(oldExit.code, 0, 'The previous app exited abnormally: ' + JSON.stringify(oldExit));
  await oldBrowser?.close().catch(() => {});
  oldBrowser = undefined;
  phase('verify the installed v0.5.0 window and retained settings');
  const startupEvents = await waitUntil(
    'the updated renderer to report its version and preferences',
    readUpdatedStartupEvents,
    (events) => events.some((entry) => entry.event === 'window-verification' && entry.version === currentVersion),
    90000,
  );
  const finalState = startupEvents.filter((entry) => entry.event === 'window-verification' && entry.version === currentVersion).at(-1);
  assert.equal(finalState.currentVersion, currentVersion);
  assert.equal(finalState.supported, true, 'The installed package must remain eligible for its next in-app update.');
  assert.equal(finalState.url, originBeforeUpdate, 'The isolated engine should retain its saved local port.');
  assert.equal(finalState.theme, 'light', 'The light appearance preference should survive the update.');
  const persistedReport = await waitUntil(
    'the previous report to remain available from the updated engine',
    async () => {
      try {
        const response = await fetch(new URL(`/api/runs/${created.id}`, originBeforeUpdate), {
          signal: globalThis.AbortSignal.timeout(3000),
        });
        return response.ok ? response.json() : undefined;
      } catch {
        return undefined;
      }
    },
    (report) => report?.title === sentinel,
    60000,
  );
  assert.equal(persistedReport?.title, sentinel, 'The v0.4.0 report must remain available after installing v0.5.0.');
  phase(`cross-version update passed: v${oldVersion} -> v${currentVersion}; progress, cancel, byte-zero retry, verification, install, report and preference persistence`);
} finally {
  phase('bounded isolated test cleanup');
  await withTimeout('close the updated application', stopUpdatedApplication(), 20000).catch((error) => console.warn(error.message));
  if (oldBrowser) await withTimeout('disconnect the previous app window', oldBrowser.close(), 10000).catch(() => {});
  if (oldProcess && oldProcess.exitCode === null && oldProcess.signalCode === null) {
    const oldProcessExit = new Promise((resolve) => oldProcess.once('exit', resolve));
    oldProcess.kill();
    await withTimeout('stop the previous app after failure', oldProcessExit, 10000).catch(() => {});
  }
  if (windowsUninstaller) await runProcess(windowsUninstaller, ['/S'], { timeout: 60000 }).catch(() => {});
  if (server?.listening) {
    server.closeAllConnections();
    await withTimeout('close the local update feed', new Promise((resolve) => server.close(resolve)), 10000).catch(() => {});
  }
  await withTimeout('remove the temporary installation', rm(testRoot, { recursive: true, force: true }), 60000).catch((error) => console.warn(error.message));
  clearTimeout(watchdog);
}
