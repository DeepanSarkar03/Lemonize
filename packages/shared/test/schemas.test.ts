import { describe, expect, it } from 'vitest';
import { manifestSchema } from '../src/schemas.js';

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
});
