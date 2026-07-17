import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyLockfile,
  packageKey,
  readLockfile,
  requireLockfileV2,
  upgradeLockfile,
  writeLockfile,
  type LockfileV1,
} from '../src/lib/lockfile.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'lem-lock-v2-'));

describe('lockfile v2', () => {
  it('records registries, roots, source identity, integrity, and deterministic edges', () => {
    const cwd = tmp();
    const lock = emptyLockfile('https://registry.example.test');
    const child = packageKey('npm', 'child', '1.0.0');
    const root = packageKey('lemonize', '@demo/root', '2.0.0');
    lock.root.lemonizeDependencies['@demo/root'] = root;
    lock.packages[root] = {
      source: 'lemonize',
      name: '@demo/root',
      version: '2.0.0',
      resolved: 'https://registry.example.test/root.tgz',
      integrity: 'sha512-root',
      shasum: 'a'.repeat(64),
      dependencies: { child },
    };
    lock.packages[child] = {
      source: 'npm',
      name: 'child',
      version: '1.0.0',
      resolved: 'https://npm.lemonize.cyou/child.tgz',
      integrity: 'sha512-child',
      shasum: 'b'.repeat(64),
      dependencies: {},
    };

    writeLockfile(cwd, lock);
    const first = readFileSync(join(cwd, 'lemonize-lock.json'), 'utf8');
    writeLockfile(cwd, lock);
    expect(readFileSync(join(cwd, 'lemonize-lock.json'), 'utf8')).toBe(first);
    expect(readLockfile(cwd)).toEqual(lock);
  });

  it('upgrades v1 on mutable installs and rejects it for frozen installs', () => {
    const legacy: LockfileV1 = {
      lockfileVersion: 1,
      registry: 'https://registry.example.test',
      packages: {
        '@demo/pkg': {
          version: '1.2.3',
          resolved: 'https://registry.example.test/pkg.tgz',
          integrity: 'sha512-value',
          shasum: 'c'.repeat(64),
        },
      },
    };
    const upgraded = upgradeLockfile(legacy);
    expect(upgraded.lockfileVersion).toBe(2);
    expect(upgraded.root.lemonizeDependencies['@demo/pkg']).toBe('lemonize:@demo/pkg@1.2.3');
    expect(() => requireLockfileV2(legacy, true)).toThrow(/lockfileVersion 2/);

    const cwd = tmp();
    writeFileSync(join(cwd, 'lemonize-lock.json'), '{not json');
    expect(() => requireLockfileV2(readLockfile(cwd), true)).toThrow(/valid lemonize-lock.json/);
  });
});
