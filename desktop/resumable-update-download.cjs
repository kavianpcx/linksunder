const { createHash } = require('node:crypto');
const { Buffer } = require('node:buffer');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const { gunzipSync, gzipSync, inflateRawSync } = require('node:zlib');
const { computeOperations, OperationKind } = require('electron-updater/out/differentialDownloader/downloadPlanBuilder');

const CHUNK_SIZE = 1024 * 1024;
const MAX_BLOCKMAP_BYTES = 32 * 1024 * 1024;

function parseBlockMap(value, source) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.files) || value.files.length !== 1)
    throw new Error(`The update blockmap from ${source} is invalid.`);
  const file = value.files[0];
  if (typeof file.name !== 'string' || !Array.isArray(file.sizes) || !Array.isArray(file.checksums) ||
      file.sizes.length !== file.checksums.length || file.sizes.some((size) => !Number.isInteger(size) || size <= 0) ||
      file.checksums.some((checksum) => typeof checksum !== 'string'))
    throw new Error(`The update blockmap from ${source} is invalid.`);
  return value;
}

function assertTrustedUrl(value, allowLocalhost = false) {
  const url = value instanceof URL ? value : new URL(value);
  if (url.username || url.password) throw new Error('The update URL cannot contain credentials.');
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  const githubHost = url.hostname === 'github.com' || url.hostname === 'api.github.com' ||
    url.hostname === 'release-assets.githubusercontent.com' || url.hostname.endsWith('.githubusercontent.com');
  if (url.protocol !== 'https:' && !(allowLocalhost && localHost && url.protocol === 'http:'))
    throw new Error('The update source must use HTTPS.');
  if (!(allowLocalhost && localHost) && !githubHost)
    throw new Error('The update source is not an official GitHub release host.');
  return url;
}

async function trustedFetch(value, options, fetchImpl, allowLocalhost) {
  let url = assertTrustedUrl(value, allowLocalhost);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetchImpl(url, { ...options, redirect: 'manual' });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = assertTrustedUrl(new URL(location, url), allowLocalhost);
      continue;
    }
    assertTrustedUrl(response.url || url, allowLocalhost);
    return response;
  }
  throw new Error('The update source redirected too many times.');
}

async function readLimited(response, maximum) {
  if (!response.body) throw new Error('The update source returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new Error('The update metadata is larger than the supported limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function responseBuffer(url, { headers, signal } = {}, fetchImpl = globalThis.fetch, allowLocalhost = false) {
  const response = await trustedFetch(url, { headers, signal }, fetchImpl, allowLocalhost);
  if (!response.ok) throw new Error(`Could not read update metadata (HTTP ${response.status}).`);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BLOCKMAP_BYTES)
    throw new Error('The update blockmap is larger than the supported limit.');
  const buffer = await readLimited(response, MAX_BLOCKMAP_BYTES);
  if (buffer.length === 0 || buffer.length > MAX_BLOCKMAP_BYTES)
    throw new Error('The update blockmap is empty or too large.');
  return buffer;
}

async function embeddedBlockMap(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 8) throw new Error('The installed AppImage has no embedded update blockmap.');
    const footer = Buffer.alloc(4);
    await handle.read(footer, 0, footer.length, size - footer.length);
    const length = footer.readUInt32BE(0);
    if (length < 1 || length > MAX_BLOCKMAP_BYTES || length + 4 >= size)
      throw new Error('The installed AppImage has an invalid embedded update blockmap.');
    const compressed = Buffer.alloc(length);
    await handle.read(compressed, 0, compressed.length, size - 4 - length);
    return parseBlockMap(JSON.parse(inflateRawSync(compressed).toString('utf8')), path.basename(file));
  } finally {
    await handle.close();
  }
}

async function hashFile(file, shouldCancel = () => false) {
  const hash = createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) {
    if (shouldCancel()) throw Object.assign(new Error('The update verification was cancelled.'), { name: 'AbortError' });
    hash.update(chunk);
  }
  return hash.digest('base64');
}

function getFileName(url) {
  const name = path.posix.basename(new URL(url).pathname);
  const decoded = decodeURIComponent(name);
  if (!decoded || decoded === '.' || decoded === '..' || path.basename(decoded) !== decoded)
    throw new Error('The update package name is invalid.');
  return decoded;
}

