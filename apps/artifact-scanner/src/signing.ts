import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ScannerError } from './errors.js';

export const SIGNATURE_HEADER = 'x-lemonize-signature';
export const TIMESTAMP_HEADER = 'x-lemonize-timestamp';

function requestTarget(url: string): string {
  const parsed = new URL(url, 'http://function.local');
  return `${parsed.pathname}${parsed.search}`;
}

function bodyDigest(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

function canonical(method: string, url: string, timestamp: string, body: Uint8Array): string {
  return `v1:${timestamp}:${method.toUpperCase()}:${requestTarget(url)}:${bodyDigest(body)}`;
}

export function signRequest(
  secret: string,
  method: string,
  url: string,
  timestamp: string,
  body: Uint8Array,
): string {
  return `v1=${createHmac('sha256', secret)
    .update(canonical(method, url, timestamp, body))
    .digest('hex')}`;
}

export function signedHeaders(input: {
  secret: string;
  method: string;
  url: string;
  body: Uint8Array;
  now: Date;
}): Record<string, string> {
  const timestamp = String(Math.floor(input.now.getTime() / 1_000));
  return {
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: signRequest(
      input.secret,
      input.method,
      input.url,
      timestamp,
      input.body,
    ),
  };
}

export function verifyRequestSignature(input: {
  secret: string;
  method: string;
  url: string;
  headers: Headers;
  body: Uint8Array;
  now: Date;
  maxClockSkewSeconds: number;
}): void {
  const timestamp = input.headers.get(TIMESTAMP_HEADER);
  const supplied = input.headers.get(SIGNATURE_HEADER);
  if (!timestamp || !supplied || !/^\d{10,11}$/.test(timestamp) || !/^v1=[a-f0-9]{64}$/i.test(supplied)) {
    throw new ScannerError('authentication', 'invalid_signature', 401);
  }

  const epochSeconds = Number(timestamp);
  const currentSeconds = Math.floor(input.now.getTime() / 1_000);
  if (
    !Number.isSafeInteger(epochSeconds) ||
    Math.abs(currentSeconds - epochSeconds) > input.maxClockSkewSeconds
  ) {
    throw new ScannerError('authentication', 'stale_signature', 401);
  }

  const expected = signRequest(
    input.secret,
    input.method,
    input.url,
    timestamp,
    input.body,
  );
  const suppliedBytes = Buffer.from(supplied, 'ascii');
  const expectedBytes = Buffer.from(expected, 'ascii');
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    throw new ScannerError('authentication', 'invalid_signature', 401);
  }
}
