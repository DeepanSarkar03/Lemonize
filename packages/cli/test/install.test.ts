import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LemonizeClient, type PackageMetadata } from '@lemonize/shared';
import { packDirectory } from '@lemonize/package-format';
import { installOne } from '../src/lib/install.js';
import { emptyLockfile } from '../src/lib/lockfile.js';
import { cachePathFor, cleanCache } from '../src/lib/cache.js';
import { resolvePackageDirectory } from '../src/lib/package-path.js';
import { configureLogger } from '../src/lib/logger.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'lem-cli-'));
}

const REGISTRY = 'https://registry.test';
let realFetch: typeof fetch;

const hasTerminalControl = (value: string) =>
  Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
  });

async function buildFixtureTarball() {
  const src = tmp();
  writeFileSync(
    join(src, 'package.json'),
    JSON.stringify({
      name: '@test/lib',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
      bin: { 'test-bin': './bin.js' },
      files: ['index.js', 'bin.js'],
    }),
  );
  writeFileSync(join(src, 'index.js'), 'export const answer = 42;\n');
  writeFileSync(join(src, 'bin.js'), '#!/usr/bin/env node\nconsole.log("hi");\n');
  return packDirectory(src);
}

describe('CLI install engine', () => {
  beforeEach(() => {
    realFetch = globalThis.fetch;
    // Use an isolated LEM home so the content cache does not leak between tests.
    process.env.LEMONIZE_HOME = tmp();
    configureLogger({ json: false, verbose: false, color: false });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.LEMONIZE_HOME;
    vi.restoreAllMocks();
  });

  it('resolves, downloads, verifies integrity, extracts and lockfiles', async () => {
    const packed = await buildFixtureTarball();
    const tarballUrl = `${REGISTRY}/v1/packages/@test%2Flib/versions/1.0.0/tarball`;
    const meta: PackageMetadata = {
      name: '@test/lib',
      normalizedName: '@test/lib',
      scope: 'test',
      visibility: 'public',
      latest: '1.0.0',
      distTags: { latest: '1.0.0' },
      maintainers: ['tester'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      versions: {
        '1.0.0': {
          version: '1.0.0',
          tarball: tarballUrl,
          integrity: packed.integrity,
          shasum: packed.shasum,
          unpackedSize: packed.unpackedSize,
          tarballSize: packed.size,
          fileCount: packed.fileCount,
          bin: { 'test-bin': './bin.js' },
          deprecated: 'legacy\u001b]0;owned-warning\u0007 package\u009b2J',
          publishedBy: 'tester',
          publishedAt: new Date().toISOString(),
        },
      },
    };

    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/tarball')) {
        return new Response(packed.tarball, { status: 200 });
      }
      return new Response(JSON.stringify(meta), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const cwd = tmp();
    const ctx = { registry: REGISTRY, token: null, client: new LemonizeClient({ registry: REGISTRY }) };
    const lock = emptyLockfile(REGISTRY);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await installOne(ctx, cwd, '@test/lib', 'latest', lock);

    expect(result.version).toBe('1.0.0');
    expect(existsSync(join(cwd, 'node_modules', '@test', 'lib', 'package.json'))).toBe(true);
    expect(readFileSync(join(cwd, 'node_modules', '@test', 'lib', 'index.js'), 'utf8')).toContain('answer = 42');
    // bin shim generated
    expect(result.bins).toContain('test-bin');
    expect(existsSync(join(cwd, 'node_modules', '.bin', 'test-bin'))).toBe(true);
    // lockfile entry with integrity
    expect(lock.packages['@test/lib']!.integrity).toBe(packed.integrity);
    expect(lock.packages['@test/lib']!.shasum).toBe(packed.shasum);
    const warning = warnings.mock.calls.flat().join('\n');
    expect(warning).toContain('legacy package');
    expect(warning).not.toContain('owned-warning');
    expect(hasTerminalControl(warning)).toBe(false);
  });

  it('rejects a tampered tarball (integrity mismatch)', async () => {
    const packed = await buildFixtureTarball();
    const meta: PackageMetadata = {
      name: '@test/lib',
      normalizedName: '@test/lib',
      scope: 'test',
      visibility: 'public',
      latest: '1.0.0',
      distTags: { latest: '1.0.0' },
      maintainers: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      versions: {
        '1.0.0': {
          version: '1.0.0',
          tarball: `${REGISTRY}/tarball`,
          integrity: 'sha512-ZZZZinvalidZZZZ==',
          shasum: packed.shasum,
          unpackedSize: packed.unpackedSize,
          tarballSize: packed.size,
          fileCount: packed.fileCount,
          publishedBy: 'x',
          publishedAt: new Date().toISOString(),
        },
      },
    };
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/tarball')) return new Response(packed.tarball, { status: 200 });
      return new Response(JSON.stringify(meta), { status: 200 });
    }) as unknown as typeof fetch;

    cleanCache();
    const ctx = { registry: REGISTRY, token: null, client: new LemonizeClient({ registry: REGISTRY }) };
    await expect(installOne(ctx, tmp(), '@test/lib', 'latest', emptyLockfile(REGISTRY))).rejects.toThrow(
      /Integrity check failed/,
    );
  });

  it('rejects malicious registry shasums before cache or tarball path use', async () => {
    const packed = await buildFixtureTarball();
    const meta: PackageMetadata = {
      name: '@test/lib',
      normalizedName: '@test/lib',
      scope: 'test',
      visibility: 'public',
      latest: '1.0.0',
      distTags: { latest: '1.0.0' },
      maintainers: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      versions: {
        '1.0.0': {
          version: '1.0.0',
          tarball: `${REGISTRY}/tarball`,
          integrity: packed.integrity,
          shasum: '../../outside-cache',
          unpackedSize: packed.unpackedSize,
          tarballSize: packed.size,
          fileCount: packed.fileCount,
          publishedBy: 'attacker',
          publishedAt: new Date().toISOString(),
        },
      },
    };
    let tarballRequests = 0;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/tarball')) {
        tarballRequests += 1;
        return new Response(packed.tarball, { status: 200 });
      }
      return new Response(JSON.stringify(meta), { status: 200 });
    }) as unknown as typeof fetch;

    const ctx = { registry: REGISTRY, token: null, client: new LemonizeClient({ registry: REGISTRY }) };
    await expect(installOne(ctx, tmp(), '@test/lib', 'latest', emptyLockfile(REGISTRY))).rejects.toThrow(
      /Invalid SHA-256 shasum/,
    );
    expect(tarballRequests).toBe(0);
    for (const shasum of ['', 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(63)}g`, '../escape']) {
      expect(() => cachePathFor(shasum)).toThrow(/Invalid SHA-256 shasum/);
    }
  });

  it('rejects a custom registry that changes the requested package name or version', async () => {
    const base = {
      normalizedName: '@test/lib',
      scope: 'test',
      visibility: 'public' as const,
      latest: '1.0.0',
      distTags: { latest: '1.0.0' },
      maintainers: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      versions: {},
    };
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ...base, name: '../outside' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const nameCtx = { registry: REGISTRY, token: null, client: new LemonizeClient({ registry: REGISTRY }) };
    await expect(installOne(nameCtx, tmp(), '@test/lib', 'latest', emptyLockfile(REGISTRY))).rejects.toThrow(
      /Invalid package name/,
    );

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        ...base,
        name: '@test/lib',
        latest: '../../outside',
        distTags: { latest: '../../outside' },
        versions: {
          '../../outside': {
            version: '../../outside',
            tarball: `${REGISTRY}/tarball`,
            integrity: `sha512-${'A'.repeat(86)}==`,
            shasum: 'a'.repeat(64),
            unpackedSize: 1,
            tarballSize: 1,
            fileCount: 1,
            publishedBy: 'attacker',
            publishedAt: new Date().toISOString(),
          },
        },
      }), { status: 200 }),
    ) as unknown as typeof fetch;
    const versionCtx = { registry: REGISTRY, token: null, client: new LemonizeClient({ registry: REGISTRY }) };
    await expect(installOne(versionCtx, tmp(), '@test/lib', 'latest', emptyLockfile(REGISTRY))).rejects.toThrow(
      /invalid package version/i,
    );
  });

  it('rejects package directories that traverse a symlinked scope', () => {
    const cwd = tmp();
    const outside = tmp();
    const nodeModules = join(cwd, 'node_modules');
    mkdirSync(nodeModules, { recursive: true });
    symlinkSync(outside, join(nodeModules, '@test'), process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => resolvePackageDirectory(cwd, '@test/lib')).toThrow(/symbolic link/);
  });
});
