import { RESERVED_NAMES } from '@lemonize/shared';

export interface PackageScopeGrant {
  scope: string;
  githubId: string;
}

const MAX_GRANTS = 100;
const MAX_CONFIG_BYTES = 16 * 1024;
const PACKAGE_SCOPE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const GITHUB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validatedPackageScopeGrants(raw: string | undefined): PackageScopeGrant[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('PACKAGE_SCOPE_GRANTS_JSON is required and must be nonblank.');
  }
  const source = raw.trim();
  if (new TextEncoder().encode(source).byteLength > MAX_CONFIG_BYTES) {
    throw new Error('PACKAGE_SCOPE_GRANTS_JSON exceeds 16 KiB.');
  }

  const value: unknown = JSON.parse(source);
  if (!Array.isArray(value) || value.length > MAX_GRANTS) {
    throw new Error('PACKAGE_SCOPE_GRANTS_JSON must be an array of at most 100 grants.');
  }

  const scopes = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`PACKAGE_SCOPE_GRANTS_JSON entry ${index} must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 2 || keys[0] !== 'githubId' || keys[1] !== 'scope') {
      throw new Error(
        `PACKAGE_SCOPE_GRANTS_JSON entry ${index} must contain only scope and githubId.`,
      );
    }
    if (typeof record.scope !== 'string' || !PACKAGE_SCOPE.test(record.scope)) {
      throw new Error(`PACKAGE_SCOPE_GRANTS_JSON entry ${index} has an invalid scope.`);
    }
    if (RESERVED_NAMES.has(record.scope)) {
      throw new Error(`PACKAGE_SCOPE_GRANTS_JSON entry ${index} uses a reserved scope.`);
    }
    if (typeof record.githubId !== 'string' || !GITHUB_ID.test(record.githubId)) {
      throw new Error(`PACKAGE_SCOPE_GRANTS_JSON entry ${index} has an invalid githubId.`);
    }
    if (scopes.has(record.scope)) {
      throw new Error(`PACKAGE_SCOPE_GRANTS_JSON assigns scope ${record.scope} more than once.`);
    }
    scopes.add(record.scope);
    return { scope: record.scope, githubId: record.githubId };
  });
}

/** Parse the complete grant set. Invalid configuration must prevent startup. */
export function parsePackageScopeGrants(raw: string | undefined): PackageScopeGrant[] {
  return validatedPackageScopeGrants(raw);
}

export function authorizedPackageScopes(input: {
  namespace: string;
  githubId?: string | null;
  grants: readonly PackageScopeGrant[];
}): string[] {
  const scopes = new Set<string>();
  if (
    !packageScopeReservedForOther({
      grants: input.grants,
      scope: input.namespace,
      githubId: input.githubId,
    })
  ) {
    scopes.add(input.namespace.toLowerCase());
  }
  if (input.githubId) {
    for (const grant of input.grants) {
      if (grant.githubId === input.githubId) scopes.add(grant.scope);
    }
  }
  return [...scopes];
}

export function packageScopeGrantOwner(
  grants: readonly PackageScopeGrant[],
  scope: string,
): string | null {
  return grants.find((grant) => grant.scope === scope.toLowerCase())?.githubId ?? null;
}

export function packageScopeReservedForOther(input: {
  grants: readonly PackageScopeGrant[];
  scope: string;
  githubId?: string | null;
}): boolean {
  const owner = packageScopeGrantOwner(input.grants, input.scope);
  return owner !== null && owner !== input.githubId;
}

export interface ProfileReconciliationCachePolicy {
  key: string;
  ttlSeconds: 60 | 900;
}

/**
 * Grant-bearing API-token identities use a distinct short cache. A normal
 * Clerk-session cache entry therefore cannot postpone GitHub-link revalidation.
 */
export function profileReconciliationCachePolicy(input: {
  clerkId: string;
  githubId?: string | null;
  grants: readonly PackageScopeGrant[];
}): ProfileReconciliationCachePolicy {
  const hasConfiguredGrant =
    input.githubId !== null &&
    input.githubId !== undefined &&
    input.grants.some((grant) => grant.githubId === input.githubId);
  return hasConfiguredGrant
    ? {
        key: `clerk-grant-profile-reconciled:${input.clerkId}`,
        ttlSeconds: 60,
      }
    : {
        key: `clerk-profile-reconciled:${input.clerkId}`,
        ttlSeconds: 900,
      };
}
