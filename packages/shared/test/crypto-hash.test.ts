import { describe, it, expect } from 'vitest';
import { hashToken, timingSafeEqual, sha256Hex, sriSha512 } from '../src/crypto-hash.js';
import {
  newApiToken,
  signedDeviceCode,
  TOKEN_PREFIX,
  verifySignedDeviceCode,
} from '../src/ids.js';

describe('token hashing & auth primitives', () => {
  it('hashes tokens to stable sha256 hex', async () => {
    const h1 = await hashToken('lem_live_abc');
    const h2 = await hashToken('lem_live_abc');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
    expect(await hashToken('lem_live_abd')).not.toBe(h1);
  });
  it('generated tokens are prefixed and high-entropy', () => {
    const t = newApiToken();
    expect(t.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(t.length).toBeGreaterThan(40);
    expect(newApiToken()).not.toBe(t);
  });
  it('timingSafeEqual compares by value & length', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
  it('produces valid SRI + sha256', async () => {
    const data = new TextEncoder().encode('hello');
    expect(await sriSha512(data)).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
    expect(await sha256Hex(data)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('authenticates stateless device codes and enforces their server expiry', async () => {
    const secret = '0123456789abcdef0123456789abcdef';
    const issuedAt = 1_760_000_000_000;
    const code = await signedDeviceCode(secret, issuedAt);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(verifySignedDeviceCode(code, secret, issuedAt + 599_000)).resolves.toBe(true);
    await expect(verifySignedDeviceCode(code, secret, issuedAt + 601_000)).resolves.toBe(false);
    const changed = `${code.slice(0, -1)}${code.endsWith('A') ? 'B' : 'A'}`;
    await expect(verifySignedDeviceCode(changed, secret, issuedAt)).resolves.toBe(false);
  });
});
