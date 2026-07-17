import { Hono, type Context } from 'hono';
import type { AppBindings } from '../lib/env.js';
import { AppwriteQuery } from '../lib/appwrite.js';
import { registryRepository } from '../lib/registry.js';

export const health = new Hono<AppBindings>();

interface ReadinessResult {
  ready: boolean;
  dependencies: Record<string, string>;
  checkedAt: string;
}

let readinessCache: { expiresAt: number; result: ReadinessResult } | null = null;
let readinessInFlight: Promise<ReadinessResult> | null = null;

async function checkReadiness(c: Context<AppBindings>): Promise<ReadinessResult> {
  const checks = await Promise.allSettled([
    registryRepository(c.env).users.list({ queries: [AppwriteQuery.limit(1)], total: false }),
    c.env.KV.get('__readiness__'),
    c.env.BUCKET.head('__readiness__'),
  ]);
  const dependencies = {
    appwrite: checks[0]!.status === 'fulfilled' ? 'ok' : 'error',
    kv: checks[1]!.status === 'fulfilled' ? 'ok' : 'error',
    r2: checks[2]!.status === 'fulfilled' ? 'ok' : 'error',
  };
  return {
    ready: checks.every((result) => result.status === 'fulfilled'),
    dependencies,
    checkedAt: new Date().toISOString(),
  };
}

health.get('/health', (c) => {
  c.header('cache-control', 'no-store');
  return c.json({ status: 'ok', service: 'lemonize-registry', time: new Date().toISOString() });
});

health.get('/ready', async (c) => {
  c.header('cache-control', 'no-store');
  let result = readinessCache?.expiresAt && readinessCache.expiresAt > Date.now()
    ? readinessCache.result
    : null;
  if (!result) {
    readinessInFlight ??= checkReadiness(c);
    try {
      result = await readinessInFlight;
      readinessCache = { expiresAt: Date.now() + 15_000, result };
    } finally {
      readinessInFlight = null;
    }
  }
  return c.json(
    {
      status: result.ready ? 'ready' : 'degraded',
      service: 'lemonize-registry',
      dependencies: result.dependencies,
      time: result.checkedAt,
    },
    result.ready ? 200 : 503,
  );
});
