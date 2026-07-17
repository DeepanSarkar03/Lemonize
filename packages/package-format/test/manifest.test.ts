import { describe, expect, it } from 'vitest';
import { validateManifest } from '../src/manifest.js';

describe('Lemonize dependency manifests', () => {
  it('validates native dependency package names before publishing', () => {
    expect(
      validateManifest({
        name: '@demo/pkg',
        version: '1.0.0',
        lemonizeDependencies: { '@demo/shared': '^1.0.0' },
      }).ok,
    ).toBe(true);
    const invalid = validateManifest({
      name: '@demo/pkg',
      version: '1.0.0',
      lemonizeDependencies: { '../escape': '^1.0.0' },
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join(' ')).toContain('lemonizeDependencies.');
  });
});
