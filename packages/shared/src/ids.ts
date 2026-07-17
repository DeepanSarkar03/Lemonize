/**
 * Runtime-agnostic ID + random helpers. Uses Web Crypto (available in Workers,
 * Node >=20, and modern browsers). No Node-only APIs.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Monotonic-ish ULID (timestamp + randomness). 26 chars, Crockford base32. */
export function ulid(now: number = Date.now()): string {
  let ts = now;
  const time: string[] = [];
  for (let i = 9; i >= 0; i--) {
    time[i] = CROCKFORD[ts % 32]!;
    ts = Math.floor(ts / 32);
  }
  const rnd = new Uint8Array(16);
  crypto.getRandomValues(rnd);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[rnd[i]! % 32];
  return time.join('') + rand;
}

/** URL-safe base64 of random bytes. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const DEVICE_CODE_BYTES = 32;
const DEVICE_CODE_PAYLOAD_BYTES = 22;
const DEVICE_CODE_TAG_BYTES = DEVICE_CODE_BYTES - DEVICE_CODE_PAYLOAD_BYTES;
const DEVICE_CODE_MAX_AGE_MS = 10 * 60 * 1_000;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '=');
    if (binary.length !== DEVICE_CODE_BYTES) return null;
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return base64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

async function deviceCodeTag(secret: string, payload: Uint8Array): Promise<Uint8Array> {
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error('Device-code signing secret must contain at least 32 bytes.');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const domain = new TextEncoder().encode('lemonize-device-code:v1:');
  const message = new Uint8Array(domain.byteLength + payload.byteLength);
  message.set(domain);
  message.set(payload, domain.byteLength);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
}

/** Create a stateless, authenticated 10-minute device secret. */
export async function signedDeviceCode(secret: string, now = Date.now()): Promise<string> {
  const bytes = new Uint8Array(DEVICE_CODE_BYTES);
  let seconds = Math.floor(now / 1_000);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = seconds % 256;
    seconds = Math.floor(seconds / 256);
  }
  crypto.getRandomValues(bytes.subarray(6, DEVICE_CODE_PAYLOAD_BYTES));
  const tag = await deviceCodeTag(secret, bytes.subarray(0, DEVICE_CODE_PAYLOAD_BYTES));
  bytes.set(tag.subarray(0, DEVICE_CODE_TAG_BYTES), DEVICE_CODE_PAYLOAD_BYTES);
  return base64Url(bytes);
}

/** Validate authenticity and the server-side 10-minute device-code deadline. */
export async function verifySignedDeviceCode(
  deviceCode: string,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  const bytes = decodeBase64Url(deviceCode);
  if (!bytes) return false;
  const expected = await deviceCodeTag(secret, bytes.subarray(0, DEVICE_CODE_PAYLOAD_BYTES));
  let difference = 0;
  for (let index = 0; index < DEVICE_CODE_TAG_BYTES; index += 1) {
    difference |= bytes[DEVICE_CODE_PAYLOAD_BYTES + index]! ^ expected[index]!;
  }
  let seconds = 0;
  for (let index = 0; index < 6; index += 1) seconds = seconds * 256 + bytes[index]!;
  const age = now - seconds * 1_000;
  return difference === 0 && age >= -60_000 && age <= DEVICE_CODE_MAX_AGE_MS;
}

export const TOKEN_PREFIX = 'lem_live_';

export function newApiToken(): string {
  return TOKEN_PREFIX + randomToken(32);
}

export function newDeviceCode(): string {
  // Human-friendly 40-bit device code, e.g. LEMN-8F3K-M9QW.
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += CROCKFORD[b % 32];
  return `LEMN-${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Deterministically derive a 40-bit human code from a 256-bit device secret. */
export async function deviceUserCode(deviceCode: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deviceCode)),
  );
  let code = '';
  for (let index = 0; index < 8; index += 1) code += CROCKFORD[digest[index]! % 32];
  return `LEMN-${code.slice(0, 4)}-${code.slice(4)}`;
}
