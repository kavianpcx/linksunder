import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUpdateMetadata, verifyUpdateMetadata } from '../scripts/write-update-metadata.mjs';

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
    const contents = Buffer.from('synthetic release package bytes');
    await writeFile(path.join(directory, asset), contents);
    const releaseDate = new Date('2026-11-18T00:00:00.000Z');
    const result = await createUpdateMetadata(directory, platform, '0.4.0', releaseDate);
    const expected = createHash('sha512').update(contents).digest('base64');
    expect(path.basename(result.manifestPath)).toBe(manifestName);
    expect(result.sha512).toBe(expected);
    await expect(readFile(result.manifestPath, 'utf8')).resolves.toContain(`sha512: ${expected}`);
    await expect(readFile(result.manifestPath, 'utf8')).resolves.toContain(`size: ${contents.length}`);
    await expect(readFile(result.manifestPath, 'utf8')).resolves.toContain('version: 0.4.0');
    await expect(verifyUpdateMetadata(directory, platform, '0.4.0')).resolves.toMatchObject({ filename: asset, sha512: expected, size: contents.length });
    await writeFile(path.join(directory, asset), 'changed package bytes');
    await expect(verifyUpdateMetadata(directory, platform, '0.4.0')).rejects.toThrow('checksum or size');
  });

  it('rejects a missing release package instead of emitting stale update metadata', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'linksunder-update-metadata-missing-'));
    roots.push(directory);
    await expect(createUpdateMetadata(directory, 'windows', '0.4.0')).rejects.toThrow('missing or empty');
  });
});
