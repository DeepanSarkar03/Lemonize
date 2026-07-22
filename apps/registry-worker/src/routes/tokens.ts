import { Hono, type Context } from 'hono';
import { createTokenSchema, forbidden, notFound, ErrorCodes } from '@lemonize/shared';
import type { AppBindings, TokenScope } from '../lib/env.js';
import type { RegistryRow } from '../lib/appwrite-types.js';
import { requireAuth, requireClerkSession, requireTokenManager } from '../lib/auth.js';
import { rateLimit } from '../lib/ratelimit.js';
import { registryRepository } from '../lib/registry.js';
import {
  acquireApiTokenIssuanceLock,
  apiTokenCanManageTarget,
  createApiToken,
  revokeApiTokenLineage,
} from '../lib/api-token.js';
import type { RegistryAppwriteRepository } from '../lib/appwrite-repository.js';

export const tokens = new Hono<AppBindings>();

export function filterActiveTokenRows(
  rows: RegistryRow<'api_tokens'>[],
  now = Date.now(),
): RegistryRow<'api_tokens'>[] {
  return rows.filter((row) => {
    const expiresAt = Date.parse(row.expiresAt);
    return !row.revokedAt && Number.isFinite(expiresAt) && expiresAt > now;
  });
}

async function revokeRow(
  c: Context<AppBindings>,
  repo: RegistryAppwriteRepository,
  row: RegistryRow<'api_tokens'>,
): Promise<number> {
  const revoked = await revokeApiTokenLineage(repo, row);
  await Promise.all(
    revoked.map((candidate) => {
      const remainingSeconds = Math.ceil((Date.parse(candidate.expiresAt) - Date.now()) / 1_000);
      return c.env.KV.put(`revoked:${candidate.tokenHash}`, '1', {
        expirationTtl: Math.max(60, Number.isFinite(remainingSeconds) ? remainingSeconds : 86_400),
      }).catch(() => undefined);
    }),
  );
  return revoked.length;
}

tokens.post('/tokens', requireAuth, requireTokenManager, async (c) => {
  await rateLimit(c, 'write', 20);
  const body = createTokenSchema.parse(await c.req.json());
  const requestedScopes = body.scopes as TokenScope[];
  const apiParent = c.get('authType') === 'api_token';
  const parentTokenId = c.get('tokenId');
  const parentRootTokenId = c.get('tokenRootId');
  const parentExpiresAt = c.get('tokenExpiresAt');
  const parentScopes = c.get('tokenScopes');
  if (
    apiParent &&
    (!parentTokenId || !parentRootTokenId || !parentExpiresAt || !parentScopes)
  ) {
    throw forbidden('The creating credential has incomplete lineage metadata.');
  }
  const repo = registryRepository(c.env);
  const issuanceLock = await acquireApiTokenIssuanceLock(c.env.BUCKET, c.get('userId')!);
  const created = await createApiToken(repo, {
    userId: c.get('userId')!,
    label: body.label,
    scopes: requestedScopes,
    expiresInDays: body.expiresInDays,
    parent: apiParent
      ? {
          tokenId: parentTokenId!,
          rootTokenId: parentRootTokenId!,
          userId: c.get('userId')!,
          scopes: parentScopes!,
          expiresAt: parentExpiresAt!,
        }
      : undefined,
  }).finally(() => c.env.BUCKET.delete(issuanceLock).catch(() => undefined));
  await repo.appendAudit({
    actorId: c.get('userId')!,
    action: 'token.create',
    resourceType: 'token',
    resourceId: created.row.$id,
    detail: `${created.row.label} scopes=${created.row.scopes} creator=${c.get('tokenId') ?? 'clerk'}`,
    requestId: c.get('requestId'),
    ipHash: null,
  }).catch(() => undefined);
  return c.json(
    {
      id: created.row.$id,
      token: created.token,
      label: created.row.label,
      scopes: created.row.scopes.split(','),
      createdAt: created.row.$createdAt,
      expiresAt: created.row.expiresAt,
    },
    201,
  );
});

