import { ErrorCodes, LemonizeError, hashToken } from '@lemonize/shared';
import type { Context } from 'hono';
import type { AppBindings, Config } from './env.js';
import type { AppwriteRow, PackageData } from './appwrite-types.js';

const POSITIVE_CACHE_SECONDS = 30;
const NEGATIVE_CACHE_SECONDS = 30;

interface ClerkFeatureJson {
  slug?: unknown;
}

interface ClerkMoneyJson {
  amount?: unknown;
}

interface ClerkPlanJson {
  is_default?: unknown;
  is_recurring?: unknown;
  has_base_fee?: unknown;
  fee?: ClerkMoneyJson | null;
  annual_fee?: ClerkMoneyJson | null;
  features?: unknown;
}

interface ClerkSubscriptionItemJson {
  status?: unknown;
  plan_period?: unknown;
  payer_id?: unknown;
  is_free_trial?: unknown;
  plan?: ClerkPlanJson | null;
}

interface ClerkSubscriptionJson {
  status?: unknown;
  payer_id?: unknown;
  subscription_items?: unknown;
}

export function packageVisibility(pkg: Pick<PackageData, 'visibility'>): 'public' | 'private' {
  // Existing rows predate the column and are public. Any unexpected non-null
  // value fails toward private handling instead of becoming anonymously read.
  return pkg.visibility === 'public' || pkg.visibility == null ? 'public' : 'private';
}

export function isPrivatePackage(pkg: Pick<PackageData, 'visibility'>): boolean {
  return packageVisibility(pkg) === 'private';
}

function paidPlanAmount(item: ClerkSubscriptionItemJson, plan: ClerkPlanJson): number {
  const amount = item.plan_period === 'annual' ? plan.annual_fee?.amount : plan.fee?.amount;
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
}

/**
 * Clerk is authoritative for paid access. A feature on the free/default Plan,
 * a zero-priced Plan, a past-due subscription, or malformed response never
 * grants private-package access.
 */
export function clerkSubscriptionHasPaidFeature(
  value: unknown,
  featureSlug: string,
  expectedPayerId?: string,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const subscription = value as ClerkSubscriptionJson;
  if (subscription.status !== 'active' || !Array.isArray(subscription.subscription_items)) {
    return false;
  }
  if (expectedPayerId && subscription.payer_id !== expectedPayerId) return false;

  return (subscription.subscription_items as ClerkSubscriptionItemJson[]).some((item) => {
    if (!item || typeof item !== 'object' || item.status !== 'active') return false;
    if (item.is_free_trial === true) return false;
    if (expectedPayerId && item.payer_id !== undefined && item.payer_id !== expectedPayerId) {
      return false;
    }
    const plan = item.plan;
    if (!plan || typeof plan !== 'object') return false;
    if (plan.is_default !== false || plan.is_recurring !== true || plan.has_base_fee !== true) {
      return false;
    }
    if (paidPlanAmount(item, plan) <= 0 || !Array.isArray(plan.features)) return false;
    return (plan.features as ClerkFeatureJson[]).some(
      (feature) => feature && typeof feature === 'object' && feature.slug === featureSlug,
    );
  });
}

async function entitlementCacheKey(clerkId: string, featureSlug: string): Promise<string> {
  return `private-package-entitlement:${await hashToken(`${clerkId}:${featureSlug}`)}`;
}

export async function hasPaidPrivatePackageEntitlement(
  env: AppBindings['Bindings'],
  config: Pick<Config, 'allowPrivatePackages' | 'privatePackagesFeature'>,
  clerkId: string,
): Promise<boolean> {
  if (!config.allowPrivatePackages || !config.privatePackagesFeature) return false;
  const key = await entitlementCacheKey(clerkId, config.privatePackagesFeature);
  try {
    const cached = await env.KV.get(key);
    if (cached === '1') return true;
    if (cached === '0') return false;
  } catch {
    // Continue to Clerk. Cache availability must not decide paid access.
  }

  if (!env.CLERK_SECRET_KEY) {
    throw new LemonizeError(
      503,
      ErrorCodes.INTERNAL,
      'Private-package entitlement could not be verified.',
    );
  }

  let response: Response;
  try {
    const endpoint = new URL(
      `https://api.clerk.com/v1/users/${encodeURIComponent(clerkId)}/billing/subscription`,
    );
    response = await fetch(endpoint, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${env.CLERK_SECRET_KEY}`,
        'Clerk-API-Version': '2026-05-12',
      },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new LemonizeError(
      503,
      ErrorCodes.INTERNAL,
      'Private-package entitlement could not be verified.',
    );
  }

  let entitled = false;
  if (response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new LemonizeError(
        503,
        ErrorCodes.INTERNAL,
        'Private-package entitlement could not be verified.',
      );
    }
    entitled = clerkSubscriptionHasPaidFeature(body, config.privatePackagesFeature, clerkId);
  } else if (response.status !== 404) {
    throw new LemonizeError(
      503,
      ErrorCodes.INTERNAL,
      'Private-package entitlement could not be verified.',
    );
  }

  await env.KV.put(key, entitled ? '1' : '0', {
    expirationTtl: entitled ? POSITIVE_CACHE_SECONDS : NEGATIVE_CACHE_SECONDS,
  }).catch(() => undefined);
  return entitled;
}

export async function requirePaidPrivatePackageEntitlement(c: Context<AppBindings>): Promise<void> {
  const config = c.get('config');
  if (!config.allowPrivatePackages || !config.privatePackagesFeature) {
    throw new LemonizeError(
      403,
      ErrorCodes.FEATURE_DISABLED,
      'Private packages are not enabled on this registry.',
    );
  }
  const clerkId = c.get('clerkId');
  if (!clerkId || !(await hasPaidPrivatePackageEntitlement(c.env, config, clerkId))) {
    throw new LemonizeError(
      402,
      ErrorCodes.PAYMENT_REQUIRED,
      'A paid plan with the private-packages feature is required.',
    );
  }
}

/** Private bytes are tenant-isolated to their authenticated, paid owner. */
export async function requirePrivatePackageRead(
  c: Context<AppBindings>,
  pkg: AppwriteRow<PackageData>,
): Promise<void> {
  const userId = c.get('userId');
  if (!userId || pkg.ownerId !== userId) {
    throw new LemonizeError(404, ErrorCodes.PACKAGE_NOT_FOUND, `Package ${pkg.name} was not found`);
  }
  await requirePaidPrivatePackageEntitlement(c);
}
