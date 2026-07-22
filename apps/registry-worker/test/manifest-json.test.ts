import { describe, expect, it } from 'vitest';
import { canonicalStoredManifest } from '../src/lib/manifest-json.js';

describe('stored manifest canonicalization', () => {
  it('preserves sorted-key hashing semantics with an iterative traversal', () => {
    expect(
      canonicalStoredManifest({
        version: '1.0.0',
        custom: [true, { z: 1, a: 2 }],
        name: '@demo/pkg',
      }),
    ).toBe(
      '{"custom":[true,{"a":2,"z":1}],"name":"@demo/pkg","version":"1.0.0"}',
    );
  });

  it('rejects depth-3000 data without a call-stack overflow', () => {
    let extension: unknown = 'leaf';
    for (let depth = 0; depth < 3_000; depth += 1) extension = { nested: extension };

    expect(() => canonicalStoredManifest(extension)).toThrow('Stored manifest is invalid.');
  });
});
