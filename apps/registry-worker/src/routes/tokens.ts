import { Hono, type Context } from 'hono';
import { createTokenSchema, forbidden, notFound, ErrorCodes } from '@lemonize/shared';
import type { AppBindings, TokenScope } from '../lib/env.js';
import type { RegistryRow } from '../lib/appwrite-types.js';
import { requireAuth, requireClerkSession, requireTokenManager } from '../lib/auth.js';
import { rateLimit } from '../lib/ratelimit.js';
import { registryRepository } from '../lib/registry.js';
import { acquireApiTokenIssuanceLock, createApiToken } from '../lib/api-token.js';

export const tokens = new Hono<AppBindings>();

async function revokeRow(
  c: Context<AppBindings>,
  row: RegistryRow<'api_tokens'>,
): Promise<void> {
  await registryRepository(c.env).revokeToken(row.$id);
  const remainingSeconds = Math.ceil((Date.parse(row.expiresAt) - Date.now()) / 1_000);
  await c.env.KV.put(`revoked:${row.tokenHash}`, '1', {
    expirationTtl: Math.max(60, Number.isFinite(remainingSeconds) ? remainingSeconds : 86_400),
  }).catch(() => undefined);
}

tokens.post('/tokens', requireAuth, requireTokenManager, async (c) => {
  await rateLimit(c, 'write', 20);
  const body = createTokenSchema.parse(await c.req.json());
  const requestedScopes = body.scopes as TokenScope[];
  if (
    c.get('authType') === 'api_token' &&
    requestedScopes.some((scope) => !(c.get('tokenScopes') ?? []).includes(scope))
  ) {
    throw forbidden('A token cannot grant scopes not held by its creating credential.');
  }
  if (c.get('authType') === 'api_token' && !c.get('tokenExpiresAt')) {
    throw forbidden('The creating credential has no valid expiry bound.');
  }
  const repo = registryRepository(c.env);
  const issuanceLock = await acquireApiTokenIssuanceLock(c.env.BUCKET, c.get('userId')!);
  const created = await createApiToken(repo, {
    userId: c.get('userId')!,
    label: body.label,
    scopes: requestedScopes,
    expiresInDays: body.expiresInDays,
    maximumExpiresAt:
      c.get('authType') === 'api_token' ? c.get('tokenExpiresAt') : undefined,
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
  const rows = await registryRepository(c.env).listTokensByUser(c.get('userId')!, {
    activeOnly: true,
  });
  return c.json({
    tokens: rows.rows.map((row) => ({
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
  if (!row || row.userId !== c.get('userId')) {
    throw notFound(ErrorCodes.NOT_FOUND, 'Token not found');
  }
  await revokeRow(c, row);
  await repo.appendAudit({
    actorId: c.get('userId')!,
    action: 'token.revoke',
    resourceType: 'token',
    resourceId: row.$id,
    detail: row.label,
    requestId: c.get('requestId'),
    ipHash: null,
  }).catch(() => undefined);
  return c.json({ ok: true });
});

async function revokeAll(c: Context<AppBindings>) {
  await rateLimit(c, 'write', 10);
  const repo = registryRepository(c.env);
  const rows = await repo.listTokensByUser(c.get('userId')!, { activeOnly: true });
  await Promise.all(rows.rows.map((row) => revokeRow(c, row)));
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

// Revoke-all is intentionally limited to a fresh browser session. A leaked API
// token with token-management scope cannot destroy every other credential.
tokens.delete('/tokens', requireAuth, requireClerkSession, revokeAll);
tokens.post('/tokens/revoke-all', requireAuth, requireClerkSession, revokeAll);
