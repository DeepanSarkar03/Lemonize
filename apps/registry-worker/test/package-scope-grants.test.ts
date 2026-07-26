import { describe, expect, it } from 'vitest';
import {
  authorizedPackageScopes,
  packageScopeGrantOwner,
  packageScopeReservedForOther,
  parsePackageScopeGrants,
  profileReconciliationCachePolicy,
} from '../src/lib/package-scope-grants.js';

const valid = JSON.stringify([
  { scope: 'staging-team', githubId: 'github-42' },
  { scope: 'second-team', githubId: 'github-42' },
]);

describe('package scope grants', () => {
  it('derives exact additional scopes only for the authoritative GitHub id', () => {
    const grants = parsePackageScopeGrants(valid);
    expect(authorizedPackageScopes({ namespace: 'alice', githubId: 'github-42', grants })).toEqual([
      'alice',
      'staging-team',
      'second-team',
    ]);
    expect(authorizedPackageScopes({ namespace: 'alice', githubId: 'github-43', grants })).toEqual([
      'alice',
    ]);
    expect(authorizedPackageScopes({ namespace: 'alice', githubId: null, grants })).toEqual([
      'alice',
    ]);
  });

  it('withholds a primary namespace that is granted to another GitHub identity', () => {
    const grants = parsePackageScopeGrants(
      JSON.stringify([{ scope: 'alice', githubId: 'github-42' }]),
    );
    expect(authorizedPackageScopes({ namespace: 'alice', githubId: 'github-43', grants })).toEqual(
      [],
    );
    expect(authorizedPackageScopes({ namespace: 'alice', githubId: null, grants })).toEqual([]);
    expect(authorizedPackageScopes({ namespace: 'alice', githubId: 'github-42', grants })).toEqual([
      'alice',
    ]);
  });

  it('requires an explicit, valid, complete runtime grant set', () => {
    expect(parsePackageScopeGrants('[]')).toEqual([]);
    for (const value of [
      undefined,
      '',
      '   ',
      '{',
      '{}',
      JSON.stringify([{ scope: 'Uppercase', githubId: 'github-42' }]),
      JSON.stringify([{ scope: 'team_name', githubId: 'github-42' }]),
      JSON.stringify([{ scope: 'admin', githubId: 'github-42' }]),
      JSON.stringify([{ scope: 'team', githubId: 'github id' }]),
      JSON.stringify([{ scope: 'team', githubId: 'github-42', role: 'owner' }]),
      JSON.stringify([
        { scope: 'team', githubId: 'github-42' },
        { scope: 'team', githubId: 'github-43' },
      ]),
    ]) {
      expect(() => parsePackageScopeGrants(value)).toThrow();
    }
  });

  it('reserves every configured scope from other GitHub identities', () => {
    const grants = parsePackageScopeGrants(valid);
    expect(packageScopeGrantOwner(grants, 'staging-team')).toBe('github-42');
    expect(
      packageScopeReservedForOther({ grants, scope: 'staging-team', githubId: 'github-42' }),
    ).toBe(false);
    expect(
      packageScopeReservedForOther({ grants, scope: 'staging-team', githubId: 'github-43' }),
    ).toBe(true);
    expect(packageScopeReservedForOther({ grants, scope: 'unclaimed', githubId: null })).toBe(
      false,
    );
  });

  it('uses a distinct cache with at most 60 seconds of lag for grant-bearing API users', () => {
    const grants = parsePackageScopeGrants(valid);
    const ordinary = profileReconciliationCachePolicy({
      clerkId: 'user_123',
      githubId: 'github-43',
      grants,
    });
    const granted = profileReconciliationCachePolicy({
      clerkId: 'user_123',
      githubId: 'github-42',
      grants,
    });

    expect(ordinary).toEqual({
      key: 'clerk-profile-reconciled:user_123',
      ttlSeconds: 900,
    });
    expect(granted).toEqual({
      key: 'clerk-grant-profile-reconciled:user_123',
      ttlSeconds: 60,
    });
    expect(granted.key).not.toBe(ordinary.key);
  });
});
