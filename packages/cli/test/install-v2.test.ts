import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LemonizeClient, type PackageMetadata } from '@lemonize/shared';
import { packDirectory, type PackResult } from '@lemonize/package-format';
import { cleanCache } from '../src/lib/cache.js';
import { installRequests } from '../src/lib/install.js';
import type { LockfileV2 } from '../src/lib/lockfile.js';

const REGISTRY = 'https://registry.test';
const NPM = 'https://npm.lemonize.cyou';
const tmp = () => mkdtempSync(join(tmpdir(), 'lem-install-v2-'));

async function packed(
  manifest: Record<string, unknown>,
  files: Record<string, string> = { 'index.js': 'export default true;\n' },
): Promise<PackResult> {
  const directory = tmp();
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ ...manifest, files: Object.keys(files) }),
  );
  for (const [name, value] of Object.entries(files)) writeFileSync(join(directory, name), value);
  return packDirectory(directory);
}

function metadata(name: string, archive: PackResult, tarball: string): PackageMetadata {
  const version = archive.manifest.version;
  return {
    name,
    normalizedName: name,
    scope: name.startsWith('@') ? name.slice(1, name.indexOf('/')) : null,
    visibility: 'public',
    latest: version,
    distTags: { latest: version },
    maintainers: ['demo'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    versions: {
      [version]: {
        version,
        tarball,
        integrity: archive.integrity,
        shasum: archive.shasum,
        unpackedSize: archive.unpackedSize,
        tarballSize: archive.size,
        fileCount: archive.fileCount,
        publishedBy: 'demo',
        publishedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  };
}

describe('recursive lockfile-v2 installer', () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    cleanCache();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('recursively installs Lemonize and npm edges without lifecycle scripts, then reinstalls frozen', async () => {
    const child = await packed({ name: '@demo/child', version: '1.0.0' });
    const npmChild = await packed({
      name: 'left-pad',
      version: '1.3.0',
      peerDependencies: { '@demo/child': '^1.0.0' },
      scripts: {
        postinstall: "node -e \"require(\\'fs\\').writeFileSync(\\'PWNED\\',\\'yes\\')\"",
      },
    });
    const root = await packed({
      name: '@demo/root',
      version: '2.0.0',
      dependencies: { 'left-pad': '^1.0.0' },
      lemonizeDependencies: { '@demo/child': '^1.0.0' },
    });
    const rootTarball = `${REGISTRY}/root.tgz`;
    const childTarball = `${REGISTRY}/child.tgz`;
    const rootAuthority = `${REGISTRY}/v1/packages/${encodeURIComponent('@demo/root')}/versions/2.0.0/tarball`;
    const childAuthority = `${REGISTRY}/v1/packages/${encodeURIComponent('@demo/child')}/versions/1.0.0/tarball`;
    const npmTarball = `${NPM}/left-pad/-/left-pad-1.3.0.tgz`;
    const rootMetadataUrl = new URL(`/v1/packages/${encodeURIComponent('@demo/root')}`, REGISTRY);
    const childMetadataUrl = new URL(`/v1/packages/${encodeURIComponent('@demo/child')}`, REGISTRY);
    const npmMetadataUrl = new URL('/left-pad', NPM);
    const rootMetadata = metadata('@demo/root', root, rootTarball);
    const childMetadata = metadata('@demo/child', child, childTarball);
    let metadataRequests = 0;
    let rootBlocked = false;

    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = new URL(input.toString());
      if (url.href === rootAuthority) {
        return rootBlocked ? new Response(null, { status: 404 }) : new Response(null);
      }
      if (url.href === childAuthority) return new Response(null);
      if (url.href === rootTarball) {
        return rootBlocked
          ? new Response('not found', { status: 404 })
          : new Response(root.tarball);
      }
      if (url.href === childTarball) return new Response(child.tarball);
      if (url.href === npmTarball) return new Response(npmChild.tarball);
      metadataRequests += 1;
      if (url.href === npmMetadataUrl.href) {
        return new Response(
          JSON.stringify({
            name: 'left-pad',
            'dist-tags': { latest: '1.3.0' },
            versions: {
              '1.3.0': {
                name: 'left-pad',
                version: '1.3.0',
                dist: { tarball: npmTarball, integrity: npmChild.integrity },
              },
            },
          }),
        );
      }
      if (url.href === rootMetadataUrl.href) {
        return new Response(JSON.stringify(rootMetadata));
      }
      if (url.href === childMetadataUrl.href) {
        return new Response(JSON.stringify(childMetadata));
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const cwd = tmp();
    const ctx = {
      registry: REGISTRY,
      token: null,
      client: new LemonizeClient({ registry: REGISTRY }),
    };
    const result = await installRequests(ctx, cwd, [
      {
        source: 'lemonize',
        name: '@demo/root',
        spec: '^2.0.0',
        kind: 'lemonizeDependencies',
      },
    ]);

    expect(metadataRequests).toBe(3);
    expect(existsSync(join(cwd, 'node_modules', '@demo', 'root', 'package.json'))).toBe(true);
    expect(
      existsSync(
        join(
          cwd,
          'node_modules',
          '@demo',
          'root',
          'node_modules',
          '@demo',
          'child',
          'package.json',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(cwd, 'node_modules', '@demo', 'root', 'node_modules', 'left-pad', 'package.json'),
      ),
    ).toBe(true);
    expect(existsSync(join(cwd, 'PWNED'))).toBe(false);
    expect(existsSync(join(cwd, 'node_modules', '@demo', 'root', 'PWNED'))).toBe(false);

    const rootKey = 'lemonize:@demo/root@2.0.0';
    expect(result.lock.lockfileVersion).toBe(2);
    expect(result.lock.root.lemonizeDependencies['@demo/root']).toBe(rootKey);
    expect(result.lock.packages[rootKey]?.dependencies).toEqual({
      '@demo/child': 'lemonize:@demo/child@1.0.0',
      'left-pad': 'npm:left-pad@1.3.0',
    });

    rmSync(join(cwd, 'node_modules'), { recursive: true, force: true });
    metadataRequests = 0;
    const frozen = await installRequests(
      ctx,
      cwd,
      [{ source: 'lemonize', name: '@demo/root', spec: '^2.0.0', kind: 'lemonizeDependencies' }],
      { frozen: true, lock: result.lock },
    );
    expect(metadataRequests).toBe(0);
    expect(frozen.installed[0]?.version).toBe('2.0.0');

    rootBlocked = true;
    rmSync(join(cwd, 'node_modules'), { recursive: true, force: true });
    await expect(
      installRequests(
        ctx,
        cwd,
        [{ source: 'lemonize', name: '@demo/root', spec: '^2.0.0', kind: 'lemonizeDependencies' }],
        { frozen: true, lock: result.lock },
      ),
    ).rejects.toThrow(/Registry denied cached artifact @demo\/root@2\.0\.0 \(404\)/);
    rootBlocked = false;

    const inconsistent = JSON.parse(JSON.stringify(result.lock)) as LockfileV2;
    delete inconsistent.packages[rootKey]!.dependencies['@demo/child'];
    rmSync(join(cwd, 'node_modules'), { recursive: true, force: true });
    await expect(
      installRequests(
        ctx,
        cwd,
        [{ source: 'lemonize', name: '@demo/root', spec: '^2.0.0', kind: 'lemonizeDependencies' }],
        { frozen: true, lock: inconsistent },
      ),
    ).rejects.toThrow(/missing required dependency/);
  });

  it('keeps an existing package intact when a staged replacement fails integrity', async () => {
    const archive = await packed({ name: '@demo/root', version: '1.0.0' });
    const tarball = `${REGISTRY}/broken.tgz`;
    const broken = metadata('@demo/root', archive, tarball);
    broken.versions['1.0.0']!.integrity = `sha512-${'A'.repeat(88)}`;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) =>
      input.toString() === tarball
        ? new Response(archive.tarball)
        : new Response(JSON.stringify(broken)),
    ) as unknown as typeof fetch;
    const cwd = tmp();
    const existing = join(cwd, 'node_modules', '@demo', 'root');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(existing, { recursive: true }));
    writeFileSync(join(existing, 'sentinel.txt'), 'keep me');
    const ctx = {
      registry: REGISTRY,
      token: null,
      client: new LemonizeClient({ registry: REGISTRY }),
    };

    await expect(
      installRequests(ctx, cwd, [
        { source: 'lemonize', name: '@demo/root', spec: '1.0.0', kind: 'lemonizeDependencies' },
      ]),
    ).rejects.toThrow(/Integrity check failed/);
    expect(readFileSync(join(existing, 'sentinel.txt'), 'utf8')).toBe('keep me');
  });
});
