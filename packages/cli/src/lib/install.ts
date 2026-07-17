import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  resolveVersion,
  isValidVersion,
  sha256Hex,
  type PackageManifest,
  type PackageMetadata,
} from '@lemonize/shared';
import { computeIntegrity, verifyIntegrity, extractTarball } from '@lemonize/package-format';
import { readCache, writeCache } from './cache.js';
import { createBinShims } from './bin-shims.js';
import { log } from './logger.js';
import { fetchPackageResource } from './http.js';
import type { ClientContext } from './client.js';
import {
  DEFAULT_NPM_REGISTRY,
  emptyLockfile,
  packageKey,
  type LockEntry,
  type LockfileV2,
  type LockfileRoot,
  type PackageSource,
} from './lockfile.js';
import {
  assertSafePackageName,
  assertValidPackageName,
  resolvePackageDirectory,
} from './package-path.js';
import { sanitizeTerminalText } from './terminal.js';

export interface InstallResult {
  name: string;
  version: string;
  source: PackageSource;
  key: string;
  integrity: string;
  shasum: string;
  resolved: string;
  bins: string[];
  fromCache: boolean;
}

export type RootDependencyKind = keyof LockfileRoot;

export interface InstallRequest {
  name: string;
  spec: string;
  source: PackageSource;
  kind: RootDependencyKind;
  optional?: boolean;
}

interface ResolvedPackage {
  source: PackageSource;
  name: string;
  version: string;
  resolved: string;
  integrity: string;
  expectedShasum?: string;
  cacheKey: string;
  bin?: Record<string, string>;
  deprecated?: string | null;
}

interface InstalledNode extends InstallResult {
  peerDependencies: Record<string, string>;
}

interface NpmVersion {
  name?: string;
  version: string;
  dist?: { tarball?: string; integrity?: string; shasum?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  lemonizeDependencies?: Record<string, string>;
  bin?: Record<string, string> | string;
  deprecated?: string;
}

interface NpmPackument {
  name: string;
  versions: Record<string, NpmVersion>;
  'dist-tags'?: Record<string, string>;
}

interface InstallState {
  ctx: ClientContext;
  lock: LockfileV2;
  resolved: Map<string, ResolvedPackage>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function dependencyMap(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!record(value)) throw new Error(`Invalid ${field} in downloaded package manifest.`);
  const result: Record<string, string> = {};
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec !== 'string' || !spec.trim()) {
      throw new Error(`Invalid ${field}.${name} in downloaded package manifest.`);
    }
    result[name] = spec;
  }
  return result;
}

function sourcePackageName(source: PackageSource, name: string): string {
  return source === 'npm' ? assertSafePackageName(name) : assertValidPackageName(name);
}

function readInstalledManifest(directory: string, expected: ResolvedPackage): PackageManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  } catch (error) {
    throw new Error(
      `Downloaded ${expected.name}@${expected.version} has an invalid package.json: ${(error as Error).message}`,
    );
  }
  if (!record(parsed)) throw new Error('Downloaded package.json must be an object.');
  if (parsed.name !== expected.name || parsed.version !== expected.version) {
    throw new Error(
      `Downloaded package manifest identity mismatch: expected ${expected.name}@${expected.version}.`,
    );
  }
  dependencyMap(parsed.dependencies, 'dependencies');
  dependencyMap(parsed.optionalDependencies, 'optionalDependencies');
  dependencyMap(parsed.peerDependencies, 'peerDependencies');
  dependencyMap(parsed.lemonizeDependencies, 'lemonizeDependencies');
  return parsed as unknown as PackageManifest;
}

function normalizedBin(
  manifest: PackageManifest,
  fallback: Record<string, string> | undefined,
): Record<string, string> {
  const value = manifest.bin ?? fallback;
  if (typeof value === 'string') {
    const command = manifest.name.includes('/')
      ? manifest.name.slice(manifest.name.lastIndexOf('/') + 1)
      : manifest.name;
    return { [command]: safeBinPath(value) };
  }
  const result: Record<string, string> = {};
  for (const [command, target] of Object.entries(value ?? {})) {
    if (!/^[A-Za-z0-9._-]+$/.test(command)) {
      throw new Error(`Invalid executable name "${command}" in ${manifest.name}.`);
    }
    result[command] = safeBinPath(target);
  }
  return result;
}

function safeBinPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    Array.from(value).some((character) => (character.codePointAt(0) ?? 0) < 0x20)
  ) {
    throw new Error('Package executable paths must be safe relative paths.');
  }
  const normalized = value.startsWith('./') ? value.slice(2) : value;
  if (
    normalized
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.includes(':'))
  ) {
    throw new Error('Package executable paths must be safe relative paths.');
  }
  return normalized;
}

async function responseJson<T>(response: Response, description: string): Promise<T> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${description} returned invalid JSON (${response.status}).`);
  }
  if (!response.ok) {
    const message =
      record(parsed) && record(parsed.error) && typeof parsed.error.message === 'string'
        ? parsed.error.message
        : `${description} failed (${response.status}).`;
    const requestId =
      record(parsed) && record(parsed.error) && typeof parsed.error.requestId === 'string'
        ? ` Request ID: ${parsed.error.requestId}`
        : '';
    throw new Error(`${message}${requestId}`);
  }
  return parsed as T;
}

function npmIntegrity(value: string | undefined): string {
  const integrity = value
    ?.split(/\s+/)
    .find((candidate) => /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(candidate));
  if (!integrity)
    throw new Error('npm metadata does not provide a supported SHA-512 integrity value.');
  return integrity;
}

async function resolveNpm(
  state: InstallState,
  name: string,
  spec: string,
): Promise<ResolvedPackage> {
  const safeName = assertSafePackageName(name);
  const url = `${state.lock.registries.npm}/${encodeURIComponent(safeName)}`;
  const response = await fetchPackageResource(state.lock.registries.npm, url, null);
  const metadata = await responseJson<NpmPackument>(
    response,
    `npm metadata request for ${safeName}`,
  );
  if (metadata.name !== safeName || !record(metadata.versions)) {
    throw new Error('npm metadata package name does not match the request.');
  }
  const version = resolveVersion(spec, Object.keys(metadata.versions), metadata['dist-tags'] ?? {});
  if (!version) throw new Error(`No npm version of ${safeName} satisfies "${spec}".`);
  if (!isValidVersion(version)) throw new Error('npm proxy returned an invalid package version.');
  const selected = metadata.versions[version];
  if (!selected || selected.version !== version || !selected.dist?.tarball) {
    throw new Error('npm proxy returned incomplete version metadata.');
  }
  const integrity = npmIntegrity(selected.dist.integrity);
  const cacheKey = await sha256Hex(new TextEncoder().encode(`npm-sri:${integrity}`));
  return {
    source: 'npm',
    name: safeName,
    version,
    resolved: selected.dist.tarball,
    integrity,
    cacheKey,
    bin: typeof selected.bin === 'object' ? selected.bin : undefined,
    deprecated: selected.deprecated,
  };
}

async function resolveLemonize(
  state: InstallState,
  name: string,
  spec: string,
): Promise<ResolvedPackage> {
  const safeName = assertValidPackageName(name);
  const metadata: PackageMetadata = await state.ctx.client.getPackage(safeName);
  if (assertValidPackageName(metadata.name) !== safeName) {
    throw new Error('Registry package name does not match the request.');
  }
  const version = resolveVersion(spec, Object.keys(metadata.versions), metadata.distTags);
  if (!version) throw new Error(`No Lemonize version of ${safeName} satisfies "${spec}".`);
  if (!isValidVersion(version)) throw new Error('Registry returned an invalid package version.');
  const selected = metadata.versions[version];
  if (!selected || selected.version !== version) {
    throw new Error('Registry returned inconsistent package version metadata.');
  }
  if (!/^[a-f0-9]{64}$/i.test(selected.shasum)) {
    throw new Error('Invalid SHA-256 shasum from registry metadata.');
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(selected.integrity)) {
    throw new Error('Registry returned an invalid SHA-512 integrity value.');
  }
  return {
    source: 'lemonize',
    name: safeName,
    version,
    resolved: selected.tarball,
    integrity: selected.integrity,
    expectedShasum: selected.shasum.toLowerCase(),
    cacheKey: selected.shasum.toLowerCase(),
    bin: selected.bin,
    deprecated: selected.deprecated,
  };
}

async function resolvePackage(
  state: InstallState,
  source: PackageSource,
  name: string,
  spec: string,
): Promise<ResolvedPackage> {
  const lookup = `${source}:${name}:${spec}`;
  const existing = state.resolved.get(lookup);
  if (existing) return existing;
  const resolved =
    source === 'npm'
      ? await resolveNpm(state, name, spec)
      : await resolveLemonize(state, name, spec);
  state.resolved.set(lookup, resolved);
  return resolved;
}

async function acquireTarball(
  state: InstallState,
  resolved: ResolvedPackage,
): Promise<{ data: Uint8Array; shasum: string; fromCache: boolean }> {
  let data = readCache(resolved.cacheKey);
  const fromCache = data !== null;
  if (data && resolved.source === 'lemonize') {
    const authority = `${state.ctx.registry}/v1/packages/${encodeURIComponent(resolved.name)}/versions/${encodeURIComponent(resolved.version)}/tarball`;
    const availability = await fetchPackageResource(
      state.ctx.registry,
      authority,
      state.ctx.token,
      { method: 'HEAD' },
    );
    await availability.body?.cancel().catch(() => undefined);
    if (!availability.ok) {
      throw new Error(
        `Registry denied cached artifact ${resolved.name}@${resolved.version} (${availability.status}).`,
      );
    }
  }
  if (!data) {
    log.debug(
      `downloading ${resolved.source}:${resolved.name}@${resolved.version} from ${resolved.resolved}`,
    );
    const response = await fetchPackageResource(
      resolved.source === 'lemonize' ? state.ctx.registry : state.lock.registries.npm,
      resolved.resolved,
      resolved.source === 'lemonize' ? state.ctx.token : null,
    );
    if (!response.ok) {
      throw new Error(`Download failed (${response.status}) for ${resolved.resolved}`);
    }
    data = new Uint8Array(await response.arrayBuffer());
  }
  await verifyIntegrity(data, resolved.integrity);
  const computed = await computeIntegrity(data);
  if (resolved.expectedShasum && computed.shasum !== resolved.expectedShasum) {
    throw new Error(
      `SHA-256 check failed for ${resolved.name}@${resolved.version}. Expected ${resolved.expectedShasum}, got ${computed.shasum}.`,
    );
  }
  if (!fromCache) writeCache(resolved.cacheKey, data);
  return { data, shasum: computed.shasum, fromCache };
}

function atomicReplace(staging: string, destination: string, nodeModulesDir: string): void {
  const backup = join(nodeModulesDir, `.lem-backup-${randomUUID()}`);
  let movedExisting = false;
  try {
    mkdirSync(dirname(destination), { recursive: true });
    if (existsSync(destination)) {
      renameSync(destination, backup);
      movedExisting = true;
    }
    renameSync(staging, destination);
    if (movedExisting) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(destination) && movedExisting && existsSync(backup)) {
      renameSync(backup, destination);
    }
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (existsSync(destination)) rmSync(backup, { recursive: true, force: true });
  }
}

function satisfies(version: string, range: string): boolean {
  return resolveVersion(range, [version], {}) === version;
}

function validatePeers(
  owner: string,
  peers: Record<string, string>,
  available: Map<string, InstalledNode>,
): void {
  for (const [name, range] of Object.entries(peers).sort(([a], [b]) => a.localeCompare(b))) {
    const installed = available.get(name);
    if (!installed) {
      throw new Error(
        `${owner} requires peer ${name}@${range}, but it is not installed in an ancestor.`,
      );
    }
    if (!satisfies(installed.version, range)) {
      throw new Error(
        `${owner} requires peer ${name}@${range}, but ${installed.version} is installed.`,
      );
    }
  }
}

function mergeDependencies(manifest: PackageManifest): {
  required: Array<[PackageSource, string, string]>;
  optional: Array<[PackageSource, string, string]>;
  peers: Record<string, string>;
} {
  const npm = dependencyMap(manifest.dependencies, 'dependencies');
  const optional = dependencyMap(manifest.optionalDependencies, 'optionalDependencies');
  const lemonize = dependencyMap(manifest.lemonizeDependencies, 'lemonizeDependencies');
  const peers = dependencyMap(manifest.peerDependencies, 'peerDependencies');
  for (const name of [...Object.keys(npm), ...Object.keys(optional), ...Object.keys(peers)]) {
    assertSafePackageName(name);
  }
  for (const name of Object.keys(lemonize)) assertValidPackageName(name);
  for (const [name, metadata] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
    if (metadata?.optional) delete peers[name];
  }
  for (const name of Object.keys(lemonize)) {
    if (name in npm || name in optional) {
      throw new Error(`Dependency ${name} is declared from both npm and Lemonize.`);
    }
  }
  return {
    required: [
      ...Object.entries(npm).map(
        ([name, spec]) => ['npm', name, spec] as [PackageSource, string, string],
      ),
      ...Object.entries(lemonize).map(
        ([name, spec]) => ['lemonize', name, spec] as [PackageSource, string, string],
      ),
    ].sort((a, b) => a[1].localeCompare(b[1])),
    optional: Object.entries(optional)
      .map(([name, spec]) => ['npm', name, spec] as [PackageSource, string, string])
      .sort((a, b) => a[1].localeCompare(b[1])),
    peers,
  };
}

async function installResolved(
  state: InstallState,
  parentDirectory: string,
  resolved: ResolvedPackage,
  ancestors: Map<string, InstalledNode>,
  ancestorKeys: Set<string>,
  depth: number,
): Promise<InstalledNode> {
  if (depth > 128) throw new Error('Dependency graph exceeds the maximum depth of 128.');
  const key = packageKey(resolved.source, resolved.name, resolved.version);
  const ancestor = ancestors.get(resolved.name);
  if (ancestor?.key === key) return ancestor;
  const destination = resolvePackageDirectory(parentDirectory, resolved.name);
  mkdirSync(destination.nodeModulesDir, { recursive: true });
  const staging = join(destination.nodeModulesDir, `.lem-stage-${randomUUID()}`);
  mkdirSync(staging, { recursive: false });

  try {
    if (resolved.deprecated) {
      log.warn(
        `${resolved.name}@${resolved.version} is deprecated: ${sanitizeTerminalText(resolved.deprecated)}`,
      );
    }
    const acquired = await acquireTarball(state, resolved);
    await extractTarball(acquired.data, staging, { stripPackagePrefix: true });
    const manifest = readInstalledManifest(staging, resolved);
    const dependencySpec = mergeDependencies(manifest);
    const bin = normalizedBin(manifest, resolved.bin);
    for (const target of Object.values(bin)) {
      if (!existsSync(join(staging, target))) {
        throw new Error(
          `${resolved.name}@${resolved.version} declares missing executable ${target}.`,
        );
      }
    }
    const optionalNames = new Set(dependencySpec.optional.map(([, name]) => name));
    const dependencies: Record<string, string> = {};
    const childNodes = new Map<string, InstalledNode>();
    const nextAncestors = new Map(ancestors);
    const self: InstalledNode = {
      name: resolved.name,
      version: resolved.version,
      source: resolved.source,
      key,
      integrity: resolved.integrity,
      shasum: acquired.shasum,
      resolved: resolved.resolved,
      bins: [],
      fromCache: acquired.fromCache,
      peerDependencies: dependencySpec.peers,
    };
    nextAncestors.set(resolved.name, self);
    const nextKeys = new Set(ancestorKeys).add(key);

    const installChild = async (source: PackageSource, name: string, spec: string) => {
      const childResolved = await resolvePackage(state, source, name, spec);
      const childKey = packageKey(source, childResolved.name, childResolved.version);
      dependencies[name] = childKey;
      if (nextKeys.has(childKey)) {
        const cyclic = nextAncestors.get(name);
        if (!cyclic || cyclic.key !== childKey) {
          throw new Error(`Dependency cycle for ${childKey} cannot be represented safely.`);
        }
        childNodes.set(name, cyclic);
        return;
      }
      const child = await installResolved(
        state,
        staging,
        childResolved,
        nextAncestors,
        nextKeys,
        depth + 1,
      );
      childNodes.set(name, child);
    };

    for (const [source, name, spec] of dependencySpec.required) {
      await installChild(source, name, spec);
    }
    for (const [source, name, spec] of dependencySpec.optional) {
      try {
        await installChild(source, name, spec);
      } catch (error) {
        delete dependencies[name];
        log.warn(
          `Skipping optional dependency ${name}: ${sanitizeTerminalText((error as Error).message)}`,
        );
      }
    }

    const available = new Map(nextAncestors);
    for (const [name, child] of childNodes) available.set(name, child);
    for (const [name, child] of childNodes) {
      if (!optionalNames.has(name)) continue;
      try {
        validatePeers(`${child.name}@${child.version}`, child.peerDependencies, available);
      } catch (error) {
        delete dependencies[name];
        childNodes.delete(name);
        available.delete(name);
        const installed = resolvePackageDirectory(staging, name);
        rmSync(installed.packageDir, { recursive: true, force: true });
        for (const bin of child.bins) {
          rmSync(join(installed.nodeModulesDir, '.bin', bin), { force: true });
          rmSync(join(installed.nodeModulesDir, '.bin', `${bin}.cmd`), { force: true });
        }
        log.warn(
          `Skipping optional dependency ${name}: ${sanitizeTerminalText((error as Error).message)}`,
        );
      }
    }
    for (const [name, child] of childNodes) {
      if (optionalNames.has(name)) continue;
      validatePeers(`${child.name}@${child.version}`, child.peerDependencies, available);
    }

    state.lock.packages[key] = {
      source: resolved.source,
      name: resolved.name,
      version: resolved.version,
      resolved: resolved.resolved,
      integrity: resolved.integrity,
      shasum: acquired.shasum,
      dependencies,
      ...(Object.keys(dependencySpec.peers).length
        ? { peerDependencies: dependencySpec.peers }
        : {}),
    };
    atomicReplace(staging, destination.packageDir, destination.nodeModulesDir);
    self.bins = createBinShims(destination.nodeModulesDir, destination.packageDir, bin);
    return self;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function lockedResolved(entry: LockEntry): ResolvedPackage {
  if (!/^[a-f0-9]{64}$/i.test(entry.shasum)) {
    throw new Error(
      `Lockfile entry ${entry.source}:${entry.name}@${entry.version} has an invalid shasum.`,
    );
  }
  return {
    source: entry.source,
    name: sourcePackageName(entry.source, entry.name),
    version: entry.version,
    resolved: entry.resolved,
    integrity: entry.integrity,
    expectedShasum: entry.shasum,
    cacheKey: entry.shasum,
  };
}

function validateFrozenManifestEdges(
  lock: LockfileV2,
  entry: LockEntry,
  manifest: PackageManifest,
): void {
  const declared = mergeDependencies(manifest);
  const required = new Map(
    declared.required.map(([source, name, spec]) => [name, { source, spec }] as const),
  );
  const optional = new Map(
    declared.optional.map(([source, name, spec]) => [name, { source, spec }] as const),
  );
  for (const name of required.keys()) {
    if (!entry.dependencies[name]) {
      throw new Error(`Frozen lockfile is missing required dependency ${entry.name} -> ${name}.`);
    }
  }
  for (const [name, key] of Object.entries(entry.dependencies)) {
    const expectation = required.get(name) ?? optional.get(name);
    if (!expectation) {
      throw new Error(`Frozen lockfile contains undeclared dependency ${entry.name} -> ${name}.`);
    }
    const child = lock.packages[key];
    if (
      !child ||
      child.source !== expectation.source ||
      child.name !== name ||
      !satisfies(child.version, expectation.spec)
    ) {
      throw new Error(`Frozen lockfile dependency ${entry.name} -> ${name} is incompatible.`);
    }
  }
}

async function installLocked(
  state: InstallState,
  parentDirectory: string,
  key: string,
  ancestors: Map<string, InstalledNode>,
  ancestorKeys: Set<string>,
  depth: number,
): Promise<InstalledNode> {
  if (depth > 128) throw new Error('Dependency graph exceeds the maximum depth of 128.');
  const entry = state.lock.packages[key];
  if (!entry || packageKey(entry.source, entry.name, entry.version) !== key) {
    throw new Error(`Frozen lockfile has a missing or inconsistent package edge: ${key}.`);
  }
  const ancestor = ancestors.get(entry.name);
  if (ancestor?.key === key) return ancestor;
  const resolved = lockedResolved(entry);
  const destination = resolvePackageDirectory(parentDirectory, entry.name);
  mkdirSync(destination.nodeModulesDir, { recursive: true });
  const staging = join(destination.nodeModulesDir, `.lem-stage-${randomUUID()}`);
  mkdirSync(staging);
  try {
    const acquired = await acquireTarball(state, resolved);
    await extractTarball(acquired.data, staging, { stripPackagePrefix: true });
    const manifest = readInstalledManifest(staging, resolved);
    validateFrozenManifestEdges(state.lock, entry, manifest);
    const bin = normalizedBin(manifest, undefined);
    for (const target of Object.values(bin)) {
      if (!existsSync(join(staging, target))) {
        throw new Error(`${entry.name}@${entry.version} declares missing executable ${target}.`);
      }
    }
    const manifestPeers = mergeDependencies(manifest).peers;
    const peers = entry.peerDependencies ?? manifestPeers;
    const self: InstalledNode = {
      name: entry.name,
      version: entry.version,
      source: entry.source,
      key,
      integrity: entry.integrity,
      shasum: entry.shasum,
      resolved: entry.resolved,
      bins: [],
      fromCache: acquired.fromCache,
      peerDependencies: peers,
    };
    const nextAncestors = new Map(ancestors).set(entry.name, self);
    const nextKeys = new Set(ancestorKeys).add(key);
    const children = new Map<string, InstalledNode>();
    for (const [name, childKey] of Object.entries(entry.dependencies).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (nextKeys.has(childKey)) {
        const cyclic = nextAncestors.get(name);
        if (!cyclic || cyclic.key !== childKey) {
          throw new Error(`Frozen dependency cycle for ${childKey} is inconsistent.`);
        }
        children.set(name, cyclic);
      } else {
        children.set(
          name,
          await installLocked(state, staging, childKey, nextAncestors, nextKeys, depth + 1),
        );
      }
    }
    const available = new Map(nextAncestors);
    for (const [name, child] of children) available.set(name, child);
    for (const child of children.values()) {
      validatePeers(`${child.name}@${child.version}`, child.peerDependencies, available);
    }
    atomicReplace(staging, destination.packageDir, destination.nodeModulesDir);
    self.bins = createBinShims(destination.nodeModulesDir, destination.packageDir, bin);
    return self;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function rootMap(lock: LockfileV2, kind: RootDependencyKind): Record<string, string> {
  return lock.root[kind];
}

function pruneUnreachablePackages(lock: LockfileV2): void {
  const reachable = new Set<string>();
  const queue: string[] = Object.values(lock.root).flatMap((dependencies) =>
    Object.values(dependencies),
  );
  while (queue.length) {
    const key = queue.pop()!;
    if (reachable.has(key)) continue;
    reachable.add(key);
    for (const child of Object.values(lock.packages[key]?.dependencies ?? {})) queue.push(child);
  }
  lock.packages = Object.fromEntries(
    Object.entries(lock.packages).filter(([key]) => reachable.has(key)),
  );
}

export async function installRequests(
  ctx: ClientContext,
  cwd: string,
  requests: InstallRequest[],
  options: {
    frozen?: boolean;
    lock?: LockfileV2;
    npmRegistry?: string;
  } = {},
): Promise<{ lock: LockfileV2; installed: InstallResult[] }> {
  const frozen = options.frozen ?? false;
  const lock = frozen
    ? options.lock
    : emptyLockfile(
        ctx.registry,
        options.npmRegistry ?? options.lock?.registries.npm ?? DEFAULT_NPM_REGISTRY,
      );
  if (!lock) throw new Error('Frozen install requires lockfileVersion 2.');
  if (frozen && lock.registries.lemonize !== ctx.registry) {
    throw new Error(
      `Frozen lockfile registry ${lock.registries.lemonize} does not match ${ctx.registry}.`,
    );
  }
  const state: InstallState = { ctx, lock, resolved: new Map() };
  const installed: InstalledNode[] = [];
  const seenRootNames = new Map<string, PackageSource>();
  const optionalRoots = new Set(
    requests
      .filter((request) => request.optional)
      .map((request) => `${request.source}:${request.name}`),
  );

  for (const request of [...requests].sort((a, b) =>
    `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`),
  )) {
    const name = sourcePackageName(request.source, request.name);
    const previousSource = seenRootNames.get(name);
    if (previousSource && previousSource !== request.source) {
      throw new Error(`Root dependency ${name} is declared from both npm and Lemonize.`);
    }
    seenRootNames.set(name, request.source);
    const map = rootMap(lock, request.kind);
    try {
      let node: InstalledNode;
      if (frozen) {
        const key = map[name];
        if (!key) throw new Error(`Frozen lockfile has no ${request.kind} resolution for ${name}.`);
        const entry = lock.packages[key];
        if (!entry || entry.source !== request.source || !satisfies(entry.version, request.spec)) {
          throw new Error(
            `Frozen lockfile resolution for ${name} does not satisfy ${request.source}:${request.spec}.`,
          );
        }
        node = await installLocked(state, cwd, key, new Map(), new Set(), 0);
      } else {
        const resolved = await resolvePackage(state, request.source, name, request.spec);
        node = await installResolved(state, cwd, resolved, new Map(), new Set(), 0);
        map[name] = node.key;
      }
      installed.push(node);
    } catch (error) {
      if (!request.optional) throw error;
      delete map[name];
      log.warn(
        `Skipping optional dependency ${name}: ${sanitizeTerminalText((error as Error).message)}`,
      );
    }
  }
  const rootAvailable = new Map(installed.map((node) => [node.name, node]));
  for (let index = installed.length - 1; index >= 0; index -= 1) {
    const node = installed[index]!;
    try {
      validatePeers(`${node.name}@${node.version}`, node.peerDependencies, rootAvailable);
    } catch (error) {
      if (!optionalRoots.has(`${node.source}:${node.name}`)) throw error;
      installed.splice(index, 1);
      rootAvailable.delete(node.name);
      delete lock.root.optionalDependencies[node.name];
      const packagePath = resolvePackageDirectory(cwd, node.name);
      rmSync(packagePath.packageDir, { recursive: true, force: true });
      for (const bin of node.bins) {
        rmSync(join(packagePath.nodeModulesDir, '.bin', bin), { force: true });
        rmSync(join(packagePath.nodeModulesDir, '.bin', `${bin}.cmd`), { force: true });
      }
      log.warn(
        `Skipping optional dependency ${node.name}: ${sanitizeTerminalText((error as Error).message)}`,
      );
    }
  }
  pruneUnreachablePackages(lock);
  return { lock, installed };
}

/**
 * Backward-compatible single native package primitive used by integrations.
 * New command code installs through installRequests(), which records v2 roots.
 */
export async function installOne(
  ctx: ClientContext,
  cwd: string,
  name: string,
  spec: string,
  lock: LockfileV2,
): Promise<InstallResult> {
  const result = await installRequests(
    ctx,
    cwd,
    [{ name, spec, source: 'lemonize', kind: 'lemonizeDependencies' }],
    { lock },
  );
  lock.registries = result.lock.registries;
  lock.root = result.lock.root;
  lock.packages = result.lock.packages;
  const installed = result.installed[0]!;
  // v1 callers historically indexed the in-memory object by package name.
  // Keep that read-only compatibility alias out of serialized v2 lockfiles.
  Object.defineProperty(lock.packages, installed.name, {
    value: lock.packages[installed.key],
    enumerable: false,
    configurable: true,
  });
  return installed;
}
