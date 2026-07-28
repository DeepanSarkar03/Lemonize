import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

import { verifyClerkToken } from '../src/lib/clerk-auth.js';

const ISSUER = 'https://clerk-auth-test.example';
const AUTHORIZED_PARTY = 'https://app.example';
const KEY_ID = 'clerk-auth-test-key';

let privateKey: CryptoKey;
let jwksFetch: ReturnType<typeof vi.fn>;

interface TokenOptions {
  issuer?: string;
  subject?: string | null;
  authorizedParty?: string | null;
  expiresAt?: number | null;
  algorithm?: 'RS256' | 'HS256';
}

async function token(options: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const algorithm = options.algorithm ?? 'RS256';
  const payload: JWTPayload & { azp?: string } = {};
  if (options.authorizedParty !== null) {
    payload.azp = options.authorizedParty ?? AUTHORIZED_PARTY;
  }
  let jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: algorithm, kid: KEY_ID })
    .setIssuer(options.issuer ?? ISSUER)
    .setIssuedAt(now);

  if (options.subject !== null) jwt = jwt.setSubject(options.subject ?? 'user_verified_123');
  if (options.expiresAt !== null) {
    jwt = jwt.setExpirationTime(options.expiresAt ?? now + 300);
  }

  if (algorithm === 'HS256') {
    return jwt.sign(new TextEncoder().encode('not-an-rsa-clerk-signing-key'));
  }
  return jwt.sign(privateKey);
}

describe('Clerk session JWT verification', () => {
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey as CryptoKey;
    const publicJwk = await exportJWK(pair.publicKey);
    jwksFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            keys: [{ ...publicJwk, alg: 'RS256', kid: KEY_ID, use: 'sig' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', jwksFetch);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('accepts a valid RS256 token with the exact issuer, subject, expiry, and authorized party', async () => {
    const expiresAt = Math.floor(Date.now() / 1_000) + 300;
    const result = await verifyClerkToken(await token({ expiresAt }), {
      issuer: ISSUER,
      authorizedParties: [AUTHORIZED_PARTY],
    });

    expect(result).toMatchObject({
      userId: 'user_verified_123',
      authorizedParty: AUTHORIZED_PARTY,
      expiresAt,
    });
    expect(result.claims).toMatchObject({
      iss: ISSUER,
      sub: 'user_verified_123',
      exp: expiresAt,
      azp: AUTHORIZED_PARTY,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.claims)).toBe(true);
    expect(jwksFetch).toHaveBeenCalled();
  });

  it('rejects a token signed for a different Clerk issuer', async () => {
    await expect(
      verifyClerkToken(await token({ issuer: 'https://another-clerk.example' }), {
        issuer: ISSUER,
        authorizedParties: [AUTHORIZED_PARTY],
      }),
    ).rejects.toThrow();
  });

  it('rejects an expired token outside the configured clock tolerance', async () => {
    await expect(
      verifyClerkToken(await token({ expiresAt: Math.floor(Date.now() / 1_000) - 120 }), {
        issuer: ISSUER,
        authorizedParties: [AUTHORIZED_PARTY],
      }),
    ).rejects.toThrow();
  });

  it.each([
    ['missing', null],
    ['empty', ''],
  ] as const)('rejects a %s subject', async (_label, subject) => {
    await expect(
      verifyClerkToken(await token({ subject }), {
        issuer: ISSUER,
        authorizedParties: [AUTHORIZED_PARTY],
      }),
    ).rejects.toThrow();
  });

  it.each([
    ['missing', null],
    ['untrusted', 'https://attacker.example'],
  ] as const)('rejects a %s authorized party', async (_label, authorizedParty) => {
    await expect(
      verifyClerkToken(await token({ authorizedParty }), {
        issuer: ISSUER,
        authorizedParties: [AUTHORIZED_PARTY],
      }),
    ).rejects.toThrow();
  });

  it('rejects a staging token presented to the production environment', async () => {
    const stagingToken = await token({
      issuer: 'https://staging-clerk.example',
      authorizedParty: 'https://staging-app.example',
    });

    await expect(
      verifyClerkToken(stagingToken, {
        issuer: 'https://production-clerk.example',
        authorizedParties: ['https://production-app.example'],
      }),
    ).rejects.toThrow();
  });

  it('rejects a non-RS256 token before accepting its claims', async () => {
    await expect(
      verifyClerkToken(await token({ algorithm: 'HS256' }), {
        issuer: ISSUER,
        authorizedParties: [AUTHORIZED_PARTY],
      }),
    ).rejects.toThrow();
  });

  it('rejects a token without an expiry claim', async () => {
    await expect(
      verifyClerkToken(await token({ expiresAt: null }), {
        issuer: ISSUER,
        authorizedParties: [AUTHORIZED_PARTY],
      }),
    ).rejects.toThrow();
  });

  it('rejects unsafe verifier configuration before fetching remote keys', async () => {
    const fetchesBefore = jwksFetch.mock.calls.length;
    await expect(
      verifyClerkToken(await token(), {
        issuer: 'http://clerk-auth-test.example',
        authorizedParties: [AUTHORIZED_PARTY],
      }),
    ).rejects.toThrow('issuer must use HTTPS');
    await expect(
      verifyClerkToken(await token(), {
        issuer: ISSUER,
        authorizedParties: ['https://app.example/path'],
      }),
    ).rejects.toThrow('must be an exact origin without a path');
    expect(jwksFetch).toHaveBeenCalledTimes(fetchesBefore);
  });
});
