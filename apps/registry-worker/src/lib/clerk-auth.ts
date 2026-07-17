import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

const ALLOWED_ALGORITHMS = ['RS256'] as const;
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 5;
const MAX_CLOCK_TOLERANCE_SECONDS = 60;
const MAX_CACHED_JWKS = 8;

export interface ClerkTokenVerifierOptions {
  /** Exact Clerk issuer from the token's `iss` claim. */
  issuer: string;
  /** Exact web origins allowed in the token's `azp` claim. */
  authorizedParties: readonly string[];
  /** Defaults to `${issuer}/.well-known/jwks.json`. */
  jwksUrl?: string;
  /** Small allowance for clock skew. Values over 60 seconds are rejected. */
  clockToleranceSeconds?: number;
}

export interface ClerkTokenClaims extends JWTPayload {
  iss: string;
  sub: string;
  exp: number;
  azp: string;
  sid?: string;
}

export interface VerifiedClerkAuth {
  /** Immutable Clerk user identifier, taken only from the verified `sub` claim. */
  userId: string;
  authorizedParty: string;
  expiresAt: number;
  sessionId?: string;
  claims: ClerkTokenClaims;
}

const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function configurationError(message: string): Error {
  return new Error(`Invalid Clerk verifier configuration: ${message}`);
}

function assertHttpsUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw configurationError(`${label} must be an absolute URL`);
  }

  if (parsed.protocol !== 'https:') {
    throw configurationError(`${label} must use HTTPS`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw configurationError(`${label} must not contain credentials or a fragment`);
  }
  return parsed;
}

function assertExactWebOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw configurationError(`authorized party "${value}" must be an absolute web origin`);
  }

  const isLocalDevelopment =
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]');

  if (parsed.protocol !== 'https:' && !isLocalDevelopment) {
    throw configurationError(`authorized party "${value}" must use HTTPS`);
  }
  if (parsed.origin === 'null' || value !== parsed.origin) {
    throw configurationError(`authorized party "${value}" must be an exact origin without a path`);
  }
  return value;
}

function getRemoteJwks(url: URL): ReturnType<typeof createRemoteJWKSet> {
  const key = url.toString();
  const cached = jwksByUrl.get(key);
  if (cached) return cached;

  // Issuers are trusted configuration, not request input. The cap still avoids
  // unbounded isolate memory if a caller repeatedly supplies bad configuration.
  if (jwksByUrl.size >= MAX_CACHED_JWKS) jwksByUrl.clear();

  const jwks = createRemoteJWKSet(url, {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
  jwksByUrl.set(key, jwks);
  return jwks;
}

function resolveOptions(options: ClerkTokenVerifierOptions) {
  const issuerUrl = assertHttpsUrl(options.issuer, 'issuer');
  if (issuerUrl.search) throw configurationError('issuer must not contain a query string');

  const authorizedParties = new Set(options.authorizedParties.map(assertExactWebOrigin));
  if (authorizedParties.size === 0) {
    throw configurationError('at least one authorized party is required');
  }

  const tolerance = options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
  if (
    !Number.isSafeInteger(tolerance) ||
    tolerance < 0 ||
    tolerance > MAX_CLOCK_TOLERANCE_SECONDS
  ) {
    throw configurationError(
      `clock tolerance must be between 0 and ${MAX_CLOCK_TOLERANCE_SECONDS} seconds`,
    );
  }

  const defaultJwksUrl = new URL(
    '.well-known/jwks.json',
    options.issuer.endsWith('/') ? options.issuer : `${options.issuer}/`,
  );
  const jwksUrl = options.jwksUrl ? assertHttpsUrl(options.jwksUrl, 'JWKS URL') : defaultJwksUrl;
  if (jwksUrl.origin !== issuerUrl.origin) {
    throw configurationError('JWKS URL must use the same origin as the issuer');
  }

  return { authorizedParties, issuer: options.issuer, jwksUrl, tolerance };
}

/**
 * Verify a raw Clerk session JWT in a Cloudflare Worker.
 *
 * The caller must pass trusted configuration, never issuer or origin values
 * supplied by the request being authenticated.
 */
export async function verifyClerkToken(
  token: string,
  options: ClerkTokenVerifierOptions,
): Promise<VerifiedClerkAuth> {
  if (!token || token !== token.trim()) throw new Error('Invalid Clerk token');

  const { authorizedParties, issuer, jwksUrl, tolerance } = resolveOptions(options);
  const { payload } = await jwtVerify(token, getRemoteJwks(jwksUrl), {
    algorithms: [...ALLOWED_ALGORITHMS],
    issuer,
    requiredClaims: ['iss', 'sub', 'exp', 'azp'],
    clockTolerance: tolerance,
  });

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('Invalid Clerk token subject');
  }
  if (typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp)) {
    throw new Error('Invalid Clerk token expiry');
  }
  if (typeof payload.azp !== 'string' || !authorizedParties.has(payload.azp)) {
    throw new Error('Invalid Clerk token authorized party');
  }

  const claims = Object.freeze({ ...payload }) as ClerkTokenClaims;
  return Object.freeze({
    userId: claims.sub,
    authorizedParty: claims.azp,
    expiresAt: claims.exp,
    ...(typeof claims.sid === 'string' ? { sessionId: claims.sid } : {}),
    claims,
  });
}

/** Extract a raw bearer token without accepting alternate authorization schemes. */
export function clerkBearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}
