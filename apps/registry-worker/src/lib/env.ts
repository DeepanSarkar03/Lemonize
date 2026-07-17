import type {
  DurableObjectNamespace,
  KVNamespace,
  R2Bucket,
} from '@cloudflare/workers-types';

export interface Env {
  KV: KVNamespace;
  BUCKET: R2Bucket;
  DEVICE_APPROVALS: DurableObjectNamespace;
  RATE_LIMITS: DurableObjectNamespace;

  ALLOW_PUBLIC_PUBLISH: string;
  ALLOW_PRIVATE_PACKAGES: string;
  MAX_TARBALL_SIZE_BYTES: string;
  MAX_UNPACKED_SIZE_BYTES: string;
  MAX_PACKAGE_FILES: string;
  MAX_GLOBAL_ARTIFACT_BYTES: string;
  RATE_LIMIT_READS_PER_MINUTE: string;
  RATE_LIMIT_WRITES_PER_MINUTE: string;
  REGISTRY_BASE_URL: string;
  WEB_BASE_URL: string;
  CORS_ALLOWED_ORIGINS: string;

  REGISTRY_MODE: string;
  ADMIN_CLERK_IDS: string;

  APPWRITE_ENDPOINT: string;
  APPWRITE_PROJECT_ID: string;
  APPWRITE_DATABASE_ID: string;
  APPWRITE_API_KEY: string;
  APPWRITE_QUARANTINE_BUCKET_ID: string;
  APPWRITE_SCANNER_FUNCTION_ID: string;

  CLERK_ISSUER: string;
  CLERK_AUTHORIZED_PARTIES: string;
  CLERK_SECRET_KEY: string;
  SCANNER_SHARED_SECRET: string;
}

export type RegistryMode = 'read_only' | 'invite_only' | 'public';
export type RegistryRole = 'consumer' | 'publisher' | 'admin';
export type TokenScope = 'read' | 'publish' | 'manage:packages' | 'manage:tokens';

export interface Config {
  allowPublicPublish: boolean;
  allowPrivatePackages: boolean;
  maxTarballSizeBytes: number;
  maxUnpackedSizeBytes: number;
  maxPackageFiles: number;
  maxGlobalArtifactBytes: number;
  rateLimitReadsPerMinute: number;
  rateLimitWritesPerMinute: number;
  registryBaseUrl: string;
  webBaseUrl: string;
  corsAllowedOrigins: string[];
  registryMode: RegistryMode;
  adminClerkIds: string[];
  clerkIssuer: string;
  clerkAuthorizedParties: string[];
}

const bool = (v: string | undefined, d = false) =>
  v == null ? d : v === 'true' || v === '1' || v === 'yes';
const int = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};
const list = (v: string | undefined) =>
  (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(env: Env): Config {
  const mode: RegistryMode =
    env.REGISTRY_MODE === 'public' || env.REGISTRY_MODE === 'invite_only'
      ? env.REGISTRY_MODE
      : 'read_only';
  return {
    // An omitted or malformed deployment variable must never turn writes on.
    allowPublicPublish: bool(env.ALLOW_PUBLIC_PUBLISH, false),
    allowPrivatePackages: bool(env.ALLOW_PRIVATE_PACKAGES, false),
    maxTarballSizeBytes: int(env.MAX_TARBALL_SIZE_BYTES, 10 * 1024 * 1024),
    maxUnpackedSizeBytes: int(env.MAX_UNPACKED_SIZE_BYTES, 104857600),
    maxPackageFiles: int(env.MAX_PACKAGE_FILES, 2000),
    maxGlobalArtifactBytes: Math.min(
      int(env.MAX_GLOBAL_ARTIFACT_BYTES, 1024 * 1024 * 1024),
      7 * 1024 * 1024 * 1024,
    ),
    rateLimitReadsPerMinute: int(env.RATE_LIMIT_READS_PER_MINUTE, 600),
    rateLimitWritesPerMinute: int(env.RATE_LIMIT_WRITES_PER_MINUTE, 60),
    registryBaseUrl: (env.REGISTRY_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    webBaseUrl: (env.WEB_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    corsAllowedOrigins: list(env.CORS_ALLOWED_ORIGINS),
    registryMode: mode,
    // Administrator authority is bound to Clerk's immutable subject, never a
    // mutable email address or GitHub username.
    adminClerkIds: list(env.ADMIN_CLERK_IDS),
    clerkIssuer: (env.CLERK_ISSUER || '').replace(/\/+$/, ''),
    clerkAuthorizedParties: list(env.CLERK_AUTHORIZED_PARTIES),
  };
}

export interface Vars {
  requestId: string;
  config: Config;
  userId?: string;
  clerkId?: string;
  email?: string;
  namespace?: string;
  role?: RegistryRole;
  acceptedTermsVersion?: string | null;
  tokenId?: string;
  tokenScopes?: TokenScope[];
  tokenExpiresAt?: string;
  authType?: 'clerk' | 'api_token';
}

export type AppBindings = { Bindings: Env; Variables: Vars };
