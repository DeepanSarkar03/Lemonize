import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageMetadata } from '@lemonize/shared';
import { cmdInfo, cmdSearch } from '../src/commands.js';
import { configureLogger } from '../src/lib/logger.js';
import { sanitizeTerminalText } from '../src/lib/terminal.js';

const REGISTRY = 'https://registry.example.test';
const maliciousDescription =
  'useful\u001b[31m red\u001b[0m\u001b]0;owned-title\u0007 text\nnext\u009b2Jdone';
const maliciousDeprecation = 'legacy\u001b]2;owned-deprecation\u0007 warning';

const hasTerminalControl = (value: string) =>
  Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
  });

function metadata(): PackageMetadata {
  return {
    name: '@test/lib',
    normalizedName: '@test/lib',
    scope: 'test',
    visibility: 'public',
    latest: '1.0.0',
    description: maliciousDescription,
    distTags: { latest: '1.0.0' },
    maintainers: ['test'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    versions: {
      '1.0.0': {
        version: '1.0.0',
        tarball: `${REGISTRY}/tarball`,
        integrity: `sha512-${'A'.repeat(86)}==`,
        shasum: 'a'.repeat(64),
        unpackedSize: 1,
        tarballSize: 1,
        fileCount: 1,
        publishedBy: 'test',
        publishedAt: '2026-01-01T00:00:00.000Z',
        deprecated: maliciousDeprecation,
      },
    },
  };
}

describe('terminal-safe registry output', () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    configureLogger({ json: false, verbose: false, color: false });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    configureLogger({ json: false, verbose: false, color: false });
    vi.restoreAllMocks();
  });

  it('removes C0/C1, CSI, OSC, and unterminated terminal control strings', () => {
    const value = sanitizeTerminalText(
      `${maliciousDescription}\u009dsecret\u009c end\u001b]unterminated`,
    );
    expect(hasTerminalControl(value)).toBe(false);
    expect(value).not.toContain('owned-title');
    expect(value).not.toContain('secret');
    expect(value).not.toContain('[31m');
    expect(value).not.toContain('2J');
    expect(value).not.toContain('unterminated');
    expect(value).toContain('useful red');
    expect(value).toContain('text nextdone');
  });

  it('sanitizes package and search descriptions in human output', async () => {
    const responses = [
      metadata(),
      { results: [{ name: '@test/lib', latest: '1.0.0', downloads: 0, description: maliciousDescription }] },
    ];
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(responses.shift()), { status: 200 }),
    ) as unknown as typeof fetch;
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await cmdInfo('@test/lib', { registry: REGISTRY });
    await cmdSearch('lib', { registry: REGISTRY });

    const rendered = output.mock.calls.flat().join(' ');
    const renderedDescriptions = output.mock.calls
      .flat()
      .map(String)
      .filter((line) => line.includes('useful'))
      .join(' ');
    expect(hasTerminalControl(renderedDescriptions)).toBe(false);
    expect(rendered).not.toContain('owned-title');
    expect(rendered).toContain('useful red');
  });

  it('preserves publisher data in JSON mode', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(metadata()), { status: 200 }),
    ) as unknown as typeof fetch;
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    configureLogger({ json: true, color: false });

    await cmdInfo('@test/lib', { registry: REGISTRY, json: true });

    const encoded = String(output.mock.calls[0]?.[0]);
    expect(encoded).not.toContain('\u001b]0;owned-title\u0007');
    const decoded = JSON.parse(encoded) as PackageMetadata;
    expect(decoded.description).toBe(maliciousDescription);
    expect(decoded.versions['1.0.0']?.deprecated).toBe(maliciousDeprecation);
  });
});
