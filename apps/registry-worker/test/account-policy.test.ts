import { describe, expect, it } from 'vitest';
import { loadConfig, type Env } from '../src/lib/env.js';
import {
  CURRENT_TERMS_VERSION,
  hasCurrentTerms,
  roleForAccount,
  shouldAdoptGithubNamespace,
} from '../src/lib/account-policy.js';
import {
  namespaceWithSuffix,
  normalizedNamespace,
  provisionalNamespace,
} from '../src/lib/auth.js';

describe('public publisher account policy', () => {
  it('fails closed when publishing variables are absent or malformed', () => {
    const missing = loadConfig({ REGISTRY_MODE: 'public' } as Env);
    expect(missing.registryMode).toBe('public');
    expect(missing.allowPublicPublish).toBe(false);

    const malformed = loadConfig({
      REGISTRY_MODE: 'unexpected',
      ALLOW_PUBLIC_PUBLISH: 'true',
    } as Env);
    expect(malformed.registryMode).toBe('read_only');
  });

  it('uses GitHub linkage for public eligibility and immutable Clerk ids for admins', () => {
    const config = { registryMode: 'public' as const, adminClerkIds: ['user_admin'] };
    expect(roleForAccount(config, { clerkId: 'user_public', githubId: '12345' })).toBe(
      'publisher',
    );
    expect(roleForAccount(config, { clerkId: 'user_email_only', githubId: null })).toBe(
      'consumer',
    );
    expect(roleForAccount(config, { clerkId: 'user_admin', githubId: null })).toBe('admin');
  });

  it('does not treat a prior terms timestamp as acceptance of a new version', () => {
    expect(hasCurrentTerms({ acceptedTermsVersion: null })).toBe(false);
    expect(hasCurrentTerms({ acceptedTermsVersion: '2026-01-01' })).toBe(false);
    expect(hasCurrentTerms({ acceptedTermsVersion: CURRENT_TERMS_VERSION })).toBe(true);
  });

  it('keeps email-only namespaces provisional and freezes after the first package', async () => {
    const provisional = await provisionalNamespace('user_stable_123');
    expect(provisional).toMatch(/^user-[a-f0-9]{12}$/);
    expect(provisional).toBe(await provisionalNamespace('user_stable_123'));
    expect(provisional).not.toContain('alice');
    expect(normalizedNamespace('Alice.Dev')).toBe('alice-dev');

    expect(
      shouldAdoptGithubNamespace({
        namespaceClaimedAt: null,
        previousGithubId: null,
        nextGithubId: 'github-42',
        packageCount: 0,
      }),
    ).toBe(true);
    expect(
      shouldAdoptGithubNamespace({
        namespaceClaimedAt: null,
        previousGithubId: null,
        nextGithubId: 'github-42',
        packageCount: 1,
      }),
    ).toBe(false);
    expect(
      shouldAdoptGithubNamespace({
        namespaceClaimedAt: '2026-07-17T00:00:00.000Z',
        previousGithubId: null,
        nextGithubId: 'different-github-id',
        packageCount: 0,
      }),
    ).toBe(false);
    expect(await namespaceWithSuffix('alice-dev', 'github-42')).toBe(
      await namespaceWithSuffix('alice-dev', 'github-42'),
    );
  });
});