function operationLength(operation) {
  return operation.end - operation.start;
}

function safeOperations(operations, fileSize, baseSize) {
  if (!Array.isArray(operations) || operations.length === 0) throw new Error('The update blockmap produced no operations.');
  let total = 0;
  for (const operation of operations) {
    const length = operationLength(operation);
    if (!Number.isInteger(operation.start) || !Number.isInteger(operation.end) || length <= 0)
      throw new Error('The update blockmap contains an invalid byte range.');
    if (operation.kind === OperationKind.DOWNLOAD) {
      if (operation.start < 0 || operation.end > fileSize) throw new Error('The update blockmap requests bytes outside the new package.');
    } else if (operation.kind === OperationKind.COPY) {
      if (operation.start < 0 || operation.end > baseSize) throw new Error('The update blockmap requests bytes outside the installed package.');
    } else {
      throw new Error('The update blockmap contains an unknown operation.');
    }
    total += length;
  }
  if (total !== fileSize) throw new Error('The update blockmap does not describe the full package.');
  return operations;
}

async function writeAt(file, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, position + offset);
    if (bytesWritten <= 0) throw new Error('Could not write the update package.');
    offset += bytesWritten;
  }
}

class ResumableUpdateDownload {
  constructor({ updater, directory, platform = process.platform, getAppImagePath = () => process.env.APPIMAGE, chunkSize = CHUNK_SIZE, fetchImpl = globalThis.fetch, allowLocalhost = false }) {
    this.updater = updater;
    this.directory = directory;
    this.statePath = path.join(directory, 'download-state.json');
    this.partialPath = path.join(directory, 'package.partial');
    this.blockMapPath = path.join(directory, 'new-blockmap.json');
    this.platform = platform;
    this.getAppImagePath = getAppImagePath;
    this.chunkSize = chunkSize;
    this.fetchImpl = fetchImpl;
    this.allowLocalhost = allowLocalhost;
    this.controller = undefined;
    this.pauseRequested = false;
    this.cancelRequested = false;
    this.activePromise = undefined;
  }

  readState() {
    try {
      const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (state?.schema === 1 && typeof state.version === 'string' && Number.isInteger(state.size) &&
          Number.isInteger(state.operationIndex) && Number.isInteger(state.operationOffset) &&
          Array.isArray(state.operations)) return state;
    } catch {
      return undefined;
    }
    return undefined;
  }

  getSavedDownload() {
    const state = this.readState();
    if (!state || !fs.existsSync(this.partialPath)) return undefined;
    return {
      version: state.version,
      progress: this.progressFor(state),
    };
  }

  progressFor(state) {
    const percent = state.size > 0 ? Math.max(0, Math.min(100, state.completedBytes / state.size * 100)) : 0;
    return {
      percent,
      transferred: Math.max(0, state.completedBytes || 0),
      total: Math.max(0, state.size || 0),
      bytesPerSecond: Math.max(0, state.bytesPerSecond || 0),
    };
  }

  async matches(updateInfoAndProvider) {
    const state = this.readState();
    if (!state || !fs.existsSync(this.partialPath)) return false;
    try {
      const fileInfo = this.resolveFile(updateInfoAndProvider);
      return state.version === updateInfoAndProvider.info.version &&
        state.url === fileInfo.url.href && state.sha512 === fileInfo.info.sha512 &&
        state.size === fileInfo.info.size;
    } catch {
      return false;
    }
  }

  resolveFile(updateInfoAndProvider) {
    const info = updateInfoAndProvider?.info;
    const provider = updateInfoAndProvider?.provider;
    if (!info || !provider || typeof provider.resolveFiles !== 'function')
      throw new Error('The official update file information is unavailable.');
    const extension = this.platform === 'win32' ? '.exe' : this.platform === 'linux' ? '.appimage' : '';
    if (!extension) throw new Error('This package does not support in-app updates.');
    const files = provider.resolveFiles(info);
    const fileInfo = files.find((file) => file.url.pathname.toLowerCase().endsWith(extension));
    if (!fileInfo || !fileInfo.info || !Number.isInteger(fileInfo.info.size) || fileInfo.info.size <= 0 ||
        typeof fileInfo.info.sha512 !== 'string')
      throw new Error('The official release does not include a valid update package.');
    assertTrustedUrl(fileInfo.url, this.allowLocalhost);
    return fileInfo;
  }

