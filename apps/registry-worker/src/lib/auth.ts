import type { Context, Next } from 'hono';
import { hashToken, unauthorized, forbidden, rateLimited, TOKEN_PREFIX } from '@lemonize/shared';
import { AppwriteError, AppwriteQuery } from './appwrite.js';
import type { RegistryRow, UserData } from './appwrite-types.js';
import { verifyClerkToken } from './clerk-auth.js';
import { type AppBindings, type RegistryRole, type TokenScope } from './env.js';
import { registryRepository } from './registry.js';
import {
  CURRENT_TERMS_VERSION,
  roleForAccount,
  shouldAdoptGithubNamespace,
} from './account-policy.js';
import { checkDistributedRateLimit, clientIp } from './ratelimit.js';
import { activeApiTokenRoot } from './api-token.js';
import {
  authorizedPackageScopes,
  packageScopeReservedForOther,
  profileReconciliationCachePolicy,
  type PackageScopeGrant,
} from './package-scope-grants.js';

const ALL_SCOPES: TokenScope[] = ['read', 'publish', 'manage:packages', 'manage:tokens'];
const NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const tokenTouches = new Map<string, number>();

interface ClerkEmailAddress {
  id?: unknown;
  email_address?: unknown;
}

interface ClerkExternalAccount {
  provider?: unknown;
  username?: unknown;
  provider_user_id?: unknown;
  external_id?: unknown;
}

interface ClerkUserResponse {
  primary_email_address_id?: unknown;
  email_addresses?: unknown;
  external_accounts?: unknown;
  banned?: unknown;
  locked?: unknown;
}

interface ClerkProfile {
  email: string;
  githubUsername: string | null;
  githubId: string | null;
}

/** Read Clerk's current provider user id while accepting its legacy field name. */
export function clerkGithubId(account: unknown): string | null {
  if (!account || typeof account !== 'object' || Array.isArray(account)) return null;
  const external = account as ClerkExternalAccount;
  const value = external.provider_user_id ?? external.external_id;
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
}

class InactiveClerkUserError extends Error {
  constructor() {
    super('Clerk user is not active.');
    this.name = 'InactiveClerkUserError';
  }
}

/** Extract a single bearer credential from the Authorization header. */
export function bearerFrom(c: Context<AppBindings>): string | null {
  const header = c.req.header('authorization');
  const match = header ? /^Bearer\s+([^\s]+)$/i.exec(header.trim()) : null;
  return match?.[1] ?? null;
}

function parseRole(value: string): RegistryRole | null {
  return value === 'consumer' || value === 'publisher' || value === 'admin' ? value : null;
}

function parseScopes(value: string): TokenScope[] | null {
  const values = value.split(',').filter(Boolean);
  if (values.length === 0) return null;
  const scopes = values.filter((scope): scope is TokenScope =>
    ALL_SCOPES.includes(scope as TokenScope),
  );
  return scopes.length === values.length ? [...new Set(scopes)] : null;
}

function setIdentity(
  c: Context<AppBindings>,
  user: RegistryRow<'users'>,
  input: {
    authType: 'clerk' | 'api_token';
    clerkId?: string;
    tokenId?: string;
    tokenParentId?: string;
    tokenRootId?: string;
    tokenScopes: TokenScope[];
    tokenExpiresAt?: string;
  },
): boolean {
  const role = parseRole(user.role);
  if (user.status !== 'active' || role === null) return false;
  c.set('userId', user.$id);
  c.set('clerkId', input.clerkId ?? user.clerkId);
  c.set('email', user.email);
  c.set('namespace', user.namespace);
  c.set(
    'authorizedPackageScopes',
    authorizedPackageScopes({
      namespace: user.namespace,
      githubId: user.githubId,
      grants: c.get('config').packageScopeGrants,
    }),
  );
  c.set('role', role);
  c.set('acceptedTermsVersion', user.acceptedTermsVersion ?? null);
  c.set('tokenId', input.tokenId);
  c.set('tokenParentId', input.tokenParentId);
  c.set('tokenRootId', input.tokenRootId);
  c.set('tokenScopes', input.tokenScopes);
  c.set('tokenExpiresAt', input.tokenExpiresAt);
  c.set('authType', input.authType);
  return true;
}

