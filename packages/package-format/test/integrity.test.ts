import { describe, it, expect } from 'vitest';
import { computeIntegrity, verifyIntegrity } from '../src/integrity.js';

describe('integrity', () => {
  it('computes SRI + sha256 + size and verifies', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const { integrity, shasum, size } = await computeIntegrity(data);
    expect(size).toBe(5);
    expect(integrity).toMatch(/^sha512-/);
    expect(shasum).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifyIntegrity(data, integrity)).resolves.toBeUndefined();
  });
  it('throws on integrity mismatch', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const { integrity } = await computeIntegrity(data);
    const tampered = new Uint8Array([1, 2, 4]);
    await expect(verifyIntegrity(tampered, integrity)).rejects.toThrow(/Integrity check failed/);
  });
});
