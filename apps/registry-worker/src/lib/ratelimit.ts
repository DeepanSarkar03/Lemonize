import type { Context } from 'hono';
import { rateLimited } from '@lemonize/shared';
import type { AppBindings } from './env.js';

const INTERNAL_ORIGIN = 'https://rate-limit.internal';

interface RateLimitDecision {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
}

async function principalDigest(kind: string, id: string): Promise<string> {
  const bytes = new TextEncoder().encode(`lemonize-rate-limit:v1:${kind}:${id}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Call the one-object-per-principal distributed counter. */
export async function checkDistributedRateLimit(
  namespace: DurableObjectNamespace,
  kind: 'read' | 'write' | 'auth' | 'upload',
  id: string,
  limitPerMinute: number,
): Promise<RateLimitDecision> {
  const objectName = `v1:${kind}:${await principalDigest(kind, id)}`;
  const response = await namespace.getByName(objectName).fetch(`${INTERNAL_ORIGIN}/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit: limitPerMinute }),
  });
  if (!response.ok) {
    throw new Error(`Distributed rate limiter failed with HTTP ${response.status}.`);
  }
  const decision = (await response.json()) as Partial<RateLimitDecision>;
  if (
    typeof decision.allowed !== 'boolean' ||
    !Number.isSafeInteger(decision.count) ||
    !Number.isSafeInteger(decision.limit) ||
    !Number.isSafeInteger(decision.retryAfterSeconds)
  ) {
    throw new Error('Distributed rate limiter returned an invalid response.');
  }
  return decision as RateLimitDecision;
}

/**
 * Globally coordinated fixed-window rate limiting. Durable Object requests for
 * the same principal are serialized, so concurrent Worker isolates cannot
 * race the counter as they could with KV read/modify/write.
 */
export async function rateLimit(
  c: Context<AppBindings>,
  kind: 'read' | 'write' | 'auth' | 'upload',
  limitPerMinute: number,
): Promise<void> {
  const id =
    kind === 'upload'
      ? clientIp(c)
      : (c.get('userId') ?? c.get('tokenId') ?? clientIp(c));
  const decision = await checkDistributedRateLimit(c.env.RATE_LIMITS, kind, id, limitPerMinute);
  if (!decision.allowed) {
    throw rateLimited(`Too many ${kind} requests. Try again shortly.`);
  }
}

export function clientIp(c: Context<AppBindings>): string {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'anonymous'
  );
}