  async sameBase(state) {
    if (!state.baseFile) return state.mode === 'full';
    try {
      const info = await fsp.stat(state.baseFile);
      return info.isFile() && info.size === state.baseSize && info.mtimeMs === state.baseMtimeMs;
    } catch {
      return false;
    }
  }

  async validSavedState(updateInfoAndProvider, fileInfo) {
    const state = this.readState();
    if (!state || !fs.existsSync(this.partialPath) || state.mode === 'differential' && !fs.existsSync(this.blockMapPath))
      return undefined;
    if (state.version !== updateInfoAndProvider.info.version || state.url !== fileInfo.url.href ||
        state.sha512 !== fileInfo.info.sha512 || state.size !== fileInfo.info.size ||
        !(await this.sameBase(state))) return undefined;
    try {
      if (!['full', 'differential'].includes(state.mode) || !Array.isArray(state.operations) ||
          !Number.isInteger(state.operationIndex) || state.operationIndex < 0 || state.operationIndex > state.operations.length ||
          !Number.isInteger(state.operationOffset) || state.operationOffset < 0 ||
          !Number.isInteger(state.completedBytes) || state.completedBytes < 0 || state.completedBytes > state.size ||
          !Number.isInteger(state.baseSize ?? 0) || (state.mode === 'differential' && (!state.baseFile || !path.isAbsolute(state.baseFile))))
        return undefined;
      safeOperations(state.operations, state.size, state.baseSize || 0);
      if (state.mode === 'full' && state.operations.some((operation) => operation.kind !== OperationKind.DOWNLOAD))
        return undefined;
      let completed = 0;
      for (let index = 0; index < state.operationIndex; index += 1) completed += operationLength(state.operations[index]);
      if (state.operationIndex === state.operations.length) {
        if (state.operationOffset !== 0) return undefined;
      } else if (state.operationOffset >= operationLength(state.operations[state.operationIndex])) {
        return undefined;
      } else {
        completed += state.operationOffset;
      }
      if (completed !== state.completedBytes) return undefined;
    } catch {
      return undefined;
    }
    const stat = await fsp.stat(this.partialPath);
    if (!stat.isFile()) return undefined;
    return state;
  }

  async loadCachedBlockMap(helper) {
    try {
      const raw = await fsp.readFile(path.join(helper.cacheDir, 'current.blockmap'));
      return parseBlockMap(JSON.parse(gunzipSync(raw).toString('utf8')), 'the local update cache');
    } catch {
      return undefined;
    }
  }

  async cachedWindowsBase(helper, currentVersion) {
    try {
      const metadataPath = path.join(helper.cacheDirForPendingUpdate, 'update-info.json');
      const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
      if (typeof metadata.fileName !== 'string' || path.basename(metadata.fileName) !== metadata.fileName ||
          metadata.fileName !== `LinkSunder-${currentVersion}-Windows-x64.exe` || typeof metadata.sha512 !== 'string') return undefined;
      const file = path.join(helper.cacheDirForPendingUpdate, metadata.fileName);
      const info = await fsp.stat(file);
      if (!info.isFile() || info.size <= 0 || await hashFile(file) !== metadata.sha512) return undefined;
      return { file, stat: info };
    } catch {
      return undefined;
    }
  }

  async getBlockMapForWindows(fileInfo, info, provider, helper, currentVersion) {
    const base = await this.cachedWindowsBase(helper, currentVersion);
    if (!base) return undefined;
    const urls = provider.getBlockMapFiles(fileInfo.url, currentVersion, info.version);
    let oldMap = await this.loadCachedBlockMap(helper);
    if (!oldMap) oldMap = parseBlockMap(JSON.parse(gunzipSync(await responseBuffer(urls[0], { signal: this.controller.signal }, this.fetchImpl, this.allowLocalhost)).toString('utf8')), 'the previous release');
    const newMap = parseBlockMap(JSON.parse(gunzipSync(await responseBuffer(urls[1], { signal: this.controller.signal }, this.fetchImpl, this.allowLocalhost)).toString('utf8')), 'the new release');
    return { oldMap, newMap, baseFile: base.file, baseStat: base.stat };
  }

