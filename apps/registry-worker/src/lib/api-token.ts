import { forbidden, hashToken, newApiToken, rateLimited, TOKEN_PREFIX } from '@lemonize/shared';
import type { RegistryRow } from './appwrite-types.js';
import type { RegistryAppwriteRepository } from './appwrite-repository.js';
import type { TokenScope } from './env.js';
import type { R2Bucket } from '@cloudflare/workers-types';

export interface CreatedApiToken {
  token: string;
  row: RegistryRow<'api_tokens'>;
}

export interface ApiTokenParent {
  tokenId: string;
  rootTokenId: string;
  userId: string;
  scopes: readonly TokenScope[];
  expiresAt: string;
}

const TOKEN_ROW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;

function activeTokenRow(row: RegistryRow<'api_tokens'>, now: number): boolean {
  const expiresAt = Date.parse(row.expiresAt);
  return !row.revokedAt && Number.isFinite(expiresAt) && expiresAt > now;
}

/** Resolve a credential's active root. Malformed or delegated manager rows fail closed. */
export async function activeApiTokenRoot(
  repo: RegistryAppwriteRepository,
  row: RegistryRow<'api_tokens'>,
  now = Date.now(),
): Promise<string | null> {
  if (!activeTokenRow(row, now)) return null;
  const parentTokenId = row.parentTokenId ?? null;
  const rootTokenId = row.rootTokenId ?? null;
  if (parentTokenId === null) {
    return rootTokenId === null || rootTokenId === row.$id ? row.$id : null;
  }
  if (
    !rootTokenId ||
    !TOKEN_ROW_ID.test(parentTokenId) ||
    !TOKEN_ROW_ID.test(rootTokenId) ||
    parentTokenId !== rootTokenId ||
    parentTokenId === row.$id ||
    row.scopes.split(',').includes('manage:tokens')
  ) {
    return null;
  }
  const root = await repo.tokens.getOrNull(rootTokenId);
  if (
    !root ||
    root.userId !== row.userId ||
    (root.parentTokenId ?? null) !== null ||
    ((root.rootTokenId ?? null) !== null && root.rootTokenId !== root.$id) ||
    !activeTokenRow(root, now)
  ) {
    return null;
  }
  const childExpiresAt = Date.parse(row.expiresAt);
  const rootExpiresAt = Date.parse(root.expiresAt);
  const rootScopes = new Set(root.scopes.split(','));
  if (
    childExpiresAt > rootExpiresAt ||
    row.scopes.split(',').some((scope) => !rootScopes.has(scope))
  ) {
    return null;
  }
  return root.$id;
}

export function apiTokenCanManageTarget(input: {
  callerTokenId: string;
  callerRootTokenId: string;
  callerUserId: string;
  target: RegistryRow<'api_tokens'>;
}): boolean {
  if (input.target.userId !== input.callerUserId) return false;
  if (input.target.$id === input.callerTokenId) return true;
  if (input.callerRootTokenId !== input.callerTokenId) return false;
  return (
    input.target.parentTokenId === input.callerTokenId &&
    input.target.rootTokenId === input.callerTokenId
  );
}

/** Revoke a row and, for a root credential, every active direct child. */
export async function revokeApiTokenLineage(
  repo: RegistryAppwriteRepository,
  row: RegistryRow<'api_tokens'>,
  revokedAt = new Date().toISOString(),
): Promise<RegistryRow<'api_tokens'>[]> {
  const rows = new Map<string, RegistryRow<'api_tokens'>>([[row.$id, row]]);
  const isRoot =
    (row.parentTokenId ?? null) === null &&
    ((row.rootTokenId ?? null) === null || row.rootTokenId === row.$id);
  if (!row.revokedAt) await repo.revokeToken(row.$id, revokedAt);
  if (isRoot) {
    const lineage = await repo.listTokensByRoot(row.userId, row.$id, { activeOnly: true });
    for (const candidate of lineage.rows) {
      if (
        candidate.userId === row.userId &&
        (candidate.$id === row.$id ||
          (candidate.parentTokenId === row.$id && candidate.rootTokenId === row.$id))
      ) {
        rows.set(candidate.$id, candidate);
      }
    }
  }
  await Promise.all(
    [...rows.values()]
      .filter((candidate) => candidate.$id !== row.$id && !candidate.revokedAt)
      .map((candidate) => repo.revokeToken(candidate.$id, revokedAt)),
  );
  return [...rows.values()];
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
    parent?: ApiTokenParent;
  },
): Promise<CreatedApiToken> {
  const expiresInDays = input.expiresInDays ?? 90;
  if (!Number.isSafeInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 90) {
    throw new Error('API token lifetime must be between 1 and 90 days.');
  }
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0) throw new Error('API token requires at least one scope.');
  if (input.parent) {
    if (
      input.parent.userId !== input.userId ||
      input.parent.tokenId !== input.parent.rootTokenId ||
      !TOKEN_ROW_ID.test(input.parent.tokenId)
    ) {
      throw forbidden('The creating credential is not a valid root token.');
    }
    if (scopes.includes('manage:tokens')) {
      throw forbidden('API-created tokens cannot manage or delegate other tokens.');
    }
    if (scopes.some((scope) => !input.parent!.scopes.includes(scope))) {
      throw forbidden('A token cannot grant scopes not held by its creating credential.');
    }
  }

  const existing = await repo.listTokensByUser(input.userId, { activeOnly: true });
  const now = Date.now();
  const expired = existing.rows.filter((row) => Date.parse(row.expiresAt) <= now);
  await Promise.all(expired.map((row) => repo.tokens.delete(row.$id)));
  if (existing.rows.length - expired.length >= 10) {
    throw rateLimited('At most 10 active API tokens are allowed per account.');
  }

  const requestedExpiresAt = now + expiresInDays * 86_400_000;
  const maximumExpiresAt = input.parent
    ? Date.parse(input.parent.expiresAt)
    : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(maximumExpiresAt) && input.parent) {
    throw new Error('API token expiry cap is invalid.');
  }
  const expiresAt = Math.min(requestedExpiresAt, maximumExpiresAt);
  if (expiresAt <= now) throw new Error('API token expiry cap has elapsed.');

  const token = newApiToken();
  const rowId = crypto.randomUUID();
  const row = await repo.tokens.create(
    {
      userId: input.userId,
      parentTokenId: input.parent?.tokenId ?? null,
      rootTokenId: input.parent?.rootTokenId ?? rowId,
      tokenHash: await hashToken(token),
      prefix: token.slice(0, TOKEN_PREFIX.length + 6),
      label: input.label,
      scopes: scopes.join(','),
      expiresAt: new Date(expiresAt).toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    },
    rowId,
  );
  return { token, row };
}
