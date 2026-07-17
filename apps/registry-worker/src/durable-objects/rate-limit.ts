import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../lib/env.js';

const COUNTER_KEY = 'counter';
const WINDOW_MS = 60_000;

interface Counter {
  count: number;
  expiresAt: number;
  window: number;
}

interface CheckBody {
  limit: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function isCheckBody(value: unknown): value is CheckBody {
  if (!value || typeof value !== 'object') return false;
  const limit = (value as Partial<CheckBody>).limit;
  return Number.isSafeInteger(limit) && (limit ?? 0) > 0 && (limit ?? 0) <= 1_000_000;
}

function isCounter(value: unknown): value is Counter {
  if (!value || typeof value !== 'object') return false;
  const counter = value as Partial<Counter>;
  return (
    Number.isSafeInteger(counter.count) &&
    (counter.count ?? -1) >= 0 &&
    Number.isFinite(counter.expiresAt) &&
    Number.isSafeInteger(counter.window)
  );
}

/** A globally serialized fixed-window counter for one kind + principal. */
export class RateLimitObject extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/check') {
      return json({ error: 'Not found' }, 404);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    if (!isCheckBody(body)) return json({ error: 'Invalid rate limit' }, 400);

    const now = Date.now();
    const window = Math.floor(now / WINDOW_MS);
    const expiresAt = (window + 1) * WINDOW_MS;
    const decision = await this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<unknown>(COUNTER_KEY);
      const current = isCounter(stored) && stored.window === window ? stored.count : 0;
      if (current >= body.limit) {
        return { allowed: false, count: current };
      }
      const count = current + 1;
      await txn.put<Counter>(COUNTER_KEY, { count, expiresAt, window });
      await txn.setAlarm(expiresAt);
      return { allowed: true, count };
    });

    return json({
      ...decision,
      limit: body.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1_000)),
    });
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<unknown>(COUNTER_KEY);
      if (!isCounter(stored) || stored.expiresAt <= Date.now()) {
        await txn.delete(COUNTER_KEY);
        await txn.deleteAlarm();
        return;
      }
      await txn.setAlarm(stored.expiresAt);
    });
  }
}
