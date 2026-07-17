import { badRequest, forbidden, rateLimited, timingSafeEqual, tooLarge } from '@lemonize/shared';

const encoder = new TextEncoder();
const SIGNATURE = /^v1=[a-f0-9]{64}$/i;
const TIMESTAMP = /^\d{10,11}$/;
const MAX_CLOCK_SKEW_SECONDS = 300;

export const PUBLISH_QUOTAS = {
  maxPackages: 5,
  maxVersionsPerPackage: 20,
  maxTarballSizeBytes: 10 * 1024 * 1024,
  maxStoredAndReservedBytes: 100 * 1024 * 1024,
  maxLiveReservations: 2,
} as const;

export function artifactPromotionEnabled(input: {
  registryMode: 'read_only' | 'invite_only' | 'public';
  allowPublicPublish: boolean;
}): boolean {
  return input.registryMode !== 'read_only' && input.allowPublicPublish;
}

export function assertPublishQuota(input: {
  packageCount: number;
  liveReservations: number;
  storedAndReservedBytes: number;
  addsPackage: boolean;
  addsReservation?: boolean;
  additionalBytes?: number;
  versionCount?: number;
}): void {
  if (
    input.packageCount > PUBLISH_QUOTAS.maxPackages ||
    (input.addsPackage && input.packageCount >= PUBLISH_QUOTAS.maxPackages)
  ) {
    throw rateLimited(`Package limit of ${PUBLISH_QUOTAS.maxPackages} reached.`);
  }
  if ((input.addsReservation ?? true) && input.liveReservations >= PUBLISH_QUOTAS.maxLiveReservations) {
    throw rateLimited(`At most ${PUBLISH_QUOTAS.maxLiveReservations} publishes may be in progress.`);
  }
  if (input.versionCount !== undefined && input.versionCount >= PUBLISH_QUOTAS.maxVersionsPerPackage) {
    throw rateLimited(
      `Version limit of ${PUBLISH_QUOTAS.maxVersionsPerPackage} per package reached.`,
    );
  }
  const additionalBytes = input.additionalBytes ?? 0;
  if (
    !Number.isSafeInteger(input.storedAndReservedBytes) ||
    !Number.isSafeInteger(additionalBytes) ||
    input.storedAndReservedBytes < 0 ||
    additionalBytes < 0 ||
    input.storedAndReservedBytes + additionalBytes > PUBLISH_QUOTAS.maxStoredAndReservedBytes
  ) {
    throw tooLarge('Published and reserved artifacts may not exceed 100 MiB per account.');
  }
}

export function assertGlobalArtifactQuota(input: {
  storedAndReservedBytes: number;
  additionalBytes: number;
  maximumBytes: number;
}): void {
  if (
    !Number.isSafeInteger(input.storedAndReservedBytes) ||
    !Number.isSafeInteger(input.additionalBytes) ||
    !Number.isSafeInteger(input.maximumBytes) ||
    input.storedAndReservedBytes < 0 ||
    input.additionalBytes < 0 ||
    input.maximumBytes < 1 ||
    input.storedAndReservedBytes + input.additionalBytes > input.maximumBytes
  ) {
    throw tooLarge('The registry-wide artifact storage ceiling has been reached.');
  }
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requestTarget(url: string): string {
  const parsed = new URL(url, 'http://worker.local');
  return `${parsed.pathname}${parsed.search}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

async function signature(
  secret: string,
  method: string,
  url: string,
  timestamp: string,
  body: Uint8Array,
): Promise<string> {
  const canonical = `v1:${timestamp}:${method.toUpperCase()}:${requestTarget(url)}:${await sha256Hex(body)}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return `v1=${toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical)))}`;
}

export async function scannerSignedHeaders(input: {
  secret: string;
  method: string;
  url: string;
  body: Uint8Array;
  now?: Date;
}): Promise<Record<string, string>> {
  if (encoder.encode(input.secret).byteLength < 32) {
    throw new Error('Scanner signing secret must be at least 32 bytes.');
  }
  const timestamp = String(Math.floor((input.now ?? new Date()).getTime() / 1_000));
  return {
    'x-lemonize-timestamp': timestamp,
    'x-lemonize-signature': await signature(
      input.secret,
      input.method,
      input.url,
      timestamp,
      input.body,
    ),
  };
}

export async function verifyScannerSignature(input: {
  secret: string;
  method: string;
  url: string;
  headers: Headers;
  body: Uint8Array;
  now?: Date;
  maxClockSkewSeconds?: number;
}): Promise<void> {
  if (encoder.encode(input.secret).byteLength < 32) {
    throw forbidden('Scanner authentication is unavailable.');
  }
  const timestamp = input.headers.get('x-lemonize-timestamp');
  const supplied = input.headers.get('x-lemonize-signature');
  if (!timestamp || !supplied || !TIMESTAMP.test(timestamp) || !SIGNATURE.test(supplied)) {
    throw forbidden('Invalid scanner signature.');
  }
  const epochSeconds = Number(timestamp);
  const currentSeconds = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  if (
    !Number.isSafeInteger(epochSeconds) ||
    Math.abs(currentSeconds - epochSeconds) >
      (input.maxClockSkewSeconds ?? MAX_CLOCK_SKEW_SECONDS)
  ) {
    throw forbidden('Expired scanner signature.');
  }
  const expected = await signature(
    input.secret,
    input.method,
    input.url,
    timestamp,
    input.body,
  );
  if (!timingSafeEqual(supplied.toLowerCase(), expected.toLowerCase())) {
    throw forbidden('Invalid scanner signature.');
  }
}

export function assertPublishingIdentity(input: {
  namespace?: string;
  packageScope: string | null;
  tokenScopes?: readonly string[] | string;
}): void {
  if (!input.packageScope) {
    throw forbidden('Packages must be scoped to your Lemonize namespace.');
  }
  if (!input.namespace || input.packageScope.toLowerCase() !== input.namespace.toLowerCase()) {
    throw forbidden('You may only publish packages in your own namespace.');
  }
  const scopes = Array.isArray(input.tokenScopes)
    ? input.tokenScopes
    : typeof input.tokenScopes === 'string'
      ? input.tokenScopes.split(',').map((scope) => scope.trim()).filter(Boolean)
      : [];
  if (scopes.length > 0 && !scopes.some((scope) => ['*', 'publish', 'packages:write'].includes(scope))) {
    throw forbidden('This token does not grant package publishing access.');
  }
}

export function immutableStagingKey(reservationId: string): string {
  const random = new Uint8Array(18);
  crypto.getRandomValues(random);
  const suffix = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `staging/${reservationId}/${suffix}.tgz`;
}

export async function readRequestBodyLimited(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw badRequest('Invalid Content-Length.');
    if (parsed > maxBytes) throw badRequest('Request body is too large.');
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw badRequest('Request body is too large.');
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
