import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';

const definitions = {
  windows: { asset: (version) => `LinkSunder-${version}-Windows-x64.exe`, manifest: 'latest.yml' },
  linux: { asset: (version) => `LinkSunder-${version}-Linux-x86_64.AppImage`, manifest: 'latest-linux.yml' },
};

async function sha512Base64(file) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

function assertBlockMap(value, filename) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.files) || value.files.length === 0)
    throw new Error(`Update blockmap is invalid: ${filename}`);
  for (const entry of value.files) {
    if (!entry || typeof entry.name !== 'string' || !Array.isArray(entry.sizes) || !Array.isArray(entry.checksums) || entry.sizes.length !== entry.checksums.length)
      throw new Error(`Update blockmap is invalid: ${filename}`);
  }
}

async function appImageBlockMapSize(file, fileSize) {
  const handle = await open(file, 'r');
  try {
    const footer = Buffer.alloc(4);
    await handle.read(footer, 0, footer.length, fileSize - footer.length);
    const blockMapSize = footer.readUInt32BE(0);
    if (blockMapSize < 1 || blockMapSize > 16 * 1024 * 1024 || blockMapSize + 4 >= fileSize)
      throw new Error('AppImage does not contain a valid embedded update blockmap.');
    const compressed = Buffer.alloc(blockMapSize);
    await handle.read(compressed, 0, compressed.length, fileSize - 4 - blockMapSize);
    assertBlockMap(JSON.parse(inflateRawSync(compressed).toString('utf8')), path.basename(file));
    return blockMapSize;
  } finally {
    await handle.close();
  }
}

async function verifyWindowsBlockMap(file) {
  const blockMapPath = `${file}.blockmap`;
  let raw;
  try {
    raw = await readFile(blockMapPath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Windows differential update blockmap is missing: ${path.basename(blockMapPath)}`, { cause: error });
    throw error;
  }
  try {
    assertBlockMap(JSON.parse(gunzipSync(raw).toString('utf8')), path.basename(blockMapPath));
  } catch (error) {
    throw new Error(`Windows differential update blockmap is invalid: ${error.message}`, { cause: error });
  }
}

export async function createUpdateMetadata(directory, platform, version, releaseDate = new Date()) {
  if (!Object.hasOwn(definitions, platform)) throw new Error('Platform must be windows or linux.');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Version must use the package.json semver format.');
  const definition = definitions[platform];
  const filename = definition.asset(version);
  const file = path.join(directory, filename);
  let fileInfo;
  try {
    fileInfo = await stat(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!fileInfo?.isFile() || fileInfo.size <= 0) throw new Error(`Release package is missing or empty: ${filename}`);
  const sha512 = await sha512Base64(file);
  const blockMapSize = platform === 'linux'
    ? await appImageBlockMapSize(file, fileInfo.size)
    : (await verifyWindowsBlockMap(file), undefined);
  const manifest = [
    `version: ${version}`,
    'files:',
    `  - url: ${filename}`,
    `    sha512: ${sha512}`,
    `    size: ${fileInfo.size}`,
    ...(blockMapSize === undefined ? [] : [`    blockMapSize: ${blockMapSize}`]),
    `path: ${filename}`,
    `sha512: ${sha512}`,
    `releaseDate: ${releaseDate.toISOString()}`,
    '',
  ].join('\n');
  const manifestPath = path.join(directory, definition.manifest);
  await writeFile(manifestPath, manifest, 'utf8');
  return { manifestPath, manifest, filename, sha512, size: fileInfo.size };
}

export async function verifyUpdateMetadata(directory, platform, version) {
  if (!Object.hasOwn(definitions, platform)) throw new Error('Platform must be windows or linux.');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Version must use the package.json semver format.');
  const definition = definitions[platform];
  const filename = definition.asset(version);
  const manifestPath = path.join(directory, definition.manifest);
  const manifest = await readFile(manifestPath, 'utf8');
  const lines = manifest.match(/^version: (\S+)\nfiles:\n {2}- url: (\S+)\n {4}sha512: (\S+)\n {4}size: (\d+)\n(?: {4}blockMapSize: (\d+)\n)?path: (\S+)\nsha512: (\S+)\nreleaseDate: (\S+)\n$/);
  if (!lines) throw new Error(`Updater manifest has an unsupported or incomplete format: ${definition.manifest}`);
  const [, manifestVersion, url, fileSha512, fileSize, manifestBlockMapSize, manifestPathValue, manifestSha512, releaseDate] = lines;
  if (manifestVersion !== version || url !== filename || manifestPathValue !== filename || fileSha512 !== manifestSha512 || !Number.isFinite(Date.parse(releaseDate)))
    throw new Error(`Updater manifest does not match ${filename}.`);
  const assetPath = path.join(directory, filename);
  const fileInfo = await stat(assetPath);
  const actualSha512 = await sha512Base64(assetPath);
  if (!fileInfo.isFile() || fileInfo.size !== Number(fileSize) || actualSha512 !== fileSha512)
    throw new Error(`Updater manifest checksum or size does not match ${filename}.`);
  const blockMapSize = platform === 'linux'
    ? await appImageBlockMapSize(assetPath, fileInfo.size)
    : (await verifyWindowsBlockMap(assetPath), undefined);
  if (blockMapSize !== undefined && Number(manifestBlockMapSize) !== blockMapSize)
    throw new Error(`Updater manifest blockmap size does not match ${filename}.`);
  if (platform === 'windows' && manifestBlockMapSize !== undefined)
    throw new Error(`Updater manifest contains an unexpected blockmap size for ${filename}.`);
  return { manifestPath, filename, sha512: actualSha512, size: fileInfo.size, blockMapSize };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const modeOrPlatform = process.argv[2];
  const mode = modeOrPlatform === 'verify' ? 'verify' : 'write';
  const platform = mode === 'verify' ? process.argv[3] : modeOrPlatform;
  if (!Object.hasOwn(definitions, platform)) throw new Error('Usage: node scripts/write-update-metadata.mjs <windows|linux>');
  const directory = path.resolve(mode === 'verify' ? process.argv[4] || 'release' : process.argv[3] || 'release');
  const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
  const result = mode === 'verify'
    ? await verifyUpdateMetadata(directory, platform, packageJson.version)
    : await createUpdateMetadata(directory, platform, packageJson.version);
  console.log(`${mode === 'verify' ? 'Verified' : 'Wrote'} ${path.basename(result.manifestPath)} for ${result.filename} (${result.size} bytes).`);
}