async function authenticateApiToken(c: Context<AppBindings>, token: string): Promise<boolean> {
  const tokenHash = await hashToken(token);
  try {
    if (await c.env.KV.get(`revoked:${tokenHash}`)) return false;
  } catch {
    // KV is only an acceleration cache. Appwrite remains authoritative.
  }

  const repo = registryRepository(c.env);
  const row = await repo.getTokenByHash(tokenHash);
  if (!row) return false;
  const rootTokenId = await activeApiTokenRoot(repo, row);
  if (!rootTokenId) return false;
  const scopes = parseScopes(row.scopes);
  if (!scopes) return false;
  let user = await repo.users.getOrNull(row.userId);
  if (!user) return false;
  const reconciliationCache = profileReconciliationCachePolicy({
    clerkId: user.clerkId,
    githubId: user.githubId,
    grants: c.get('config').packageScopeGrants,
  });
  let profileRecentlyReconciled = false;
  try {
    profileRecentlyReconciled = (await c.env.KV.get(reconciliationCache.key)) === '1';
  } catch {
    // Fail toward the authoritative Clerk profile rather than stale eligibility.
  }
  if (!profileRecentlyReconciled) {
    try {
      user = await provisionClerkUser(c, user.clerkId);
    } catch (error) {
      if (!(error instanceof InactiveClerkUserError)) throw error;
      await repo.users.update(user.$id, { status: 'clerk_suspended' }).catch(() => undefined);
      await c.env.KV.put(`clerk-active:${user.clerkId}`, '0', { expirationTtl: 60 }).catch(
        () => undefined,
      );
      return false;
    }
    await c.env.KV.put(reconciliationCache.key, '1', {
      expirationTtl: reconciliationCache.ttlSeconds,
    }).catch(() => undefined);
  }
  if (!(await clerkUserIsActive(c, user))) return false;
  const reconciledRole = roleForAccount(c.get('config'), {
    clerkId: user.clerkId,
    githubId: user.githubId,
    existingRole: user.role,
  });
  if (user.role !== reconciledRole) {
    await repo.users.update(user.$id, { role: reconciledRole });
    user.role = reconciledRole;
  }

  if (
    !setIdentity(c, user, {
      authType: 'api_token',
      tokenId: row.$id,
      tokenParentId: row.parentTokenId ?? undefined,
      tokenRootId: rootTokenId,
      tokenScopes: scopes,
      tokenExpiresAt: row.expiresAt,
    })
  ) {
    return false;
  }
  const lastTouch = tokenTouches.get(row.$id) ?? 0;
  if (Date.now() - lastTouch > 60 * 60_000) {
    tokenTouches.set(row.$id, Date.now());
    if (tokenTouches.size > 10_000) tokenTouches.clear();
    c.executionCtx.waitUntil(repo.touchToken(row.$id).catch(() => undefined));
  }
  return true;
}

async function fetchClerkUser(
  env: AppBindings['Bindings'],
  clerkId: string,
): Promise<ClerkUserResponse | null> {
  if (!env.CLERK_SECRET_KEY) throw new Error('Clerk backend key is not configured.');
  const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(clerkId)}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${env.CLERK_SECRET_KEY}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Clerk user lookup failed.');
  return (await response.json()) as ClerkUserResponse;
}

async function fetchClerkProfile(
  env: AppBindings['Bindings'],
  clerkId: string,
): Promise<ClerkProfile> {
  const body = await fetchClerkUser(env, clerkId);
  if (!body || body.banned === true || body.locked === true) {
    throw new InactiveClerkUserError();
  }

  const addresses = Array.isArray(body.email_addresses)
    ? (body.email_addresses as ClerkEmailAddress[])
    : [];
  const primary =
    addresses.find((item) => item.id === body.primary_email_address_id) ?? addresses[0];
  const email =
    typeof primary?.email_address === 'string' ? primary.email_address.toLowerCase() : '';
  if (!email || email.length > 320) throw new Error('Clerk user has no usable email address.');

  const external = Array.isArray(body.external_accounts)
    ? (body.external_accounts as ClerkExternalAccount[])
    : [];
  const github = external.find(
    (item) => item.provider === 'oauth_github' || item.provider === 'github',
  );
  const githubUsername =
    typeof github?.username === 'string' && github.username.length <= 64
      ? github.username.toLowerCase()
      : null;
  const githubId = clerkGithubId(github);
  return { email, githubUsername, githubId };
}

