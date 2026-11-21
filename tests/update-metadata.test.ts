import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUpdateMetadata, verifyUpdateMetadata } from '../scripts/write-update-metadata.mjs';
import { deflateRawSync, gzipSync } from 'node:zlib';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop update metadata', () => {
  it.each([
    ['windows', 'LinkSunder-0.4.0-Windows-x64.exe', 'latest.yml'],
    ['linux', 'LinkSunder-0.4.0-Linux-x86_64.AppImage', 'latest-linux.yml'],
  ] as const)('writes the %s manifest from the exact release package bytes', async (platform, asset, manifestName) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'linksunder-update-metadata-'));
    roots.push(directory);
    const blockMap = JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, sizes: [8], checksums: ['checksum'] }] });
    const contents = platform === 'linux'
      ? (() => {
          const compressedBlockMap = deflateRawSync(blockMap);
          const footer = Buffer.alloc(4);
          footer.writeUInt32BE(compressedBlockMap.length);
          return Buffer.concat([Buffer.from('synthetic AppImage package'), compressedBlockMap, footer]);
        })()
      : Buffer.from('synthetic Windows installer package');
    await writeFile(path.join(directory, asset), contents);
    if (platform === 'windows') await writeFile(path.join(directory, `${asset}.blockmap`), gzipSync(blockMap));
    const releaseDate = new Date('2026-11-18T00:00:00.000Z');
    const result = await createUpdateMetadata(directory, platform, '0.4.0', releaseDate);
    const expected = createHash('sha512').update(contents).digest('base64');
    expect(path.basename(result.manifestPath)).toBe(manifestName);
    expect(result.sha512).toBe(expected);
    await expect(readFile(result.manifestPath, 'utf8')).resolves.toContain(`sha512: ${expected}`);
    await expect(readFile(result.manifestPath, 'utf8')).resolves.toContain(`size: ${contents.length}`);
    await expect(readFile(result.manifestPath, 'utf8')).resolves.toContain('version: 0.4.0');
    if (platform === 'linux') await expect(readFile(result.manifestPath, 'utf8')).resolves.toContain(`blockMapSize: ${contents.length - Buffer.byteLength('synthetic AppImage package') - 4}`);
    await expect(verifyUpdateMetadata(directory, platform, '0.4.0')).resolves.toMatchObject({ filename: asset, sha512: expected, size: contents.length });
    await writeFile(path.join(directory, asset), 'changed package bytes');
    await expect(verifyUpdateMetadata(directory, platform, '0.4.0')).rejects.toThrow('checksum or size');
  });

  it('rejects a missing release package instead of emitting stale update metadata', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'linksunder-update-metadata-missing-'));
    roots.push(directory);
    await expect(createUpdateMetadata(directory, 'windows', '0.4.0')).rejects.toThrow('missing or empty');
  });

  it('rejects Windows package bytes without their differential blockmap', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'linksunder-update-metadata-blockmap-'));
    roots.push(directory);
    await writeFile(path.join(directory, 'LinkSunder-0.5.1-Windows-x64.exe'), 'installer');
    await expect(createUpdateMetadata(directory, 'windows', '0.5.1')).rejects.toThrow('blockmap is missing');
  });
});
