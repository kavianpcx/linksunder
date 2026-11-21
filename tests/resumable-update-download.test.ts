import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { ResumableUpdateDownload } from '../desktop/resumable-update-download.cjs';

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const digest = (value: Buffer) => createHash('sha512').update(value).digest('base64');

async function fixture(withBase: boolean, redirectAssetTo?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'linksunder-resumable-update-'));
  roots.push(root);
  const cacheDir = path.join(root, 'updater-cache');
  const pendingDir = path.join(cacheDir, 'pending');
  await mkdir(pendingDir, { recursive: true });
  const oldPackage = Buffer.from('abcdefgh');
  const newPackage = Buffer.from('abcdWXYZ');
  const oldMap = { version: '2', files: [{ name: 'file', offset: 0, sizes: [4, 4], checksums: ['shared', 'old'] }] };
  const newMap = { version: '2', files: [{ name: 'file', offset: 0, sizes: [4, 4], checksums: ['shared', 'new'] }] };
  const rangeRequests: string[] = [];
  const server = createServer(async (request, response) => {
    const pathname = request.url || '';
    if (pathname.endsWith('0.5.0-Windows-x64.exe.blockmap')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(gzipSync(JSON.stringify(oldMap)));
      return;
    }
    if (pathname.endsWith('0.5.1-Windows-x64.exe.blockmap')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(gzipSync(JSON.stringify(newMap)));
      return;
    }
    if (!pathname.endsWith('0.5.1-Windows-x64.exe')) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (redirectAssetTo) {
      response.writeHead(302, { location: redirectAssetTo });
      response.end();
      return;
    }
    const header = request.headers.range || '';
    const match = /^bytes=(\d+)-(\d+)$/.exec(header);
    if (!match) {
      response.writeHead(400);
      response.end();
      return;
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    rangeRequests.push(header);
    response.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${newPackage.length}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
    });
    response.end(newPackage.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The test update server did not start.');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const updateUrl = `${baseUrl}/LinkSunder-0.5.1-Windows-x64.exe`;
  if (withBase) {
    await writeFile(path.join(pendingDir, 'LinkSunder-0.5.0-Windows-x64.exe'), oldPackage);
    await writeFile(path.join(pendingDir, 'update-info.json'), JSON.stringify({
      fileName: 'LinkSunder-0.5.0-Windows-x64.exe',
      sha512: digest(oldPackage),
    }));
    await writeFile(path.join(cacheDir, 'current.blockmap'), gzipSync(JSON.stringify(oldMap)));
  }
  const helper = {
    cacheDir,
    cacheDirForPendingUpdate: pendingDir,
    downloaded: undefined as string | undefined,
    async setDownloadedFile(file: string) { this.downloaded = file; },
  };
  const updater = { async getOrCreateDownloadHelper() { return helper; } };
  const fileInfo = {
    url: new URL(updateUrl),
    info: { url: 'LinkSunder-0.5.1-Windows-x64.exe', size: newPackage.length, sha512: digest(newPackage) },
  };
  const provider = {
    resolveFiles: () => [fileInfo],
    getBlockMapFiles: () => [
      new URL(`${baseUrl}/LinkSunder-0.5.0-Windows-x64.exe.blockmap`),
      new URL(`${baseUrl}/LinkSunder-0.5.1-Windows-x64.exe.blockmap`),
    ],
  };
  return {
    root,
    pendingDir,
    oldPackage,
    newPackage,
    rangeRequests,
    helper,
    update: { info: { version: '0.5.1' }, provider },
    createDownloader: () => new ResumableUpdateDownload({
      updater,
      directory: path.join(root, 'resumable'),
      platform: 'win32',
      chunkSize: 2,
      allowLocalhost: true,
    }),
  };
}

describe('resumable differential update downloads', () => {
  it('downloads only changed ranges and verifies the completed package', async () => {
    const test = await fixture(true);
    const downloader = test.createDownloader();
    await expect(downloader.download(test.update, '0.5.0')).resolves.toMatchObject({ downloaded: true });
    expect(test.rangeRequests).toEqual(['bytes=4-5', 'bytes=6-7']);
    expect(await readFile(test.helper.downloaded!)).toEqual(test.newPackage);
    expect(await readFile(path.join(test.helper.cacheDir, 'current.blockmap'))).toBeDefined();
  });

  it('resumes from the last saved byte range after a pause', async () => {
    const test = await fixture(true);
    const downloader = test.createDownloader();
    const paused = await downloader.download(test.update, '0.5.0', (progress) => {
      if (progress.transferred >= 6) downloader.pause();
    });
    expect(paused).toMatchObject({ paused: true, progress: { transferred: 6, total: 8 } });
    expect(test.rangeRequests).toEqual(['bytes=4-5']);

    await expect(downloader.download(test.update, '0.5.0')).resolves.toMatchObject({ downloaded: true });
    expect(test.rangeRequests).toEqual(['bytes=4-5', 'bytes=6-7']);
    expect(await readFile(test.helper.downloaded!)).toEqual(test.newPackage);
  });

  it('uses a resumable full download when the installed package is unavailable', async () => {
    const test = await fixture(false);
    const downloader = test.createDownloader();
    await expect(downloader.download(test.update, '0.5.0')).resolves.toMatchObject({ downloaded: true });
    expect(test.rangeRequests).toEqual(['bytes=0-1', 'bytes=2-3', 'bytes=4-5', 'bytes=6-7']);
    expect(await readFile(test.helper.downloaded!)).toEqual(test.newPackage);
  });

  it('rejects a package redirect to a non-GitHub host before following it', async () => {
    const test = await fixture(false, 'https://example.com/redirected-package.exe');
    const downloader = test.createDownloader();
    await expect(downloader.download(test.update, '0.5.0')).rejects.toThrow('not an official GitHub release host');
    expect(test.rangeRequests).toEqual([]);
  });

  it('updates only changed AppImage payload blocks and appends the embedded blockmap footer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'linksunder-appimage-update-'));
    roots.push(root);
    const cacheDir = path.join(root, 'updater-cache');
    const pendingDir = path.join(cacheDir, 'pending');
    await mkdir(pendingDir, { recursive: true });

    const firstBlock = Buffer.alloc(10_000, 0x61);
    const oldSecondBlock = Buffer.alloc(10_000, 0x62);
    const newSecondBlock = Buffer.alloc(10_000, 0x63);
    const oldMap = { version: '2', files: [{ name: 'file', offset: 0, sizes: [10_000, 10_000], checksums: ['shared', 'old'] }] };
    const newMap = { version: '2', files: [{ name: 'file', offset: 0, sizes: [10_000, 10_000], checksums: ['shared', 'new'] }] };
    const appendEmbeddedMap = (payload: Buffer, map: typeof oldMap) => {
      const compressed = deflateRawSync(Buffer.from(JSON.stringify(map)));
      const footer = Buffer.alloc(4);
      footer.writeUInt32BE(compressed.length);
      return { package: Buffer.concat([payload, compressed, footer]), compressed };
    };
    const oldPackage = appendEmbeddedMap(Buffer.concat([firstBlock, oldSecondBlock]), oldMap).package;
    const { package: newPackage, compressed: newCompressedMap } = appendEmbeddedMap(Buffer.concat([firstBlock, newSecondBlock]), newMap);
    const oldPath = path.join(root, 'LinkSunder-0.5.0-x86_64.AppImage');
    await writeFile(oldPath, oldPackage);
    const rangeRequests: string[] = [];

    const server = createServer((request, response) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
      if (!match) {
        response.writeHead(400);
        response.end();
        return;
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      rangeRequests.push(`bytes=${start}-${end}`);
      response.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${newPackage.length}`,
        'accept-ranges': 'bytes',
        'content-length': end - start + 1,
      });
      response.end(newPackage.subarray(start, end + 1));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('The AppImage test update server did not start.');

    const helper = {
      cacheDir,
      cacheDirForPendingUpdate: pendingDir,
      downloaded: undefined as string | undefined,
      async setDownloadedFile(file: string) { this.downloaded = file; },
    };
    const updater = { async getOrCreateDownloadHelper() { return helper; } };
    const fileInfo = {
      url: new URL(`http://127.0.0.1:${address.port}/LinkSunder-0.5.1-Linux-x86_64.AppImage`),
      info: {
        url: 'LinkSunder-0.5.1-Linux-x86_64.AppImage',
        size: newPackage.length,
        sha512: digest(newPackage),
        blockMapSize: newCompressedMap.length,
      },
    };
    const update = {
      info: { version: '0.5.1' },
      provider: { resolveFiles: () => [fileInfo] },
    };
    const downloader = new ResumableUpdateDownload({
      updater,
      directory: path.join(root, 'resumable'),
      platform: 'linux',
      getAppImagePath: () => oldPath,
      allowLocalhost: true,
    });

    await expect(downloader.download(update, '0.5.0')).resolves.toMatchObject({ downloaded: true });
    const metadataStart = newPackage.length - newCompressedMap.length - 4;
    expect(rangeRequests).toEqual([
      `bytes=${metadataStart}-${newPackage.length - 1}`,
      'bytes=10000-19999',
      `bytes=${metadataStart}-${newPackage.length - 1}`,
    ]);
    expect(await readFile(helper.downloaded!)).toEqual(newPackage);
  });
});
