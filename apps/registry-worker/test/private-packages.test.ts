import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KVNamespace } from '@cloudflare/workers-types';
import type { Env } from '../src/lib/env.js';
import {
  clerkSubscriptionHasPaidFeature,
  hasPaidPrivatePackageEntitlement,
  packageVisibility,
} from '../src/lib/private-packages.js';

const feature = { slug: 'private-packages' };

function paidItem(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    plan_period: 'month',
    payer_id: 'user_paid',
    is_free_trial: false,
    plan: {
      is_default: false,
      is_recurring: true,
      has_base_fee: true,
      fee: { amount: 900 },
      annual_fee: { amount: 9_000 },
      features: [feature],
    },
    ...overrides,
  };
}

function subscription(...items: unknown[]) {
  return {
    status: 'active',
    payer_id: 'user_paid',
    subscription_items: items,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('private package policy', () => {
  it('treats missing legacy visibility as public and malformed values as private', () => {
    expect(packageVisibility({ visibility: undefined })).toBe('public');
    expect(packageVisibility({ visibility: null })).toBe('public');
    expect(packageVisibility({ visibility: 'public' })).toBe('public');
    expect(packageVisibility({ visibility: 'private' })).toBe('private');
    expect(packageVisibility({ visibility: 'unexpected' as 'private' })).toBe('private');
  });

  it('accepts only an active, recurring, non-default paid Clerk plan with the feature', () => {
    expect(
      clerkSubscriptionHasPaidFeature(subscription(paidItem()), feature.slug, 'user_paid'),
    ).toBe(true);
    expect(
      clerkSubscriptionHasPaidFeature(
        subscription(paidItem({ plan_period: 'annual' })),
        feature.slug,
        'user_paid',
      ),
    ).toBe(true);

    for (const item of [
      paidItem({ status: 'past_due' }),
      paidItem({ is_free_trial: true }),
      paidItem({ payer_id: 'user_other' }),
      paidItem({ plan: { ...paidItem().plan, is_default: true } }),
      paidItem({ plan: { ...paidItem().plan, is_recurring: false } }),
      paidItem({ plan: { ...paidItem().plan, has_base_fee: false } }),
      paidItem({ plan: { ...paidItem().plan, fee: { amount: 0 } } }),
      paidItem({ plan: { ...paidItem().plan, features: [{ slug: 'other' }] } }),
    ]) {
      expect(clerkSubscriptionHasPaidFeature(subscription(item), feature.slug, 'user_paid')).toBe(
        false,
      );
    }
    expect(
      clerkSubscriptionHasPaidFeature(
        { ...subscription(paidItem()), status: 'past_due' },
        feature.slug,
        'user_paid',
      ),
    ).toBe(false);
    expect(
      clerkSubscriptionHasPaidFeature(
        { ...subscription(paidItem()), payer_id: 'user_other' },
        feature.slug,
        'user_paid',
      ),
    ).toBe(false);
    expect(clerkSubscriptionHasPaidFeature({ subscription_items: 'invalid' }, feature.slug)).toBe(
      false,
    );
  });

  it('queries Clerk server-side, excludes free items, and caches a bounded decision', async () => {
    const values = new Map<string, string>();
    const put = vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    });
    const kv = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put,
    } as unknown as KVNamespace;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      expect(url.pathname).toBe('/v1/users/user_paid/billing/subscription');
      expect(url.search).toBe('');
      const headers = new Headers(init?.headers);
      expect(headers.get('Clerk-API-Version')).toBe('2026-05-12');
      expect(headers.get('Authorization')).toBe('Bearer test-secret');
      return Response.json(subscription(paidItem()));
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = { KV: kv, CLERK_SECRET_KEY: 'test-secret' } as Env;
    const config = {
      allowPrivatePackages: true,
      privatePackagesFeature: feature.slug,
    };

    await expect(hasPaidPrivatePackageEntitlement(env, config, 'user_paid')).resolves.toBe(true);
    await expect(hasPaidPrivatePackageEntitlement(env, config, 'user_paid')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).not.toContain('user_paid');
    expect(put.mock.calls[0]?.[2]).toEqual({ expirationTtl: 30 });
  });

  it('fails closed when Clerk cannot authoritatively answer', async () => {
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 503 })),
    );
    await expect(
      hasPaidPrivatePackageEntitlement(
        { KV: kv, CLERK_SECRET_KEY: 'test-secret' } as Env,
        { allowPrivatePackages: true, privatePackagesFeature: feature.slug },
        'user_paid',
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(kv.put).not.toHaveBeenCalled();
  });
});
