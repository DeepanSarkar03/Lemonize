import { describe, expect, it } from 'vitest';
import { LemonizeError } from '@lemonize/shared';
import {
  assertPublishingIdentity,
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
    expect(artifactPromotionEnabled({ registryMode: 'read_only', allowPublicPublish: true })).toBe(false);
    expect(artifactPromotionEnabled({ registryMode: 'invite_only', allowPublicPublish: false })).toBe(false);
    expect(artifactPromotionEnabled({ registryMode: 'invite_only', allowPublicPublish: true })).toBe(true);
    expect(artifactPromotionEnabled({ registryMode: 'public', allowPublicPublish: true })).toBe(true);
  });

  it('requires the authenticated namespace and a publish-capable token', () => {
    expect(() =>
      assertPublishingIdentity({
        namespace: 'alice',
        packageScope: 'alice',
        tokenScopes: ['publish'],
      }),
    ).not.toThrow();
    for (const input of [
      { namespace: 'alice', packageScope: null, tokenScopes: ['publish'] },
      { namespace: 'alice', packageScope: 'bob', tokenScopes: ['publish'] },
      { namespace: 'alice', packageScope: 'alice', tokenScopes: ['read'] },
    ]) {
      expect(() => assertPublishingIdentity(input)).toThrow(LemonizeError);
    }
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
    expect(() => assertPublishQuota({
      packageCount: PUBLISH_QUOTAS.maxPackages - 1,
      liveReservations: PUBLISH_QUOTAS.maxLiveReservations - 1,
      storedAndReservedBytes: PUBLISH_QUOTAS.maxStoredAndReservedBytes - 1,
      addsPackage: true,
      additionalBytes: 1,
    })).not.toThrow();
    expect(() => assertPublishQuota({
      packageCount: PUBLISH_QUOTAS.maxPackages,
      liveReservations: 0,
      storedAndReservedBytes: 0,
      addsPackage: true,
    })).toThrow();
    expect(() => assertPublishQuota({
      packageCount: 1,
      liveReservations: PUBLISH_QUOTAS.maxLiveReservations,
      storedAndReservedBytes: 0,
      addsPackage: false,
    })).toThrow();
    expect(() => assertPublishQuota({
      packageCount: 1,
      liveReservations: 0,
      storedAndReservedBytes: PUBLISH_QUOTAS.maxStoredAndReservedBytes,
      addsPackage: false,
      additionalBytes: 1,
    })).toThrow();
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