async function clerkUserIsActive(
  c: Context<AppBindings>,
  user: RegistryRow<'users'>,
): Promise<boolean> {
  const key = `clerk-active:${user.clerkId}`;
  let cached: string | null = null;
  try {
    cached = await c.env.KV.get(key);
  } catch {
    // Fall through to the authoritative Clerk lookup.
  }
  let active: boolean;
  if (cached === '1' || cached === '0') {
    active = cached === '1';
  } else {
    const clerkUser = await fetchClerkUser(c.env, user.clerkId);
    active = Boolean(clerkUser && clerkUser.banned !== true && clerkUser.locked !== true);
    await c.env.KV.put(key, active ? '1' : '0', { expirationTtl: active ? 900 : 60 }).catch(
      () => undefined,
    );
  }

  const repo = registryRepository(c.env);
  if (!active) {
    if (user.status === 'active') {
      await repo.users.update(user.$id, { status: 'clerk_suspended' }).catch(() => undefined);
    }
    return false;
  }
  if (user.status === 'clerk_suspended') {
    await repo.users.update(user.$id, { status: 'active' });
    user.status = 'active';
  }
  return true;
}

export function normalizedNamespace(value: string | null): string | null {
  if (!value) return null;
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return NAMESPACE_PATTERN.test(normalized) ? normalized : null;
}

export async function namespaceWithSuffix(base: string, stableIdentityId: string): Promise<string> {
  const suffix = (await hashToken(`namespace:${stableIdentityId}`)).slice(0, 10);
  return `${base.slice(0, 53).replace(/-+$/g, '')}-${suffix}`;
}

async function namespaceWithUnreservedSuffix(input: {
  base: string;
  stableIdentityId: string;
  githubId?: string | null;
  grants: readonly PackageScopeGrant[];
  startAttempt?: number;
}): Promise<string> {
  for (let attempt = input.startAttempt ?? 0; attempt < 10; attempt += 1) {
    const seed = attempt === 0 ? input.stableIdentityId : `${input.stableIdentityId}:${attempt}`;
    const candidate = await namespaceWithSuffix(input.base, seed);
    if (
      !packageScopeReservedForOther({
        grants: input.grants,
        scope: candidate,
        githubId: input.githubId,
      })
    ) {
      return candidate;
    }
  }
  throw new Error('Unable to allocate a namespace outside protected package scopes.');
}

export async function provisionalNamespace(clerkId: string): Promise<string> {
  return `user-${(await hashToken(`provisional:${clerkId}`)).slice(0, 12)}`;
}

