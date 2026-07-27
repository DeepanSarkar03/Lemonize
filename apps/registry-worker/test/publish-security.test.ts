import { describe, expect, it } from 'vitest';
import { LemonizeError } from '@lemonize/shared';
import { authorizedPackageScopes } from '../src/lib/package-scope-grants.js';
import { CURRENT_TERMS_VERSION } from '../src/lib/account-policy.js';
import {
  assertArtifactPromotionIdentity,
  assertPublishingIdentity,
  assertPackageScopeExclusive,
  assertGlobalArtifactQuota,
  assertPublishQuota,
  artifactPromotionEnabled,
  immutableStagingKey,
  PUBLISH_QUOTAS,
  readRequestBodyLimited,
  scannerSignedHeaders,
  verifyScannerSignature,
} from '../src/lib/publish-security.js';

const secret = '0123456789abcdef0123456789abcdef';

describe('scanner request authentication', () => {
  it('matches the scanner v1 HMAC protocol byte-for-byte', async () => {
    const body = new TextEncoder().encode('{"job":1}');
    const headers = await scannerSignedHeaders({
      secret,
      method: 'POST',
      url: 'https://function.test/scan?attempt=1',
      body,
      now: new Date(1_760_000_000_000),
    });

    expect(headers['x-lemonize-signature']).toBe(
      'v1=603eb458d5aa2a70df471b27527d1e5435116f34348b43e02501364fdb2ec463',
    );
    await expect(
      verifyScannerSignature({
        secret,
        method: 'POST',
        url: 'https://registry.test/scan?attempt=1',
        headers: new Headers(headers),
        body,
        now: new Date(1_760_000_000_000),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects modified bodies and expired signatures', async () => {
    const signedBody = new TextEncoder().encode('{"status":"clean"}');
    const now = new Date(1_760_000_000_000);
    const headers = new Headers(
      await scannerSignedHeaders({ secret, method: 'POST', url: '/result', body: signedBody, now }),
    );

    await expect(
      verifyScannerSignature({
        secret,
        method: 'POST',
        url: '/result',
        headers,
        body: new TextEncoder().encode('{"status":"rejected"}'),
        now,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      verifyScannerSignature({
        secret,
        method: 'POST',
        url: '/result',
        headers,
        body: signedBody,
        now: new Date(now.getTime() + 301_000),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('fails closed when the scanner secret is missing or too short', async () => {
    await expect(
      verifyScannerSignature({
        secret: '',
        method: 'GET',
        url: '/artifact',
        headers: new Headers(),
        body: new Uint8Array(),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('publish capability boundaries', () => {
  it('stops scan promotion whenever the registry circuit breaker is active', () => {
    expect(artifactPromotionEnabled({ registryMode: 'read_only', allowPublicPublish: true })).toBe(
      false,
    );
    expect(
      artifactPromotionEnabled({ registryMode: 'invite_only', allowPublicPublish: false }),
    ).toBe(false);
    expect(
      artifactPromotionEnabled({ registryMode: 'invite_only', allowPublicPublish: true }),
    ).toBe(true);
    expect(artifactPromotionEnabled({ registryMode: 'public', allowPublicPublish: true })).toBe(
      true,
    );
  });

  it('requires the authenticated namespace and a publish-capable token', () => {
    expect(() =>
      assertPublishingIdentity({
        authorizedPackageScopes: ['alice', 'staging-team'],
        packageScope: 'alice',
        tokenScopes: ['publish'],
      }),
    ).not.toThrow();
    expect(() =>
      assertPublishingIdentity({
        authorizedPackageScopes: ['alice', 'staging-team'],
        packageScope: 'staging-team',
        tokenScopes: ['publish'],
      }),
    ).not.toThrow();
    for (const input of [
      { authorizedPackageScopes: ['alice'], packageScope: null, tokenScopes: ['publish'] },
      { authorizedPackageScopes: ['alice'], packageScope: 'bob', tokenScopes: ['publish'] },
      { authorizedPackageScopes: ['alice'], packageScope: 'alice', tokenScopes: ['read'] },
    ]) {
      expect(() => assertPublishingIdentity(input)).toThrow(LemonizeError);
    }
  });

  it('rejects a scope claimed by another primary identity or package owner', () => {
    expect(() =>
      assertPackageScopeExclusive({
        userId: 'user-1',
        primaryNamespaceOwnerId: 'user-1',
        packageOwnerIds: [],
      }),
    ).not.toThrow();
    expect(() =>
      assertPackageScopeExclusive({
        userId: 'user-1',
        primaryNamespaceOwnerId: 'user-2',
        packageOwnerIds: [],
      }),
    ).toThrow(LemonizeError);
    expect(() =>
      assertPackageScopeExclusive({
        userId: 'user-1',
        primaryNamespaceOwnerId: null,
        packageOwnerIds: ['user-2'],
      }),
    ).toThrow(LemonizeError);
  });

  it('blocks both sides of a grant that collides with a pre-existing primary namespace', () => {
    const grants = [{ scope: 'staging-team', githubId: 'github-grantee' }];
    const claimantScopes = authorizedPackageScopes({
      namespace: 'staging-team',
      githubId: 'github-claimant',
      grants,
    });
    expect(() =>
      assertPublishingIdentity({
        authorizedPackageScopes: claimantScopes,
        packageScope: 'staging-team',
        tokenScopes: ['publish'],
      }),
    ).toThrow(LemonizeError);

    const granteeScopes = authorizedPackageScopes({
      namespace: 'grantee-home',
      githubId: 'github-grantee',
      grants,
    });
    expect(() =>
      assertPackageScopeExclusive({
        userId: 'grantee-user',
        primaryNamespaceOwnerId: 'claimant-user',
        packageOwnerIds: [],
      }),
    ).toThrow(LemonizeError);
    expect(granteeScopes).toContain('staging-team');
  });

  it('rechecks authorization when a grant is removed between reserve and finalize', () => {
    const grant = { scope: 'staging-team', githubId: 'github-42' };
    const identity = { namespace: 'alice', githubId: 'github-42' };
    const reservedWith = authorizedPackageScopes({ ...identity, grants: [grant] });
    expect(() =>
      assertPublishingIdentity({
        authorizedPackageScopes: reservedWith,
        packageScope: 'staging-team',
        tokenScopes: ['publish'],
      }),
    ).not.toThrow();

    const finalizedWith = authorizedPackageScopes({ ...identity, grants: [] });
    expect(() =>
      assertPublishingIdentity({
        authorizedPackageScopes: finalizedWith,
        packageScope: 'staging-team',
        tokenScopes: ['publish'],
      }),
    ).toThrow(LemonizeError);
  });

  it('rechecks the current grant immediately before scanner-approved promotion', () => {
    const identity = { namespace: 'alice', githubId: 'github-42' };
    const base = {
      publisherId: 'user-1',
      packageOwnerId: 'user-1',
      versionPublisherId: 'user-1',
      userStatus: 'active',
      role: 'publisher',
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
      packageScope: 'staging-team',
      packageStatus: 'active',
    };
    const granted = authorizedPackageScopes({
      ...identity,
      grants: [{ scope: 'staging-team', githubId: 'github-42' }],
    });
    expect(() =>
      assertArtifactPromotionIdentity({ ...base, authorizedPackageScopes: granted }),
    ).not.toThrow();

    const revoked = authorizedPackageScopes({ ...identity, grants: [] });
    expect(() =>
      assertArtifactPromotionIdentity({ ...base, authorizedPackageScopes: revoked }),
    ).toThrow(LemonizeError);
  });

  it.each([
    ['owner mismatch', { packageOwnerId: 'user-2' }],
    ['publisher mismatch', { versionPublisherId: 'user-2' }],
    ['suspended account', { userStatus: 'clerk_suspended' }],
    ['consumer role', { role: 'consumer' }],
    ['stale terms', { acceptedTermsVersion: '2026-01-01' }],
    ['blocked package', { packageStatus: 'blocked' }],
  ])('blocks scanner promotion for %s', (_label, override) => {
    expect(() =>
      assertArtifactPromotionIdentity({
        publisherId: 'user-1',
        packageOwnerId: 'user-1',
        versionPublisherId: 'user-1',
        userStatus: 'active',
        role: 'publisher',
        acceptedTermsVersion: CURRENT_TERMS_VERSION,
        authorizedPackageScopes: ['alice'],
        packageScope: 'alice',
        packageStatus: 'active',
        ...override,
      }),
    ).toThrow(LemonizeError);
  });

  it('generates non-reusable staging object keys beneath one reservation', () => {
    const first = immutableStagingKey('reservation-1');
    const second = immutableStagingKey('reservation-1');
    expect(first).toMatch(/^staging\/reservation-1\/[a-f0-9]{36}\.tgz$/);
    expect(second).not.toBe(first);
    expect(first).not.toContain('..');
  });

  it('caps callback bodies even without Content-Length', async () => {
    const request = new Request('https://registry.test/result', {
      method: 'POST',
      body: new Uint8Array(9),
    });
    await expect(readRequestBodyLimited(request, 8)).rejects.toMatchObject({ status: 400 });
  });

  it('enforces bounded package, reservation, and byte quotas', () => {
    expect(() =>
      assertPublishQuota({
        packageCount: PUBLISH_QUOTAS.maxPackages - 1,
        liveReservations: PUBLISH_QUOTAS.maxLiveReservations - 1,
        storedAndReservedBytes: PUBLISH_QUOTAS.maxStoredAndReservedBytes - 1,
        addsPackage: true,
        additionalBytes: 1,
      }),
    ).not.toThrow();
    expect(() =>
      assertPublishQuota({
        packageCount: PUBLISH_QUOTAS.maxPackages,
        liveReservations: 0,
        storedAndReservedBytes: 0,
        addsPackage: true,
      }),
    ).toThrow();
    expect(() =>
      assertPublishQuota({
        packageCount: 1,
        liveReservations: PUBLISH_QUOTAS.maxLiveReservations,
        storedAndReservedBytes: 0,
        addsPackage: false,
      }),
    ).toThrow();
    expect(() =>
      assertPublishQuota({
        packageCount: 1,
        liveReservations: 0,
        storedAndReservedBytes: PUBLISH_QUOTAS.maxStoredAndReservedBytes,
        addsPackage: false,
        additionalBytes: 1,
      }),
    ).toThrow();
    expect(PUBLISH_QUOTAS).toMatchObject({
      maxPackages: 5,
      maxVersionsPerPackage: 20,
      maxTarballSizeBytes: 10 * 1024 * 1024,
      maxStoredAndReservedBytes: 100 * 1024 * 1024,
      maxLiveReservations: 2,
    });
  });

  it('fails closed at the configured registry-wide artifact ceiling', () => {
    expect(() =>
      assertGlobalArtifactQuota({
        storedAndReservedBytes: 900,
        additionalBytes: 100,
        maximumBytes: 1_000,
      }),
    ).not.toThrow();
    expect(() =>
      assertGlobalArtifactQuota({
        storedAndReservedBytes: 901,
        additionalBytes: 100,
        maximumBytes: 1_000,
      }),
    ).toThrow();
  });
});
