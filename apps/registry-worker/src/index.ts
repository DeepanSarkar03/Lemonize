import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ulid } from '@lemonize/shared';
import type { AppBindings, Env } from './lib/env.js';
import { loadConfig } from './lib/env.js';
import { handleError } from './lib/errors.js';
import { health } from './routes/health.js';
import { cli } from './routes/cli.js';
import { meta } from './routes/meta.js';
import { packages } from './routes/packages.js';
import { tarball } from './routes/tarball.js';
import { auth } from './routes/auth.js';
import { tokens } from './routes/tokens.js';
import { internalScan, maintainPublishingState, publish } from './routes/publish.js';
import { maintenance } from './routes/maintenance.js';
import { account } from './routes/account.js';
import { cleanupRegistryRetention } from './lib/retention.js';

export { DeviceApprovalObject } from './durable-objects/device-approval.js';
export { RateLimitObject } from './durable-objects/rate-limit.js';

const app = new Hono<AppBindings>();
const boundedJsonBody = bodyLimit({
  maxSize: 512 * 1024,
  onError: (c) =>
    c.json(
      {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request body exceeds 512 KiB.',
          requestId: c.get('requestId') ?? 'unknown',
        },
      },
      413,
    ),
});

// Request id + config on every request.
app.use('*', async (c, next) => {
  c.set('requestId', ulid());
  c.set('config', loadConfig(c.env));
  await next();
  c.header('x-request-id', c.get('requestId'));
});

// Stream and bound every non-artifact request body, including chunked bodies.
app.use('*', (c, next) => {
  const path = new URL(c.req.url).pathname;
  const isArtifactUpload = c.req.method === 'PUT' && path.startsWith('/v1/uploads/');
  return isArtifactUpload ? next() : boundedJsonBody(c, next);
});

// Restricted CORS by env allowlist. Never reflects arbitrary origins.
app.use('*', async (c, next) => {
  const cfg = c.get('config');
  const origin = c.req.header('origin');
  if (origin && cfg.corsAllowedOrigins.includes(origin)) {
    c.header('access-control-allow-origin', origin);
    c.header('vary', 'origin');
    c.header('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    c.header('access-control-allow-headers', 'authorization,content-type,x-lemonize-upload-token');
    c.header('access-control-max-age', '86400');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

// Baseline security headers.
app.use('*', async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
  c.header('x-frame-options', 'DENY');
  c.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
});

// Credential and account responses are never cacheable, even by a private intermediary.
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  await next();
  if (
    path.startsWith('/v1/auth/') ||
    path === '/v1/tokens' ||
    path.startsWith('/v1/tokens/') ||
    path === '/v1/account' ||
    path.startsWith('/v1/account/') ||
    path === '/v1/reports' ||
    path.includes('/publish/status') ||
    path.endsWith('/status')
  ) {
    c.header('cache-control', 'private, no-store');
    c.header('pragma', 'no-cache');
  }
});

app.route('/', health);
app.route('/', cli); // npm-backed install.sh and install.ps1 bootstraps
app.route('/', internalScan); // HMAC-authenticated Appwrite scanner protocol
app.route('/v1', meta);
app.route('/v1', auth);
app.route('/v1', tokens);
app.route('/v1', account);
app.route('/v1', publish); // POST /packages, versions intent, uploads, finalize
app.route('/v1', maintenance); // dist-tags, deprecate, unpublish
app.route('/v1', tarball); // download gateway (before generic package reads)
app.route('/v1', packages); // generic read endpoints

app.notFound((c) =>
  c.json(
    { error: { code: 'NOT_FOUND', message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}`, requestId: c.get('requestId') ?? 'unknown' } },
    404,
  ),
);

app.onError((err, c) => handleError(err, c));

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([maintainPublishingState(env), cleanupRegistryRetention(env)]));
  },
};
