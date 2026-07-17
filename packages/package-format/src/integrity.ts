import { sriSha512, sha256Hex } from '@lemonize/shared';

export interface TarballIntegrity {
  integrity: string; // sha512 SRI
  shasum: string; // sha256 hex
  size: number;
}

export async function computeIntegrity(tarball: Uint8Array): Promise<TarballIntegrity> {
  const [integrity, shasum] = await Promise.all([sriSha512(tarball), sha256Hex(tarball)]);
  return { integrity, shasum, size: tarball.byteLength };
}

/** Verify a downloaded tarball against an expected SRI. Throws on mismatch. */
export async function verifyIntegrity(tarball: Uint8Array, expectedSri: string): Promise<void> {
  const actual = await sriSha512(tarball);
  if (actual !== expectedSri) {
    throw new Error(
      `Integrity check failed. Expected ${expectedSri} but downloaded artifact hashes to ${actual}.`,
    );
  }
}
