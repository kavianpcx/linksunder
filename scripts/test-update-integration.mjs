/* global window, document, location */
import assert from 'node:assert/strict';
import console from 'node:console';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { URL } from 'node:url';
import { chromium, _electron as electron } from 'playwright';

const oldVersion = '0.4.0';
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const currentVersion = packageJson.version;
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : undefined;
assert.ok(platform, 'The cross-version update test supports Windows NSIS and Linux AppImage only.');
assert.equal(process.env.CI, 'true', 'This destructive-to-installation test must run only on an isolated CI runner.');

const testRoot = await mkdtemp(path.join(tmpdir(), 'linksunder-update-integration-'));
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
let oldApp;
let updatedBrowser;
let updatedPage;
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

async function downloadOldRelease() {
  const response = await fetch(`https://github.com/kavianpcx/linksunder/releases/download/v${oldVersion}/${oldAssetName}`);
  if (!response.ok || !response.body) throw new Error(`Could not download the published ${oldVersion} test package (${response.status}).`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(oldAssetPath));
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
    latest = await readValue();
    if (predicate(latest)) return latest;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${description}. Last value: ${JSON.stringify(latest)}`);
}

async function updateState(page) {
  return page.evaluate(() => window.linksunderDesktop.getUpdateState());
}

async function connectToUpdatedApp(port) {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 180000;
  let browser;
  while (Date.now() < deadline) {
    if (!browser) {
      try {
        browser = await chromium.connectOverCDP(endpoint, { timeout: 2000 });
      } catch {
        await delay(500);
        continue;
      }
    }
    const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('http://127.0.0.1:'));
    if (page) return { browser, page };
    if (!browser.isConnected()) browser = undefined;
    await delay(500);
  }
  throw new Error('The updated application did not restart with its isolated verification window.');
}

async function prepareOldInstallation(feedUrl) {
  await downloadOldRelease();
  if (platform === 'windows') {
    await runProcess(oldAssetPath, ['/S', `/D=${installDirectory}`], { timeout: 180000 });
    const updateConfig = path.join(installDirectory, 'resources', configName);
    await writeFile(updateConfig, `provider: generic\nurl: ${feedUrl}\nupdaterCacheDirName: linksunder-update-integration\nchannel: latest\n`, 'utf8');
    windowsUninstaller = path.join(installDirectory, 'Uninstall LinkSunder.exe');
    return path.join(installDirectory, 'LinkSunder.exe');
  }

  appImagePath = path.join(testRoot, oldAssetName);
  await chmod(appImagePath, 0o755);
  await runProcess(appImagePath, ['--appimage-extract'], { cwd: testRoot, env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' }, timeout: 180000 });
  const extractedRoot = path.join(testRoot, 'squashfs-root');
  await writeFile(path.join(extractedRoot, 'resources', configName), `provider: generic\nurl: ${feedUrl}\nupdaterCacheDirName: linksunder-update-integration\nchannel: latest\n`, 'utf8');
  return path.join(extractedRoot, 'AppRun');
}

async function stopUpdatedApp() {
  if (!updatedPage || updatedPage.isClosed()) return;
  await updatedPage.evaluate(() => window.linksunderDesktop.close()).catch(() => {});
  await updatedBrowser?.close().catch(() => {});
  updatedPage = undefined;
  updatedBrowser = undefined;
}

try {
  const feed = await startFeedServer();
  const oldExecutable = await prepareOldInstallation(feed.url);
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
    CI: 'true',
    ...(platform === 'windows'
      ? { LOCALAPPDATA: path.join(testRoot, 'local-app-data'), APPDATA: path.join(testRoot, 'roaming-app-data') }
      : {
          XDG_CONFIG_HOME: path.join(testRoot, 'config'),
          XDG_CACHE_HOME: cacheDirectory,
          APPIMAGE: appImagePath,
          APPIMAGE_EXTRACT_AND_RUN: '1',
          APPDIR: path.join(testRoot, 'squashfs-root'),
        }),
  };
  oldApp = await electron.launch({
    executablePath: oldExecutable,
    args: [`--remote-debugging-port=${debugPort}`],
    env: appEnvironment,
    timeout: 90000,
  });
  const page = await oldApp.firstWindow({ timeout: 90000 });
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
  await waitUntil('the report to finish', async () => page.evaluate(async (id) => (await fetch(`/api/runs/${id}`).then((response) => response.json())).status, created.id), (status) => status !== 'running', 60000);
  await page.getByRole('button', { name: 'Light appearance', exact: true }).click();
  await waitUntil('the light preference to apply', () => page.evaluate(() => document.documentElement.dataset.theme), (theme) => theme === 'light');
  const originBeforeUpdate = new URL(page.url()).origin;

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Check for Updates', exact: true }).click();
  const available = await waitUntil('v0.5.0 to be discovered', () => updateState(page), (state) => state.status === 'available' || state.status === 'error');
  assert.equal(available.status, 'available', `Update discovery failed: ${available.message}`);
  assert.equal(available.latestVersion, currentVersion);
  assert.equal(available.downloadSize, packageInfo.size);

  await page.getByRole('button', { name: 'Download Update', exact: true }).click();
  await waitUntil('download progress to advance', () => updateState(page), (state) => state.status === 'downloading' && (state.progress?.transferred || 0) > 0, 90000);
  await page.getByRole('button', { name: 'Cancel Download', exact: true }).click();
  const cancelled = await waitUntil('the download cancellation', () => updateState(page), (state) => state.status === 'cancelled' || state.status === 'error', 30000);
  assert.equal(cancelled.status, 'cancelled', `The update download did not cancel cleanly: ${cancelled.message}`);
  assert.equal((await updateState(page)).currentVersion, oldVersion);

  await page.getByRole('button', { name: 'Retry Download', exact: true }).click();
  const ready = await waitUntil('the retry to download and verify the package', () => updateState(page), (state) => state.status === 'ready' || state.status === 'error', 600000);
  assert.equal(ready.status, 'ready', `The update did not pass package verification: ${ready.message}`);
  assert.ok(feed.requests.length >= 2, 'Cancel and retry should issue separate package requests.');
  assert.equal(feed.requests[1].rangeStart, 0, 'A cancelled partial package must be discarded; retry must start at byte zero.');

  await oldApp.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  const oldAppClosed = oldApp.waitForEvent('close', { timeout: 240000 });
  await page.getByRole('button', { name: 'Restart & Install', exact: true }).click();
  await oldAppClosed;
  const updated = await connectToUpdatedApp(debugPort);
  updatedBrowser = updated.browser;
  updatedPage = updated.page;
  await updatedPage.getByRole('heading', { name: 'Build for the unexpected.' }).waitFor({ timeout: 60000 });
  const finalState = await waitUntil('the installed version to change', () => updateState(updatedPage), (state) => state.currentVersion === currentVersion, 60000);
  assert.equal(finalState.currentVersion, currentVersion);
  assert.equal(new URL(updatedPage.url()).origin, originBeforeUpdate, 'The isolated engine should retain its saved local port and browser preferences.');
  await waitUntil('the light appearance preference to survive the update', () => updatedPage.evaluate(() => document.documentElement.dataset.theme), (theme) => theme === 'light', 30000);
  const persistedReport = await updatedPage.evaluate(async (id) => {
    const response = await fetch(`/api/runs/${id}`);
    return response.ok ? response.json() : undefined;
  }, created.id);
  assert.equal(persistedReport?.title, sentinel, 'The v0.4.0 report must remain available after installing v0.5.0.');
  console.log(`Cross-version updater passed: v${oldVersion} -> v${currentVersion}; progress, cancel, fresh retry, SHA-512 verification, install, report and preference persistence.`);
} finally {
  await stopUpdatedApp();
  await oldApp?.close().catch(() => {});
  if (windowsUninstaller) await runProcess(windowsUninstaller, ['/S'], { timeout: 60000 }).catch(() => {});
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await rm(testRoot, { recursive: true, force: true });
}

