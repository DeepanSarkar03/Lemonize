/** Web Crypto based hashing shared by CLI, Worker and package-format. */

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return toHex(buf);
}

export async function sha512Base64(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-512', data);
  return toBase64(buf);
}

/** Subresource Integrity string, e.g. "sha512-abc...==" */
export async function sriSha512(data: Uint8Array): Promise<string> {
  return `sha512-${await sha512Base64(data)}`;
}

/** SHA-256 hex of a secret, used to store token hashes at rest. */
export async function hashToken(token: string): Promise<string> {
  const enc = new TextEncoder().encode(token);
  return sha256Hex(enc);
}

/** Constant-time string comparison to avoid timing side channels. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
