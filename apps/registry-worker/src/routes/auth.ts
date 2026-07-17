import { Hono } from 'hono';
import {
  signedDeviceCode,
  verifySignedDeviceCode,
  deviceUserCode,
  hashToken,
  unauthorized,
  badRequest,
  deviceStartSchema,
  devicePollSchema,
  deviceApproveSchema,
} from '@lemonize/shared';
import type { AppBindings, TokenScope } from '../lib/env.js';
import { rateLimit } from '../lib/ratelimit.js';
import { requireAuth, requireClerkSession, requireReader, bearerFrom } from '../lib/auth.js';
import { registryRepository } from '../lib/registry.js';
import { acquireApiTokenIssuanceLock, createApiToken } from '../lib/api-token.js';
import { consumeDeviceApproval, storeDeviceApproval } from '../lib/device-approval.js';

export const auth = new Hono<AppBindings>();

interface DeviceState {
  userCode: string;
  status: 'approved';
  token: string;
  user: {
    id: string;
    username: string;
    email: string;
    createdAt: string;
  };
}

const DEVICE_TTL_SECONDS = 600;

auth.post('/auth/device/start', async (c) => {
  const cfg = c.get('config');
  await rateLimit(c, 'auth', 30);
  // Parse for backward compatibility with older CLIs, but never trust the
  // optional username. Approval identity comes from Clerk.
  deviceStartSchema.parse(await c.req.json());
  // Domain-separated signing keeps starts stateless (no KV write per login)
  // while still enforcing the advertised server-side expiry.
  const deviceCode = await signedDeviceCode(c.env.SCANNER_SHARED_SECRET);
  const userCode = await deviceUserCode(deviceCode);
  return c.json({
    deviceCode,
    userCode,
    // The owner must compare and manually enter the code shown by the CLI.
    // Putting it in the URL would turn a first-party link into a login-CSRF
    // capability that an attacker could send to the publisher.
    verificationUrl: `${cfg.webBaseUrl}/login`,
    interval: 2,
    expiresAt: new Date(Date.now() + DEVICE_TTL_SECONDS * 1_000).toISOString(),
  });
});

auth.post('/auth/device/approve', requireAuth, requireClerkSession, async (c) => {
  await rateLimit(c, 'auth', 30);
  const body = deviceApproveSchema.parse(await c.req.json());

  const repo = registryRepository(c.env);
  const user = await repo.users.getOrNull(c.get('userId')!);
  if (!user || user.status !== 'active') throw unauthorized();
  const scopes: TokenScope[] =
    user.role === 'publisher' || user.role === 'admin'
      ? ['read', 'publish', 'manage:packages', 'manage:tokens']
      : ['read', 'manage:tokens'];
  const issuanceLock = await acquireApiTokenIssuanceLock(c.env.BUCKET, user.$id);
  const created = await createApiToken(repo, {
    userId: user.$id,
    label: 'CLI device login',
    scopes,
    expiresInDays: 30,
  }).finally(() => c.env.BUCKET.delete(issuanceLock).catch(() => undefined));
  const approved: DeviceState = {
    userCode: body.userCode,
    status: 'approved',
    token: created.token,
    user: {
      id: user.$id,
      username: user.namespace,
      email: user.email,
      createdAt: user.$createdAt,
    },
  };
  await storeDeviceApproval({
    approvals: c.env.DEVICE_APPROVALS,
    repo,
    userCode: body.userCode,
    state: approved,
    tokenId: created.row.$id,
  });
  await repo.appendAudit({
    actorId: user.$id,
    action: 'token.create',
    resourceType: 'token',
    resourceId: created.row.$id,
    detail: `CLI device login scopes=${scopes.join(',')} creator=clerk`,
    requestId: c.get('requestId'),
    ipHash: null,
  }).catch(() => undefined);
  return c.json({ status: 'approved', username: user.namespace });
});

auth.post('/auth/device/poll', async (c) => {
  await rateLimit(c, 'auth', 120);
  const body = devicePollSchema.parse(await c.req.json());
  if (!(await verifySignedDeviceCode(body.deviceCode, c.env.SCANNER_SHARED_SECRET))) {
    throw badRequest('Device code is invalid or expired.');
  }
  const userCode = await deviceUserCode(body.deviceCode);
  const state = await consumeDeviceApproval<DeviceState>(c.env.DEVICE_APPROVALS, userCode);
  if (!state) return c.json({ status: 'pending' });
  if (state.status !== 'approved' || state.userCode !== userCode)
    return c.json({ status: 'pending' });
  return c.json({ status: 'approved', token: state.token, user: state.user });
});

auth.get('/auth/me', requireAuth, requireReader, async (c) => {
  const user = await registryRepository(c.env).users.getOrNull(c.get('userId')!);
  if (!user) throw unauthorized();
  return c.json({
    user: {
      id: user.$id,
      username: user.namespace,
      email: user.email,
      role: user.role,
      createdAt: user.$createdAt,
    },
  });
});

auth.post('/auth/logout', requireAuth, async (c) => {
  if (c.get('authType') !== 'api_token') return c.json({ ok: true });
  const token = bearerFrom(c);
  const tokenId = c.get('tokenId');
  if (token && tokenId) {
    const tokenHash = await hashToken(token);
    await registryRepository(c.env).revokeToken(tokenId);
    await c.env.KV.put(`revoked:${tokenHash}`, '1', { expirationTtl: 86_400 });
  }
  return c.json({ ok: true });
});
