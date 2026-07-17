import { ScannerError } from './errors.js';
import type { ScannerConfig, ScannerFetch } from './types.js';

const APPWRITE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new ScannerError('operational', 'scanner_misconfigured', 500);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ScannerError('operational', 'scanner_misconfigured', 500);
  }
  return value;
}

function endpoint(raw: string, requireTls: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ScannerError('operational', 'scanner_misconfigured', 500);
  }
  const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
  if (
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback && !requireTls)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ScannerError('operational', 'scanner_misconfigured', 500);
  }
  return parsed.toString().replace(/\/+$/, '');
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: ScannerFetch = (input, init) => fetch(input, init),
): ScannerConfig {
  const signingSecret = required(env, 'SCAN_SIGNING_SECRET');
  if (Buffer.byteLength(signingSecret, 'utf8') < 32) {
    throw new ScannerError('operational', 'scanner_misconfigured', 500);
  }
  // Appwrite injects a short-lived, scope-limited key for each execution. The
  // explicit names remain supported for local tests only.
  const appwriteApiKey = env.APPWRITE_FUNCTION_API_KEY || required(env, 'APPWRITE_API_KEY');
  const appwriteProjectId = env.APPWRITE_FUNCTION_PROJECT_ID || required(env, 'APPWRITE_PROJECT_ID');
  const quarantineBucketId = env.APPWRITE_QUARANTINE_BUCKET_ID || 'quarantine';
  if (
    appwriteApiKey.length < 1 ||
    !APPWRITE_ID.test(appwriteProjectId) ||
    !APPWRITE_ID.test(quarantineBucketId)
  ) {
    throw new ScannerError('operational', 'scanner_misconfigured', 500);
  }
  return {
    registryInternalUrl: endpoint(required(env, 'REGISTRY_INTERNAL_URL'), false),
    signingSecret,
    appwriteEndpoint: endpoint(
      env.APPWRITE_FUNCTION_API_ENDPOINT || required(env, 'APPWRITE_ENDPOINT'),
      false,
    ),
    appwriteProjectId,
    appwriteApiKey,
    quarantineBucketId,
    maxArchiveBytes: integer(
      env,
      'MAX_ARCHIVE_BYTES',
      20 * 1024 * 1024,
      1,
      20 * 1024 * 1024,
    ),
    maxPackageFiles: integer(env, 'MAX_PACKAGE_FILES', 10_000, 1, 10_000),
    maxClockSkewSeconds: integer(env, 'MAX_SIGNATURE_AGE_SECONDS', 300, 10, 3_600),
    fetch: fetcher,
    now: () => new Date(),
  };
}
