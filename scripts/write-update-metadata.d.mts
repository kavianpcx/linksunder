export function createUpdateMetadata(
  directory: string,
  platform: 'windows' | 'linux',
  version: string,
  releaseDate?: Date,
): Promise<{ manifestPath: string; manifest: string; filename: string; sha512: string; size: number }>;
export function verifyUpdateMetadata(
  directory: string,
  platform: 'windows' | 'linux',
  version: string,
): Promise<{ manifestPath: string; filename: string; sha512: string; size: number }>;
