import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { LOCKFILE_NAME } from './paths.js';

export const DEFAULT_NPM_REGISTRY = 'https://npm.lemonize.cyou';

export type PackageSource = 'lemonize' | 'npm';

export interface LegacyLockEntry {
  version: string;
  resolved: string;
  integrity: string;
  shasum: string;
}

export interface LockfileV1 {
  lockfileVersion: 1;
  registry: string;
  packages: Record<string, LegacyLockEntry>;
}

export interface LockEntry {
  source: PackageSource;
  name: string;
  version: string;
  resolved: string;
  integrity: string;
  /** SHA-256 of the downloaded archive. */
  shasum: string;
  /** Package name to deterministic package-key edge. */
  dependencies: Record<string, string>;
  /** Declared peer ranges, retained so frozen installs can validate them. */
  peerDependencies?: Record<string, string>;
}

export interface LockfileRoot {
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  lemonizeDependencies: Record<string, string>;
}

export interface LockfileV2 {
  lockfileVersion: 2;
  registries: {
    lemonize: string;
    npm: string;
  };
  root: LockfileRoot;
  packages: Record<string, LockEntry>;
}

export type Lockfile = LockfileV1 | LockfileV2;

export function packageKey(source: PackageSource, name: string, version: string): string {
  return `${source}:${name}@${version}`;
}

export function lockPath(cwd: string): string {
  return join(cwd, LOCKFILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function isLegacyEntry(value: unknown): value is LegacyLockEntry {
  return (
    isRecord(value) &&
    typeof value.version === 'string' &&
    typeof value.resolved === 'string' &&
    typeof value.integrity === 'string' &&
    typeof value.shasum === 'string'
  );
}

function isV2Entry(value: unknown): value is LockEntry {
  const candidate = value as Record<string, unknown>;
  return (
    isLegacyEntry(value) &&
    (candidate.source === 'lemonize' || candidate.source === 'npm') &&
    typeof candidate.name === 'string' &&
    isStringMap(candidate.dependencies) &&
    (candidate.peerDependencies === undefined || isStringMap(candidate.peerDependencies))
  );
}

function isLockfile(value: unknown): value is Lockfile {
  if (!isRecord(value) || !isRecord(value.packages)) return false;
  if (value.lockfileVersion === 1) {
    return typeof value.registry === 'string' && Object.values(value.packages).every(isLegacyEntry);
  }
  if (
    value.lockfileVersion !== 2 ||
    !isRecord(value.registries) ||
    typeof value.registries.lemonize !== 'string' ||
    typeof value.registries.npm !== 'string' ||
    !isRecord(value.root)
  ) {
    return false;
  }
  return (
    isStringMap(value.root.dependencies) &&
    isStringMap(value.root.optionalDependencies) &&
    isStringMap(value.root.devDependencies) &&
    isStringMap(value.root.lemonizeDependencies) &&
    Object.values(value.packages).every(isV2Entry)
  );
}

export function readLockfile(cwd: string): Lockfile | null {
  const path = lockPath(cwd);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isLockfile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sorted<T>(input: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}

function normalized(lock: LockfileV2): LockfileV2 {
  const packages: Record<string, LockEntry> = {};
  for (const [key, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
    packages[key] = {
      ...entry,
      dependencies: sorted(entry.dependencies),
      ...(entry.peerDependencies ? { peerDependencies: sorted(entry.peerDependencies) } : {}),
    };
  }
  return {
    lockfileVersion: 2,
    registries: lock.registries,
    root: {
      dependencies: sorted(lock.root.dependencies),
      optionalDependencies: sorted(lock.root.optionalDependencies),
      devDependencies: sorted(lock.root.devDependencies),
      lemonizeDependencies: sorted(lock.root.lemonizeDependencies),
    },
    packages,
  };
}

/** Write through a same-directory temporary file, then atomically replace. */
export function writeLockfile(cwd: string, lock: LockfileV2): void {
  const path = lockPath(cwd);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(normalized(lock), null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function emptyLockfile(
  lemonizeRegistry: string,
  npmRegistry = DEFAULT_NPM_REGISTRY,
): LockfileV2 {
  return {
    lockfileVersion: 2,
    registries: { lemonize: lemonizeRegistry, npm: npmRegistry },
    root: {
      dependencies: {},
      optionalDependencies: {},
      devDependencies: {},
      lemonizeDependencies: {},
    },
    packages: {},
  };
}

export function upgradeLockfile(lock: LockfileV1, npmRegistry = DEFAULT_NPM_REGISTRY): LockfileV2 {
  const upgraded = emptyLockfile(lock.registry, npmRegistry);
  for (const [name, legacy] of Object.entries(lock.packages).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const key = packageKey('lemonize', name, legacy.version);
    upgraded.root.lemonizeDependencies[name] = key;
    upgraded.packages[key] = {
      source: 'lemonize',
      name,
      ...legacy,
      dependencies: {},
    };
  }
  return upgraded;
}

export function requireLockfileV2(lock: Lockfile | null, frozen: boolean): LockfileV2 {
  if (!lock) {
    if (frozen) throw new Error('Frozen install requires a valid lemonize-lock.json file.');
    throw new Error('No valid lockfile was found.');
  }
  if (lock.lockfileVersion === 1) {
    if (frozen) {
      throw new Error(
        'Frozen install requires lockfileVersion 2. Run "lem install" once to upgrade the lockfile.',
      );
    }
    return upgradeLockfile(lock);
  }
  return lock;
}