async function provisionClerkUser(
  c: Context<AppBindings>,
  clerkId: string,
): Promise<RegistryRow<'users'>> {
  const repo = registryRepository(c.env);
  const profile = await fetchClerkProfile(c.env, clerkId);
  const existingByClerk = await repo.getUserByClerkId(clerkId);
  const existingByGithub = profile.githubId ? await repo.getUserByGithubId(profile.githubId) : null;
  if (existingByClerk && existingByGithub && existingByClerk.$id !== existingByGithub.$id) {
    throw new Error('The linked GitHub account already belongs to another registry identity.');
  }
  const existing = existingByClerk ?? existingByGithub;
  const cfg = c.get('config');
  const now = new Date().toISOString();
  const role = roleForAccount(cfg, {
    clerkId,
    githubId: profile.githubId,
    existingRole: existing?.role,
  });
  if (existing) {
    let mayAdoptGithubNamespace = shouldAdoptGithubNamespace({
      namespaceClaimedAt: existing.namespaceClaimedAt,
      previousGithubId: existing.githubId,
      nextGithubId: profile.githubId,
      packageCount: existing.packageCount,
    });
    if (mayAdoptGithubNamespace) {
      const owned = await repo.listPackagesByOwner(existing.$id, {
        total: false,
        // The counter is a fast path, but ownership is authoritative for this
        // one-time freeze decision.
        queries: [AppwriteQuery.limit(1)],
      });
      mayAdoptGithubNamespace = owned.rows.length === 0;
    }
    const githubBase = normalizedNamespace(profile.githubUsername);
    let adoptedNamespace: string | undefined;
    if (mayAdoptGithubNamespace && profile.githubId) {
      const base = githubBase ?? (await provisionalNamespace(clerkId));
      const occupied = await repo.getUserByNamespace(base);
      const grantReserved = packageScopeReservedForOther({
        grants: cfg.packageScopeGrants,
        scope: base,
        githubId: profile.githubId,
      });
      adoptedNamespace =
        (!occupied || occupied.$id === existing.$id) && !grantReserved
          ? base
          : await namespaceWithUnreservedSuffix({
              base,
              stableIdentityId: profile.githubId,
              githubId: profile.githubId,
              grants: cfg.packageScopeGrants,
            });
    }
    const needsNamespaceClaimMarker =
      !existing.namespaceClaimedAt && Boolean(existing.githubId || mayAdoptGithubNamespace);
    if (
      existing.clerkId === clerkId &&
      existing.email.toLowerCase() === profile.email &&
      existing.githubUsername === profile.githubUsername &&
      existing.githubId === profile.githubId &&
      existing.role === role &&
      adoptedNamespace === undefined &&
      !needsNamespaceClaimMarker
    ) {
      return existing;
    }
    // The namespace is deliberately absent from this update. Once allocated,
    // email, GitHub username, and even the Clerk user record may change without
    // changing package ownership or install coordinates.
    const update: Partial<UserData> = {
      clerkId,
      email: profile.email,
      githubUsername: profile.githubUsername,
      githubId: profile.githubId,
      role,
      lastLoginAt: now,
      ...(existing.namespaceClaimedAt || existing.githubId || mayAdoptGithubNamespace
        ? { namespaceClaimedAt: existing.namespaceClaimedAt ?? now }
        : {}),
      ...(adoptedNamespace ? { namespace: adoptedNamespace } : {}),
    };
    try {
      return await repo.users.update(existing.$id, update);
    } catch (error) {
      if (
        !(error instanceof AppwriteError) ||
        error.status !== 409 ||
        !adoptedNamespace ||
        !profile.githubId ||
        !githubBase
      ) {
        throw error;
      }
      // A concurrent claimant won the friendly namespace. The deterministic
      // external-id suffix is the only retry and is stable across sessions.
      return repo.users.update(existing.$id, {
        ...update,
        namespace: await namespaceWithUnreservedSuffix({
          base: githubBase,
          stableIdentityId: profile.githubId,
          githubId: profile.githubId,
          grants: cfg.packageScopeGrants,
          startAttempt: adoptedNamespace === githubBase ? 0 : 1,
        }),
      });
    }
  }

  const preferredNamespace =
    normalizedNamespace(profile.githubUsername) ?? (await provisionalNamespace(clerkId));
  const initialNamespace = packageScopeReservedForOther({
    grants: cfg.packageScopeGrants,
    scope: preferredNamespace,
    githubId: profile.githubId,
  })
    ? await namespaceWithUnreservedSuffix({
        base: preferredNamespace,
        stableIdentityId: profile.githubId ?? clerkId,
        githubId: profile.githubId,
        grants: cfg.packageScopeGrants,
      })
    : preferredNamespace;
  const data = (namespace: string): UserData => ({
    clerkId,
    email: profile.email,
    githubUsername: profile.githubUsername,
    githubId: profile.githubId,
    namespace,
    namespaceClaimedAt: profile.githubId ? now : null,
    status: 'active',
    role,
    storageBytes: 0,
    packageCount: 0,
    acceptedTermsAt: null,
    acceptedTermsVersion: null,
    lastLoginAt: now,
  });

  try {
    return await repo.users.create(data(initialNamespace));
  } catch (error) {
    if (!(error instanceof AppwriteError) || error.status !== 409) throw error;
    const raced = await repo.getUserByClerkId(clerkId);
    if (raced) return raced;
    if (profile.githubId) {
      const githubRace = await repo.getUserByGithubId(profile.githubId);
      if (githubRace) return githubRace;
    }
    return repo.users.create(
      data(
        await namespaceWithUnreservedSuffix({
          base: preferredNamespace,
          stableIdentityId: profile.githubId ?? clerkId,
          githubId: profile.githubId,
          grants: cfg.packageScopeGrants,
          startAttempt: initialNamespace === preferredNamespace ? 0 : 1,
        }),
      ),
    );
  }
}

