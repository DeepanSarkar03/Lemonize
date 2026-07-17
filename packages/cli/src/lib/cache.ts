import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR } from './paths.js';

/** Cache tarballs by their sha256 shasum (content-addressed). */
export function cachePathFor(shasum: string): string {
  if (!/^[a-f0-9]{64}$/i.test(shasum)) {
    throw new Error('Invalid SHA-256 shasum from registry metadata.');
  }
  const sub = shasum.slice(0, 2);
  return join(CACHE_DIR, sub, `${shasum}.tgz`);
}

export function readCache(shasum: string): Uint8Array | null {
  const p = cachePathFor(shasum);
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
}

export function writeCache(shasum: string, data: Uint8Array): void {
  const p = cachePathFor(shasum);
  mkdirSync(join(CACHE_DIR, shasum.slice(0, 2)), { recursive: true });
  writeFileSync(p, data);
}

export function cleanCache(): void {
  if (existsSync(CACHE_DIR)) rmSync(CACHE_DIR, { recursive: true, force: true });
  mkdirSync(CACHE_DIR, { recursive: true });
}