  async getBlockMapForAppImage(fileInfo) {
    const baseFile = this.getAppImagePath();
    if (!baseFile || !path.isAbsolute(baseFile) || !fs.existsSync(baseFile)) return undefined;
    const oldMap = await embeddedBlockMap(baseFile);
    const blockMapSize = Number(fileInfo.info.blockMapSize);
    const fileSize = fileInfo.info.size;
    if (!Number.isInteger(blockMapSize) || blockMapSize < 1 || blockMapSize > MAX_BLOCKMAP_BYTES || blockMapSize + 4 >= fileSize)
      return undefined;
    const start = fileSize - blockMapSize - 4;
    const response = await trustedFetch(fileInfo.url, {
      headers: { range: `bytes=${start}-${fileSize - 1}` },
      signal: this.controller.signal,
    }, this.fetchImpl, this.allowLocalhost);
    if (response.status !== 206) throw new Error('The release server did not honor the AppImage blockmap range.');
    const contentRange = response.headers.get('content-range') || '';
    if (!new RegExp(`^bytes ${start}-${fileSize - 1}/${fileSize}$`).test(contentRange))
      throw new Error('The AppImage blockmap range did not match the release metadata.');
    const compressedWithFooter = await readLimited(response, blockMapSize + 4);
    if (compressedWithFooter.length !== blockMapSize + 4) throw new Error('The AppImage blockmap has an unexpected length.');
    const newMap = parseBlockMap(JSON.parse(inflateRawSync(compressedWithFooter.subarray(0, -4)).toString('utf8')), 'the new AppImage');
    return {
      oldMap,
      newMap,
      baseFile,
      baseStat: await fsp.stat(baseFile),
      metadataRange: { start, end: fileSize },
    };
  }

  async createPlan(updateInfoAndProvider, fileInfo, helper, currentVersion) {
    const info = updateInfoAndProvider.info;
    let maps;
    try {
      maps = this.platform === 'linux'
        ? await this.getBlockMapForAppImage(fileInfo)
        : await this.getBlockMapForWindows(fileInfo, info, updateInfoAndProvider.provider, helper, currentVersion);
      if (maps) {
        const operations = computeOperations(
          maps.oldMap,
          maps.newMap,
          { info: () => undefined, warn: () => undefined, error: () => undefined },
        );
        if (maps.metadataRange) {
          safeOperations(operations, maps.metadataRange.start, maps.baseStat.size);
          operations.push({ kind: OperationKind.DOWNLOAD, ...maps.metadataRange });
        }
        safeOperations(operations, fileInfo.info.size, maps.baseStat.size);
        const networkBytes = operations.reduce((sum, operation) => sum + (operation.kind === OperationKind.DOWNLOAD ? operationLength(operation) : 0), 0);
        if (networkBytes < fileInfo.info.size * 0.95) {
          await fsp.writeFile(this.blockMapPath, JSON.stringify(maps.newMap));
          return {
            mode: 'differential', operations, baseFile: maps.baseFile,
            baseSize: maps.baseStat.size, baseMtimeMs: maps.baseStat.mtimeMs,
          };
        }
      }
    } catch (error) {
      if (error?.name === 'AbortError' && this.pauseRequested) throw error;
      // Missing old packages or blockmaps are expected for direct installs; use a resumable full package download.
    }
    return { mode: 'full', operations: [{ kind: OperationKind.DOWNLOAD, start: 0, end: fileInfo.info.size }] };
  }

