import { describe, expect, it } from 'vitest';
import { jsonStructureIssue, MANIFEST_JSON_LIMITS } from '../src/json.js';
import { manifestSchema, publishIntentSchema } from '../src/schemas.js';

describe('manifest paths', () => {
  it('accepts package-relative entry points and directory file entries', () => {
    expect(() =>
      manifestSchema.parse({
        name: '@demo/pkg',
        version: '1.0.0',
        main: './dist/index.js',
        bin: { demo: './bin/demo.js' },
        files: ['dist/', 'bin/demo.js'],
      }),
    ).not.toThrow();
  });

  it('accepts explicit Lemonize dependencies and npm peer metadata', () => {
    expect(() =>
      manifestSchema.parse({
        name: '@demo/pkg',
        version: '1.0.0',
        dependencies: { react: '^19.0.0' },
        lemonizeDependencies: { '@demo/shared': '^2.0.0' },
        peerDependencies: { react: '^19.0.0' },
        peerDependenciesMeta: { react: { optional: true } },
      }),
    ).not.toThrow();
    expect(() =>
      manifestSchema.parse({
        name: '@demo/pkg',
        version: '1.0.0',
        lemonizeDependencies: { '@demo/shared': '   ' },
      }),
    ).toThrow(/Dependency spec must not be blank/);
  });

  it('rejects traversal and absolute paths in every executable metadata field', () => {
    for (const extra of [
      { main: '../outside.js' },
      { module: '/tmp/outside.js' },
      { types: 'C:\\outside.d.ts' },
      { bin: { demo: '../../outside.js' } },
      { files: ['dist', '../secret'] },
    ]) {
      expect(() =>
        manifestSchema.parse({ name: '@demo/pkg', version: '1.0.0', ...extra }),
      ).toThrow();
    }
  });

  it('rejects a depth-3000 extension iteratively without losing package.json extensibility', () => {
    let extension: unknown = 'leaf';
    for (let depth = 0; depth < 3_000; depth += 1) extension = { nested: extension };

    const result = publishIntentSchema.safeParse({
      manifest: {
        name: '@demo/pkg',
        version: '1.0.0',
        customMetadata: extension,
      },
      integrity: `sha512-${'A'.repeat(86)}==`,
      shasum: 'a'.repeat(64),
      tarballSize: 1,
      unpackedSize: 1,
      fileCount: 1,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain('depth');
    expect(() =>
      manifestSchema.parse({
        name: '@demo/pkg',
        version: '1.0.0',
        customMetadata: { build: { channel: 'canary' } },
      }),
    ).not.toThrow();
  });

  it('enforces explicit aggregate node and object-key limits', () => {
    expect(
      jsonStructureIssue(
        { customMetadata: Array.from({ length: MANIFEST_JSON_LIMITS.maxNodes }, () => null) },
        MANIFEST_JSON_LIMITS,
      ),
    ).toBe('nodes');
    expect(
      jsonStructureIssue(
        {
          customMetadata: Object.fromEntries(
            Array.from({ length: MANIFEST_JSON_LIMITS.maxKeys }, (_, index) => [
              `key-${index}`,
              true,
            ]),
          ),
        },
        MANIFEST_JSON_LIMITS,
      ),
    ).toBe('keys');
  });
});