tokens.get('/tokens', requireAuth, requireTokenManager, async (c) => {
  const repo = registryRepository(c.env);
  const userId = c.get('userId')!;
  let tokenRows: RegistryRow<'api_tokens'>[];
  if (c.get('authType') === 'clerk') {
    tokenRows = filterActiveTokenRows(
      (await repo.listTokensByUser(userId, { activeOnly: true })).rows,
    );
  } else {
    const callerTokenId = c.get('tokenId');
    const callerRootTokenId = c.get('tokenRootId');
    if (!callerTokenId || !callerRootTokenId || callerTokenId !== callerRootTokenId) {
      throw forbidden('Only a root token may manage its delegated credentials.');
    }
    const [lineage, self] = await Promise.all([
      repo.listTokensByRoot(userId, callerRootTokenId, { activeOnly: true }),
      repo.tokens.getOrNull(callerTokenId),
    ]);
    const manageable = new Map<string, RegistryRow<'api_tokens'>>();
    for (const row of filterActiveTokenRows([...lineage.rows, ...(self ? [self] : [])])) {
      if (
        apiTokenCanManageTarget({
          callerTokenId,
          callerRootTokenId,
          callerUserId: userId,
          target: row,
        })
      ) {
        manageable.set(row.$id, row);
      }
    }
    tokenRows = [...manageable.values()].sort((left, right) =>
      right.$createdAt.localeCompare(left.$createdAt),
    );
  }
  return c.json({
    tokens: tokenRows.map((row) => ({
      id: row.$id,
      label: row.label,
      prefix: row.prefix,
      scopes: row.scopes.split(','),
      createdAt: row.$createdAt,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
    })),
  });
});

tokens.delete('/tokens/:id', requireAuth, requireTokenManager, async (c) => {
  await rateLimit(c, 'write', 20);
  const repo = registryRepository(c.env);
  const tokenId = c.req.param('id')!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(tokenId)) {
    throw notFound(ErrorCodes.NOT_FOUND, 'Token not found');
  }
  const row = await repo.tokens.getOrNull(tokenId);
  if (
    !row ||
    row.userId !== c.get('userId') ||
    (c.get('authType') === 'api_token' &&
      (!c.get('tokenId') ||
        !c.get('tokenRootId') ||
        !apiTokenCanManageTarget({
          callerTokenId: c.get('tokenId')!,
          callerRootTokenId: c.get('tokenRootId')!,
          callerUserId: c.get('userId')!,
          target: row,
        })))
  ) {
    throw notFound(ErrorCodes.NOT_FOUND, 'Token not found');
  }
  const revoked = await revokeRow(c, repo, row);
  await repo.appendAudit({
    actorId: c.get('userId')!,
    action: 'token.revoke',
    resourceType: 'token',
    resourceId: row.$id,
    detail: `${row.label} revoked=${revoked}`,
    requestId: c.get('requestId'),
    ipHash: null,
  }).catch(() => undefined);
  return c.json({ ok: true });
});

async function revokeAll(c: Context<AppBindings>) {
  await rateLimit(c, 'write', 10);
  const repo = registryRepository(c.env);
  const rows = await repo.listTokensByUser(c.get('userId')!, { activeOnly: true });
  await Promise.all(rows.rows.map((row) => revokeRow(c, repo, row)));
  await repo.appendAudit({
    actorId: c.get('userId')!,
    action: 'token.revoke_all',
    resourceType: 'account',
    resourceId: c.get('userId')!,
    detail: `revoked=${rows.rows.length}`,
    requestId: c.get('requestId'),
    ipHash: null,
  }).catch(() => undefined);
  return c.json({ ok: true, revoked: rows.rows.length });
}

// Only a fresh browser session may cross independent token roots. API-token
// callers can manage their own root and direct children through the routes above.
tokens.delete('/tokens', requireAuth, requireClerkSession, revokeAll);
tokens.post('/tokens/revoke-all', requireAuth, requireClerkSession, revokeAll);