  async saveState() {
    await fsp.mkdir(this.directory, { recursive: true });
    const temporary = `${this.statePath}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(this.state));
    await fsp.rename(temporary, this.statePath);
  }

  async discard() {
    await Promise.all([
      fsp.rm(this.statePath, { force: true }),
      fsp.rm(`${this.statePath}.tmp`, { force: true }),
      fsp.rm(this.partialPath, { force: true }),
      fsp.rm(this.blockMapPath, { force: true }),
    ]);
    this.state = undefined;
  }

  pause() {
    this.pauseRequested = true;
    this.controller?.abort();
  }

  cancel() {
    this.cancelRequested = true;
    this.controller?.abort();
  }

  async sendRangeChunk(url, start, length, totalSize, signal, output, destination) {
    const end = start + length - 1;
    const response = await trustedFetch(url, {
      headers: { range: `bytes=${start}-${end}` },
      signal,
    }, this.fetchImpl, this.allowLocalhost);
    if (response.status !== 206) throw new Error(`The release server could not resume this update range (HTTP ${response.status}).`);
    const range = response.headers.get('content-range') || '';
    if (range !== `bytes ${start}-${end}/${totalSize}`) throw new Error('The release server returned a different update range.');
    let received = 0;
    for await (const chunk of response.body) {
      const data = Buffer.from(chunk);
      if (received + data.length > length) throw new Error('The release server returned more update bytes than requested.');
      await writeAt(output, data, destination + received);
      received += data.length;
    }
    if (received !== length) throw new Error('The release server ended an update range before all bytes arrived.');
  }

  async executePlan(fileInfo, onProgress) {
    const saved = this.state;
    const output = await fsp.open(this.partialPath, fs.existsSync(this.partialPath) ? 'r+' : 'w+');
    let base;
    const started = Date.now();
    const destinations = [];
    let position = 0;
    for (const operation of saved.operations) {
      destinations.push(position);
      position += operationLength(operation);
    }
    try {
      if (saved.baseFile) base = await fsp.open(saved.baseFile, 'r');
      while (saved.operationIndex < saved.operations.length) {
        if (this.cancelRequested) return { cancelled: true };
        if (this.pauseRequested) {
          await this.saveState();
          return { paused: true };
        }
        const operation = saved.operations[saved.operationIndex];
        const length = operationLength(operation);
        const remaining = length - saved.operationOffset;
        const chunkLength = Math.min(this.chunkSize, remaining);
        const destination = destinations[saved.operationIndex] + saved.operationOffset;
        if (operation.kind === OperationKind.COPY) {
          if (!base) throw new Error('The installed update package is no longer available.');
          const buffer = Buffer.allocUnsafe(chunkLength);
          const { bytesRead } = await base.read(buffer, 0, chunkLength, operation.start + saved.operationOffset);
          if (bytesRead !== chunkLength) throw new Error('The installed update package ended before the copy completed.');
          await writeAt(output, buffer, destination);
        } else {
          await this.sendRangeChunk(fileInfo.url, operation.start + saved.operationOffset, chunkLength, fileInfo.info.size, this.controller.signal, output, destination);
        }
        await output.sync();
        saved.operationOffset += chunkLength;
        saved.completedBytes += chunkLength;
        saved.bytesPerSecond = Math.max(0, Math.round(saved.completedBytes * 1000 / Math.max(1, Date.now() - started)));
        if (saved.operationOffset === length) {
          saved.operationIndex += 1;
          saved.operationOffset = 0;
        }
        await this.saveState();
        onProgress(this.progressFor(saved));
      }
      return { completed: true };
    } finally {
      await output.close();
      await base?.close();
    }
  }

  async finishUpdate(updateInfoAndProvider, fileInfo, helper) {
    const info = updateInfoAndProvider.info;
    if (this.cancelRequested) return false;
    if (await fsp.stat(this.partialPath).then((stat) => stat.size).catch(() => -1) !== fileInfo.info.size ||
        await hashFile(this.partialPath, () => this.cancelRequested) !== fileInfo.info.sha512 || this.cancelRequested) return false;
    const fileName = getFileName(fileInfo.url);
    const pendingDirectory = helper.cacheDirForPendingUpdate;
    await fsp.mkdir(pendingDirectory, { recursive: true });
    const updateFile = path.join(pendingDirectory, fileName);
    await fsp.rm(updateFile, { force: true });
    await fsp.rename(this.partialPath, updateFile);
    if (this.platform === 'linux') await fsp.chmod(updateFile, 0o755);
    const blockMap = this.state.blockMapPath && fs.existsSync(this.blockMapPath)
      ? parseBlockMap(JSON.parse(await fsp.readFile(this.blockMapPath, 'utf8')), 'the downloaded package')
      : undefined;
    if (blockMap) {
      const compressedMap = gzipSync(JSON.stringify(blockMap));
      await fsp.writeFile(path.join(helper.cacheDir, 'current.blockmap'), compressedMap);
      await fsp.writeFile(path.join(pendingDirectory, 'current.blockmap'), compressedMap);
    } else {
      await fsp.rm(path.join(helper.cacheDir, 'current.blockmap'), { force: true });
    }
    await helper.setDownloadedFile(updateFile, null, info, fileInfo, fileName, true);
    await this.discard();
    return true;
  }

  async download(updateInfoAndProvider, currentVersion, onProgress = () => undefined) {
    if (this.activePromise) return this.activePromise;
    this.pauseRequested = false;
    this.cancelRequested = false;
    this.controller = new globalThis.AbortController();
    this.activePromise = (async () => {
      const info = updateInfoAndProvider?.info;
      const fileInfo = this.resolveFile(updateInfoAndProvider);
      const helper = await this.updater.getOrCreateDownloadHelper();
      let state = await this.validSavedState(updateInfoAndProvider, fileInfo);
      if (!state) {
        await this.discard();
        await fsp.mkdir(this.directory, { recursive: true });
        const plan = await this.createPlan(updateInfoAndProvider, fileInfo, helper, currentVersion);
        if (this.cancelRequested) {
          await this.discard();
          return { cancelled: true };
        }
        this.state = {
          schema: 1,
          version: info.version,
          url: fileInfo.url.href,
          fileName: getFileName(fileInfo.url),
          sha512: fileInfo.info.sha512,
          size: fileInfo.info.size,
          mode: plan.mode,
          operations: plan.operations,
          baseFile: plan.baseFile,
          baseSize: plan.baseSize,
          baseMtimeMs: plan.baseMtimeMs,
          blockMapPath: plan.mode === 'differential' ? this.blockMapPath : undefined,
          operationIndex: 0,
          operationOffset: 0,
          completedBytes: 0,
          bytesPerSecond: 0,
        };
        await fsp.mkdir(this.directory, { recursive: true });
        await fsp.writeFile(this.partialPath, Buffer.alloc(0));
        await this.saveState();
      } else {
        this.state = state;
      }
      onProgress(this.progressFor(this.state));
      const result = await this.executePlan(fileInfo, onProgress);
      if (result.paused) return { paused: true, progress: this.progressFor(this.state) };
      if (result.cancelled || this.cancelRequested) {
        await this.discard();
        return { cancelled: true };
      }
      const finished = await this.finishUpdate(updateInfoAndProvider, fileInfo, helper);
      if (this.cancelRequested) {
        await this.discard();
        return { cancelled: true };
      }
      if (finished) return { downloaded: true };
      if (this.state.mode === 'differential') {
        await this.discard();
        this.state = {
          schema: 1,
          version: info.version,
          url: fileInfo.url.href,
          fileName: getFileName(fileInfo.url),
          sha512: fileInfo.info.sha512,
          size: fileInfo.info.size,
          mode: 'full',
          operations: [{ kind: OperationKind.DOWNLOAD, start: 0, end: fileInfo.info.size }],
          operationIndex: 0,
          operationOffset: 0,
          completedBytes: 0,
          bytesPerSecond: 0,
        };
        await fsp.writeFile(this.partialPath, Buffer.alloc(0));
        await this.saveState();
        const full = await this.executePlan(fileInfo, onProgress);
        if (full.paused) return { paused: true, progress: this.progressFor(this.state) };
        if (full.cancelled || this.cancelRequested) {
          await this.discard();
          return { cancelled: true };
        }
        const fullFinished = await this.finishUpdate(updateInfoAndProvider, fileInfo, helper);
        if (this.cancelRequested) {
          await this.discard();
          return { cancelled: true };
        }
        if (fullFinished) return { downloaded: true, usedFullFallback: true };
      }
      await this.discard();
      throw new Error('The downloaded package failed its release size or SHA-512 check. Retry the update.');
    })().finally(() => {
      this.controller = undefined;
      this.activePromise = undefined;
    });
    try {
      return await this.activePromise;
    } catch (error) {
      if (this.cancelRequested) {
        await this.discard();
        return { cancelled: true };
      }
      if (this.pauseRequested) {
        if (this.state) await this.saveState();
        return { paused: true, progress: this.state ? this.progressFor(this.state) : undefined };
      }
      throw error;
    }
  }
}

module.exports = { ResumableUpdateDownload, parseBlockMap, safeOperations };
