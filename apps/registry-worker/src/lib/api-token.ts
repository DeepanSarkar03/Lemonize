import { hashToken, newApiToken, rateLimited, TOKEN_PREFIX } from '@lemonize/shared';
import type { RegistryRow } from './appwrite-types.js';
import type { RegistryAppwriteRepository } from './appwrite-repository.js';
import type { TokenScope } from './env.js';
import type { R2Bucket } from '@cloudflare/workers-types';

export interface CreatedApiToken {
  token: string;
  row: RegistryRow<'api_tokens'>;
}

export async function acquireApiTokenIssuanceLock(
  bucket: R2Bucket,
  userId: string,
): Promise<string> {
  const key = `internal/token-issuance-locks/${await hashToken(`user:${userId}`)}`;
  const attempt = () =>
    bucket.put(key, new Uint8Array([1]), {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { cacheControl: 'private, no-store' },
    });
  for (let index = 0; index < 21; index += 1) {
    const lock = await attempt();
    if (lock) return key;
    const existing = await bucket.head(key);
    if (existing && existing.uploaded.getTime() < Date.now() - 2 * 60_000) {
      await bucket.delete(key);
      continue;
    }
    if (index < 20) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw rateLimited('Another token issuance is in progress. Try again shortly.');
}

/** Mint a Lemonize token while persisting only its SHA-256 digest. */
export async function createApiToken(
  repo: RegistryAppwriteRepository,
  input: {
    userId: string;
    label: string;
    scopes: readonly TokenScope[];
    expiresInDays?: number;
    maximumExpiresAt?: string;
  },
): Promise<CreatedApiToken> {
  const expiresInDays = input.expiresInDays ?? 90;
  if (!Number.isSafeInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 90) {
    throw new Error('API token lifetime must be between 1 and 90 days.');
  }
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0) throw new Error('API token requires at least one scope.');

  const existing = await repo.listTokensByUser(input.userId, { activeOnly: true });
  const now = Date.now();
  const expired = existing.rows.filter((row) => Date.parse(row.expiresAt) <= now);
  await Promise.all(expired.map((row) => repo.tokens.delete(row.$id)));
  if (existing.rows.length - expired.length >= 10) {
    throw rateLimited('At most 10 active API tokens are allowed per account.');
  }

  const requestedExpiresAt = Date.now() + expiresInDays * 86_400_000;
  const maximumExpiresAt = input.maximumExpiresAt
    ? Date.parse(input.maximumExpiresAt)
    : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(maximumExpiresAt) && input.maximumExpiresAt) {
    throw new Error('API token expiry cap is invalid.');
  }
  const expiresAt = Math.min(requestedExpiresAt, maximumExpiresAt);
  if (expiresAt <= Date.now()) throw new Error('API token expiry cap has elapsed.');

  const token = newApiToken();
  const row = await repo.tokens.create({
    userId: input.userId,
    tokenHash: await hashToken(token),
    prefix: token.slice(0, TOKEN_PREFIX.length + 6),
    label: input.label,
    scopes: scopes.join(','),
    expiresAt: new Date(expiresAt).toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  });
  return { token, row };
}