/**
 * Refresh a stored registry identity from Clerk without consulting the API-token
 * reconciliation cache. Security-sensitive background work uses this immediately
 * before making an artifact public so a GitHub unlink or account suspension fails
 * closed even when the upload was authorized earlier.
 */
export async function refreshClerkUserForAuthorization(
  c: Context<AppBindings>,
  clerkId: string,
): Promise<RegistryRow<'users'>> {
  return provisionClerkUser(c, clerkId);
}

async function authenticateClerk(c: Context<AppBindings>, token: string): Promise<boolean> {
  const cfg = c.get('config');
  if (!cfg.clerkIssuer || cfg.clerkAuthorizedParties.length === 0) return false;
  try {
    const verified = await verifyClerkToken(token, {
      issuer: cfg.clerkIssuer,
      authorizedParties: cfg.clerkAuthorizedParties,
    });
    const user = await provisionClerkUser(c, verified.userId);
    await c.env.KV.put(`clerk-profile-reconciled:${user.clerkId}`, '1', {
      expirationTtl: 900,
    }).catch(() => undefined);
    if (!(await clerkUserIsActive(c, user))) return false;
    if (
      !setIdentity(c, user, {
        authType: 'clerk',
        clerkId: verified.userId,
        tokenScopes: ALL_SCOPES,
      })
    )
      return false;
    c.executionCtx.waitUntil(
      registryRepository(c.env)
        .users.update(user.$id, { lastLoginAt: new Date().toISOString() })
        .catch(() => undefined),
    );
    return true;
  } catch {
    return false;
  }
}

/** Authenticate either a short-lived Lemonize API token or a Clerk session JWT. */
export async function authenticate(c: Context<AppBindings>): Promise<boolean> {
  const token = bearerFrom(c);
  if (!token) return false;
  if (token.length > 4096) return false;
  if (token.startsWith(TOKEN_PREFIX) && !/^lem_live_[A-Za-z0-9_-]{43}$/.test(token)) {
    return false;
  }
  const decision = await checkDistributedRateLimit(c.env.RATE_LIMITS, 'auth', clientIp(c), 300);
  if (!decision.allowed) {
    throw rateLimited('Too many authentication attempts. Try again shortly.');
  }
  return token.startsWith(TOKEN_PREFIX)
    ? authenticateApiToken(c, token)
    : authenticateClerk(c, token);
}

export async function requireAuth(c: Context<AppBindings>, next: Next) {
  if (!(await authenticate(c))) throw unauthorized();
  await next();
}

/** Credential issuance requires a fresh Clerk browser session, never an API token. */
export async function requireClerkSession(c: Context<AppBindings>, next: Next) {
  if (c.get('authType') !== 'clerk') {
    throw forbidden('A Clerk browser session is required for this action.');
  }
  await next();
}

export function hasScope(c: Context<AppBindings>, scope: TokenScope): boolean {
  return c.get('authType') === 'clerk' || (c.get('tokenScopes') ?? []).includes(scope);
}

export async function requireTokenManager(c: Context<AppBindings>, next: Next) {
  if (!hasScope(c, 'manage:tokens')) throw forbidden('This credential cannot manage API tokens.');
  await next();
}

export async function requireReader(c: Context<AppBindings>, next: Next) {
  if (!hasScope(c, 'read')) throw forbidden('This credential cannot read account data.');
  await next();
}

export async function requirePackageManager(c: Context<AppBindings>, next: Next) {
  if (!hasScope(c, 'manage:packages')) {
    throw forbidden('This credential cannot maintain packages.');
  }
  await next();
}

export async function requirePublisher(c: Context<AppBindings>, next: Next) {
  if (c.get('config').registryMode === 'read_only') {
    throw forbidden('Publishing is temporarily disabled for this registry.');
  }
  if (!hasScope(c, 'publish')) throw forbidden('This credential cannot publish packages.');
  if (c.get('acceptedTermsVersion') !== CURRENT_TERMS_VERSION) {
    throw forbidden('Sign in on the web to accept the current terms before publishing.');
  }
  if (c.get('role') !== 'publisher' && c.get('role') !== 'admin') {
    throw forbidden('Your account is not approved to publish packages.');
  }
  await next();
}
