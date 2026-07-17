import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { checkDistributedRateLimit } from '../src/lib/ratelimit.js';

describe('distributed rate limiter', () => {
  it('allows exactly the configured number under concurrent requests', async () => {
    const principal = `concurrent-${crypto.randomUUID()}`;
    const decisions = await Promise.all(
      Array.from({ length: 12 }, () =>
        checkDistributedRateLimit(env.RATE_LIMITS, 'auth', principal, 3),
      ),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(9);
    expect(decisions.every((decision) => decision.limit === 3)).toBe(true);
  });

  it('keeps counters independent by principal and request kind', async () => {
    const principal = `isolation-${crypto.randomUUID()}`;
    const firstAuth = await checkDistributedRateLimit(env.RATE_LIMITS, 'auth', principal, 1);
    const secondAuth = await checkDistributedRateLimit(env.RATE_LIMITS, 'auth', principal, 1);
    const firstWrite = await checkDistributedRateLimit(env.RATE_LIMITS, 'write', principal, 1);
    const otherPrincipal = await checkDistributedRateLimit(
      env.RATE_LIMITS,
      'auth',
      `${principal}-other`,
      1,
    );

    expect(firstAuth.allowed).toBe(true);
    expect(secondAuth.allowed).toBe(false);
    expect(firstWrite.allowed).toBe(true);
    expect(otherPrincipal.allowed).toBe(true);
  });
});
