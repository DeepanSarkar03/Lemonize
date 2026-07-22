import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, delimiter } from 'node:path';
import { spawn } from 'node:child_process';
import {
  ApiClientError,
  isValidVersion,
  parseInstallTarget,
  type TokenScope,
} from '@lemonize/shared';
import { packDirectory } from '@lemonize/package-format';
import { log } from './lib/logger.js';
import { makeClient } from './lib/client.js';
import {
  resolveRegistry,
  loadConfig,
  saveConfig,
  setToken,
  clearToken,
  getToken,
  validateRegistryUrl,
} from './lib/config.js';
import { fetchPackageResource, fetchRegistryWithToken } from './lib/http.js';
import {
  emptyLockfile,
  readLockfile,
  requireLockfileV2,
  upgradeLockfile,
  writeLockfile,
  type LockfileV2,
  type PackageSource,
} from './lib/lockfile.js';
import { installRequests, type InstallRequest } from './lib/install.js';
import { cleanCache, readCache, writeCache } from './lib/cache.js';
import { verifyIntegrity, extractTarball } from '@lemonize/package-format';
import { readProjectPkg, writeProjectPkg } from './lib/project.js';
import {
  assertSafePackageName,
  assertValidPackageName,
  resolvePackageDirectory,
  resolveStrictChild,
} from './lib/package-path.js';
import { sanitizeTerminalText } from './lib/terminal.js';
import {
  clearPublishState,
  loadPublishState,
  savePublishState,
  type PublishState,
} from './lib/publish-state.js';

export interface GlobalOpts {
  registry?: string;
  json?: boolean;
  verbose?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- init ----------------
export async function cmdInit(opts: GlobalOpts) {
  const cwd = process.cwd();
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    log.warn('package.json already exists; leaving it untouched.');
    return;
  }
  const { client } = makeClient(opts.registry, true);
  const { user } = await client.me();
  const rawDirectoryName = cwd.split(/[\\/]/).pop() ?? 'my-package';
  const dirName =
    rawDirectoryName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[._-]+|[._-]+$/g, '') || 'my-package';
  const packageName = assertValidPackageName(`@${user.username}/${dirName}`);
  const manifest = {
    name: packageName,
    version: '0.1.0',
    description: '',
    type: 'module',
    main: './index.js',
    files: ['index.js', 'README.md'],
    lemonize: { access: 'public', tag: 'latest' },
  };
  writeFileSync(pkgPath, JSON.stringify(manifest, null, 2) + '\n');
  if (!existsSync(join(cwd, 'index.js'))) {
    writeFileSync(join(cwd, 'index.js'), "export const hello = () => 'hello from lemonize';\n");
  }
  if (!existsSync(join(cwd, 'README.md'))) {
    writeFileSync(join(cwd, 'README.md'), `# ${packageName}\n\nPublished with Lemonize.\n`);
  }
  if (opts.json) return log.json(manifest);
  log.success(`Initialized ${manifest.name}@${manifest.version}`);
}

// ---------------- login (device flow) ----------------
export async function cmdLogin(opts: GlobalOpts & { username?: string }) {
  const registry = resolveRegistry({ registryFlag: opts.registry });
  const { client } = makeClient(opts.registry);
  const start = await client.deviceStart(opts.username);
  log.info(`\nTo authorize this device, open:\n\n  ${log.bold(start.verificationUrl)}\n`);
  log.info(`and confirm the code: ${log.yellow(start.userCode)}\n`);
  log.step('Waiting for approval…');

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(start.interval * 1000);
    const poll = await client.devicePoll(start.deviceCode);
    if (poll.status === 'approved' && poll.token) {
      setToken(registry, poll.token);
      if (opts.json)
        return log.json({ status: 'approved', username: poll.user?.username, registry });
      return log.success(`Logged in as ${poll.user?.username ?? 'user'} on ${registry}`);
    }
    if (poll.status === 'expired') throw new Error('Login request expired. Try again.');
  }
  throw new Error('Timed out waiting for login approval.');
}

export async function cmdLogout(opts: GlobalOpts) {
  const registry = resolveRegistry({ registryFlag: opts.registry });
  const token = getToken(registry);
  let remoteRevoked = !token;
  let remoteError: string | undefined;
  if (token) {
    try {
      const response = await fetchRegistryWithToken(registry, '/v1/auth/logout', token, {
        method: 'POST',
      });
      if (!response.ok) {
        const body = await response.text();
        let message = `remote logout failed (${response.status})`;
        try {
          const parsed = body ? JSON.parse(body) : null;
          if (parsed?.error?.message) message = parsed.error.message;
          if (parsed?.error?.requestId) message += ` (request ${parsed.error.requestId})`;
        } catch {
          // Preserve the status-only message for non-JSON failures.
        }
        throw new Error(message);
      }
      remoteRevoked = true;
    } catch (error) {
      remoteError = (error as Error).message;
    }
  }
  clearToken(registry);
  if (opts.json)
    return log.json({ registry, localCredentialsRemoved: true, remoteRevoked, remoteError });
  if (!remoteRevoked) {
    log.warn(
      `Local credentials were removed, but the registry could not revoke the token: ${sanitizeTerminalText(remoteError ?? 'unknown error')}`,
    );
    return;
  }
  log.success(`Logged out of ${registry}`);
}

export async function cmdWhoami(opts: GlobalOpts) {
  const { client } = makeClient(opts.registry, true);
  const me = await client.me();
  if (opts.json) return log.json(me.user);
  log.info(me.user.username);
}

export async function cmdTokenList(opts: GlobalOpts) {
  const { client } = makeClient(opts.registry, true);
  const { tokens } = await client.listTokens();
  if (opts.json) return log.json(tokens);
  if (tokens.length === 0) return log.info('No active tokens.');
  for (const token of tokens) {
    const scopes = token.scopes?.join(',') ?? '(legacy)';
    log.info(
      `${token.id}  ${sanitizeTerminalText(token.label)}  ${token.prefix}  ${scopes}  expires ${token.expiresAt ?? 'never'}`,
    );
  }
}

export async function cmdTokenCreate(
  label: string,
  opts: GlobalOpts & { expiresInDays?: number; scopes?: string[] },
) {
  const allowed = new Set<TokenScope>(['read', 'publish', 'manage:packages']);
  const scopes = (opts.scopes ?? ['read', 'publish', 'manage:packages']) as TokenScope[];
  if (scopes.length === 0 || scopes.some((scope) => !allowed.has(scope))) {
    throw new Error('Invalid token scope. CLI-created tokens may use read, publish, or manage:packages.');
  }
  const expiresInDays = opts.expiresInDays ?? 30;
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 90) {
    throw new Error('--expires-in-days must be an integer from 1 to 90.');
  }
  const { client } = makeClient(opts.registry, true);
  const created = await client.createToken({
    label,
    expiresInDays,
    scopes: [...new Set(scopes)],
  });
  if (opts.json) return log.json(created);
  log.success(`Created token ${created.id}. Copy it now; it will not be shown again:`);
  log.info(created.token);
}

export async function cmdTokenRevoke(id: string, opts: GlobalOpts) {
  const { client } = makeClient(opts.registry, true);
  await client.revokeToken(id);
  if (opts.json) return log.json({ revoked: [id] });
  log.success(`Revoked token ${id}`);
}

export async function cmdTokenRevokeAll(opts: GlobalOpts) {
  const { client, token: currentToken } = makeClient(opts.registry, true);
  const { tokens } = await client.listTokens();
  const ordered = [...tokens].sort((left, right) => {
    const leftCurrent = currentToken?.startsWith(left.prefix) ? 1 : 0;
    const rightCurrent = currentToken?.startsWith(right.prefix) ? 1 : 0;
    return leftCurrent - rightCurrent || left.id.localeCompare(right.id);
  });
  const revoked: string[] = [];
  for (const token of ordered) {
    await client.revokeToken(token.id);
    revoked.push(token.id);
  }
  if (opts.json) return log.json({ revoked });
  log.success(`Revoked ${revoked.length} token(s).`);
}

// ---------------- publish ----------------
export async function cmdPublish(
  opts: GlobalOpts & { tag?: string; access?: string; dryRun?: boolean; resume?: boolean },
) {
  const cwd = process.cwd();
  log.step('Packing project…');
  const packed = await packDirectory(cwd);
  const { manifest } = packed;
  log.info(
    `  ${log.bold(`${manifest.name}@${manifest.version}`)}  ${log.dim(
      `${packed.fileCount} files, ${(packed.size / 1024).toFixed(1)} KB, integrity ${packed.integrity.slice(0, 24)}…`,
    )}`,
  );
  if (opts.dryRun) {
    if (opts.json)
      return log.json({
        name: manifest.name,
        version: manifest.version,
        integrity: packed.integrity,
        shasum: packed.shasum,
        size: packed.size,
        files: packed.files,
      });
    log.info('  Files:');
    for (const file of packed.files) log.info(`    ${file}`);
    return log.success('Dry run complete (nothing uploaded).');
  }

  const { client, registry } = makeClient(opts.registry, true);
  let state: PublishState | null = null;
  if (opts.resume) {
    state = loadPublishState();
    if (!state) throw new Error('There is no resumable publish session on this machine.');
    if (
      state.registry !== registry ||
      state.name !== manifest.name ||
      state.version !== manifest.version ||
      state.integrity !== packed.integrity
    ) {
      throw new Error(
        'The saved publish session does not match this package, version, or tarball.',
      );
    }
    if (state.phase === 'awaiting_upload' && Date.parse(state.expiresAt) <= Date.now()) {
      throw new Error('The saved upload session has expired. Publish again without --resume.');
    }
    log.step(`Resuming publish session ${state.idempotencyKey}`);
  } else {
    log.step('Requesting publish intent…');
    const idempotencyKey = randomUUID();
    const intent = await client.createPublishIntent(
      manifest.name,
      {
        manifest,
        integrity: packed.integrity,
        shasum: packed.shasum,
        tarballSize: packed.size,
        unpackedSize: packed.unpackedSize,
        fileCount: packed.fileCount,
        access: (opts.access as 'public' | 'private') ?? manifest.lemonize?.access,
        tag: opts.tag ?? manifest.lemonize?.tag,
      },
      { idempotencyKey },
    );
    state = {
      registry,
      name: manifest.name,
      version: intent.version,
      integrity: packed.integrity,
      idempotencyKey,
      uploadUrl: intent.uploadUrl,
      uploadToken: intent.uploadToken,
      expiresAt: intent.expiresAt,
      phase: 'awaiting_upload',
    };
    savePublishState(state);
  }

  if (!state) throw new Error('Publish session could not be created.');

  if (state.phase === 'awaiting_upload') {
    log.step('Uploading tarball…');
    await client.uploadTarball(state.uploadUrl, state.uploadToken, packed.tarball);
    state = { ...state, phase: 'uploaded' };
    savePublishState(state);
  }

  log.step('Finalizing…');
  const result = await client.finalize(manifest.name, state.version, state.uploadToken);
  clearPublishState();
  if (opts.json) return log.json(result);
  if (result.status === 'published') {
    log.success(`Published ${manifest.name}@${manifest.version} to ${registry}`);
    log.info(log.dim(`Install with:  lem add ${manifest.name}`));
  } else {
    log.success(`Uploaded ${manifest.name}@${manifest.version}; security scan queued.`);
    log.info(log.dim(`It will become installable after the registry reports the scan as clean.`));
  }
}

// ---------------- install / add / remove / update ----------------
function targetSource(name: string, explicit: PackageSource | undefined): PackageSource {
  if (explicit) {
    if (explicit !== 'npm' && explicit !== 'lemonize') {
      throw new Error('--source must be either npm or lemonize.');
    }
    return explicit;
  }
  if (name.startsWith('@')) {
    throw new Error(`Scoped package ${name} is ambiguous. Pass --source npm or --source lemonize.`);
  }
  return 'npm';
}

function migrateV1ProjectDependencies(
  pkg: ReturnType<typeof readProjectPkg>,
  legacyNames: string[],
): boolean {
  let changed = false;
  for (const name of legacyNames) {
    const spec = pkg.dependencies?.[name];
    if (!spec) continue;
    pkg.lemonizeDependencies = pkg.lemonizeDependencies ?? {};
    pkg.lemonizeDependencies[name] = spec;
    delete pkg.dependencies![name];
    changed = true;
  }
  return changed;
}

function projectRequests(
  pkg: ReturnType<typeof readProjectPkg>,
  includeDev: boolean,
): InstallRequest[] {
  const requests: InstallRequest[] = [];
  const add = (
    values: Record<string, string> | undefined,
    source: PackageSource,
    kind: InstallRequest['kind'],
    optional = false,
  ) => {
    for (const [name, spec] of Object.entries(values ?? {})) {
      requests.push({ name, spec, source, kind, optional });
    }
  };
  const optionalNames = new Set(Object.keys(pkg.optionalDependencies ?? {}));
  const productionNames = new Set([...Object.keys(pkg.dependencies ?? {}), ...optionalNames]);
  add(
    Object.fromEntries(
      Object.entries(pkg.dependencies ?? {}).filter(([name]) => !optionalNames.has(name)),
    ),
    'npm',
    'dependencies',
  );
  add(pkg.optionalDependencies, 'npm', 'optionalDependencies', true);
  add(pkg.lemonizeDependencies, 'lemonize', 'lemonizeDependencies');
  if (includeDev) {
    add(
      Object.fromEntries(
        Object.entries(pkg.devDependencies ?? {}).filter(([name]) => !productionNames.has(name)),
      ),
      'npm',
      'devDependencies',
    );
  }
  return requests;
}

function assertFrozenRoots(
  lock: LockfileV2,
  requests: InstallRequest[],
  includeDev: boolean,
): void {
  const kinds: InstallRequest['kind'][] = [
    'dependencies',
    'optionalDependencies',
    'lemonizeDependencies',
    ...(includeDev ? (['devDependencies'] as const) : []),
  ];
  for (const kind of kinds) {
    const expected = requests
      .filter((request) => request.kind === kind)
      .map((request) => request.name)
      .sort();
    const actual = Object.keys(lock.root[kind]).sort();
    if (
      expected.length !== actual.length ||
      expected.some((name, index) => name !== actual[index])
    ) {
      throw new Error(
        `Frozen lockfile root map "${kind}" does not match package.json. Run "lem install" to update it.`,
      );
    }
  }
}

async function cmdInstallV2(
  targets: string[],
  opts: GlobalOpts & {
    save?: boolean;
    source?: PackageSource;
    frozenLockfile?: boolean;
    dev?: boolean;
  },
) {
  const cwd = process.cwd();
  const ctx = makeClient(opts.registry);
  const pkg = readProjectPkg(cwd);
  const diskLock = readLockfile(cwd);
  const frozen = opts.frozenLockfile ?? false;
  let migrated = false;
  if (diskLock?.lockfileVersion === 1 && !frozen) {
    migrated = migrateV1ProjectDependencies(pkg, Object.keys(diskLock.packages));
  }
  const frozenLock = frozen ? requireLockfileV2(diskLock, true) : undefined;

  const targetKinds = new Map<string, { source: PackageSource; kind: InstallRequest['kind'] }>();
  for (const target of targets) {
    const parsed = parseInstallTarget(target);
    const source = targetSource(parsed.name, opts.source);
    const name =
      source === 'npm' ? assertSafePackageName(parsed.name) : assertValidPackageName(parsed.name);
    if (opts.dev && source === 'lemonize') {
      throw new Error('Lemonize development dependencies are not supported; omit --dev.');
    }
    delete pkg.dependencies?.[name];
    delete pkg.optionalDependencies?.[name];
    delete pkg.devDependencies?.[name];
    delete pkg.lemonizeDependencies?.[name];
    const kind: InstallRequest['kind'] =
      source === 'lemonize'
        ? 'lemonizeDependencies'
        : opts.dev
          ? 'devDependencies'
          : 'dependencies';
    const destination =
      kind === 'lemonizeDependencies'
        ? (pkg.lemonizeDependencies = pkg.lemonizeDependencies ?? {})
        : kind === 'devDependencies'
          ? (pkg.devDependencies = pkg.devDependencies ?? {})
          : (pkg.dependencies = pkg.dependencies ?? {});
    destination[name] = parsed.spec;
    targetKinds.set(name, { source, kind });
  }

  const requests = projectRequests(pkg, !!opts.dev);
  if (frozenLock) assertFrozenRoots(frozenLock, requests, !!opts.dev);
  if (requests.length === 0) {
    log.warn('No packages specified and no dependencies found.');
    return;
  }
  for (const request of requests) {
    log.step(
      `Installing ${request.source}:${request.name}${request.spec !== 'latest' ? `@${request.spec}` : ''}`,
    );
  }
  const result = await installRequests(ctx, cwd, requests, {
    frozen,
    lock: frozenLock ?? (diskLock?.lockfileVersion === 2 ? diskLock : undefined),
  });

  for (const installed of result.installed) {
    log.success(
      `${installed.source}:${installed.name}@${installed.version} ${installed.fromCache ? log.dim('(cached)') : ''}${installed.bins.length ? log.dim(`  bin: ${installed.bins.join(', ')}`) : ''}`,
    );
    const target = targetKinds.get(installed.name);
    if (target && target.source === installed.source && opts.save !== false && !frozen) {
      const destination =
        target.kind === 'lemonizeDependencies'
          ? pkg.lemonizeDependencies!
          : target.kind === 'devDependencies'
            ? pkg.devDependencies!
            : pkg.dependencies!;
      destination[installed.name] = `^${installed.version}`;
    }
  }

  if (!frozen) writeLockfile(cwd, result.lock);
  if (!frozen && (migrated || (opts.save !== false && targets.length > 0))) {
    writeProjectPkg(cwd, pkg);
  }
  if (opts.json) return log.json({ installed: result.installed, lockfileVersion: 2 });
  log.success(`Done. ${result.installed.length} root package(s) installed.`);
}

export async function cmdInstall(
  targets: string[],
  opts: GlobalOpts & {
    save?: boolean;
    source?: PackageSource;
    frozenLockfile?: boolean;
    dev?: boolean;
  },
) {
  return cmdInstallV2(targets, opts);
}

export async function cmdRemove(targets: string[], opts: GlobalOpts) {
  const cwd = process.cwd();
  const pkg = readProjectPkg(cwd);
  const registry = resolveRegistry({ registryFlag: opts.registry });
  const diskLock = readLockfile(cwd);
  if (diskLock?.lockfileVersion === 1) {
    migrateV1ProjectDependencies(pkg, Object.keys(diskLock.packages));
  }
  const lock: LockfileV2 =
    diskLock?.lockfileVersion === 2
      ? diskLock
      : diskLock?.lockfileVersion === 1
        ? upgradeLockfile(diskLock)
        : emptyLockfile(registry);
  for (const input of targets) {
    const { name, packageDir, nodeModulesDir } = resolvePackageDirectory(cwd, input);
    let binNames: string[] = [];
    try {
      const installed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
        bin?: string | Record<string, string>;
      };
      binNames =
        typeof installed.bin === 'string'
          ? [name.replace(/^@[^/]+\//, '')]
          : Object.keys(installed.bin ?? {}).filter((bin) => /^[A-Za-z0-9._-]+$/.test(bin));
    } catch {
      // A missing/corrupt installed manifest must not prevent dependency removal.
    }
    delete pkg.dependencies?.[name];
    delete pkg.optionalDependencies?.[name];
    delete pkg.devDependencies?.[name];
    delete pkg.lemonizeDependencies?.[name];
    delete lock.root.dependencies[name];
    delete lock.root.optionalDependencies[name];
    delete lock.root.devDependencies[name];
    delete lock.root.lemonizeDependencies[name];
    rmSync(packageDir, { recursive: true, force: true });
    for (const bin of binNames) {
      rmSync(join(nodeModulesDir, '.bin', bin), { force: true });
      rmSync(join(nodeModulesDir, '.bin', `${bin}.cmd`), { force: true });
    }
    log.success(`Removed ${name}`);
  }
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
  writeProjectPkg(cwd, pkg);
  writeLockfile(cwd, lock);
}

export async function cmdUpdate(
  targets: string[],
  opts: GlobalOpts & { source?: PackageSource; frozenLockfile?: boolean; dev?: boolean },
) {
  if (targets.length === 0) return cmdInstallV2([], opts);
  const pkg = readProjectPkg(process.cwd());
  for (const input of targets) {
    const parsedName = parseInstallTarget(input).name;
    const name = pkg.lemonizeDependencies?.[parsedName]
      ? assertValidPackageName(parsedName)
      : assertSafePackageName(parsedName);
    if (
      !pkg.dependencies?.[name] &&
      !pkg.optionalDependencies?.[name] &&
      !pkg.devDependencies?.[name] &&
      !pkg.lemonizeDependencies?.[name]
    ) {
      throw new Error(`${name} is not declared by this project.`);
    }
  }
  // Resolution is deterministic for the entire project; validating the subset
  // above prevents accidental additions while rebuilding a complete lock graph.
  return cmdInstallV2([], {
    ...opts,
    dev:
      opts.dev ??
      targets.some((target) => {
        const name = parseInstallTarget(target).name;
        return !!pkg.devDependencies?.[name];
      }),
  });
}

// ---------------- exec / lemx ----------------
function findOnPath(names: string[]): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const n of names) {
      const p = join(d, n);
      try {
        if (existsSync(p)) return p;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

/**
 * Resolve a JavaScript runtime to execute a package binary. When `lem` runs as
 * a normal Node process, reuse it. When `lem` is a standalone (SEA) binary,
 * process.execPath is the `lem` binary itself, so we must locate an external
 * Node/Bun on PATH — like npx, running third-party bins needs a JS runtime.
 */
async function resolveJsRuntime(): Promise<string> {
  let isSea = false;
  try {
    const sea = (await import('node:sea')) as { isSea?: () => boolean };
    isSea = typeof sea.isSea === 'function' ? sea.isSea() : false;
  } catch {
    /* node without node:sea */
  }
  if (!isSea) return process.execPath;
  const isWin = process.platform === 'win32';
  const found = findOnPath(isWin ? ['node.exe', 'bun.exe'] : ['node', 'bun']);
  if (found) return found;
  throw new Error(
    'lem exec / lemx needs Node.js or Bun on your PATH to run a package binary. ' +
      'Install Node from https://nodejs.org and try again.',
  );
}
export async function cmdExec(pkgSpec: string, passthrough: string[], opts: GlobalOpts) {
  const cwd = process.cwd();
  const parsed = parseInstallTarget(pkgSpec);
  const name = assertValidPackageName(parsed.name);
  const { spec } = parsed;
  const ctx = makeClient(opts.registry);
  const meta = await ctx.client.getPackage(name);
  if (assertValidPackageName(meta.name) !== name) {
    throw new Error('Registry package name does not match the request.');
  }
  const { resolveVersion } = await import('@lemonize/shared');
  const version = resolveVersion(spec, Object.keys(meta.versions), meta.distTags);
  if (!version) throw new Error(`No version of ${name} satisfies "${spec}".`);
  if (!isValidVersion(version)) throw new Error('Registry returned an invalid package version.');
  const v = meta.versions[version]!;
  const bins = v.bin ?? {};
  const binNames = Object.keys(bins);
  if (binNames.length === 0) throw new Error(`${name}@${version} has no executable bin.`);

  const { LEM_HOME } = await import('./lib/paths.js');
  const execRoot = join(LEM_HOME, 'exec');
  const stageDir = resolveStrictChild(execRoot, `${name.replace(/[/@]/g, '_')}@${version}`);
  if (!existsSync(join(stageDir, 'package.json'))) {
    let data = readCache(v.shasum);
    if (!data) {
      const res = await fetchPackageResource(ctx.registry, v.tarball, ctx.token);
      if (!res.ok) throw new Error(`Download failed (${res.status}).`);
      data = new Uint8Array(await res.arrayBuffer());
      await verifyIntegrity(data, v.integrity);
      writeCache(v.shasum, data);
    } else {
      await verifyIntegrity(data, v.integrity);
    }
    mkdirSync(stageDir, { recursive: true });
    await extractTarball(data, stageDir, { stripPackagePrefix: true });
  }

  const unscoped = name.replace(/^@[^/]+\//, '');
  const chosen = binNames.includes(unscoped) ? unscoped : binNames[0]!;
  const target = join(stageDir, bins[chosen]!);
  const runtime = await resolveJsRuntime();
  log.debug(`exec ${runtime} ${target} ${passthrough.join(' ')}`);
  // No shell — spawn the runtime directly with an args array (no interpolation).
  const child = spawn(runtime, [target, ...passthrough], { stdio: 'inherit', cwd });
  await new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

// ---------------- info / search / list / outdated ----------------
export async function cmdInfo(name: string, opts: GlobalOpts) {
  const { client } = makeClient(opts.registry);
  const meta = await client.getPackage(name);
  if (opts.json) return log.json(meta);
  const latest = meta.latest ?? meta.distTags.latest ?? '(none)';
  log.info(`${log.bold(meta.name)}  ${log.yellow(latest)}`);
  if (meta.description) log.info(sanitizeTerminalText(meta.description));
  log.info('');
  log.info(`versions:  ${Object.keys(meta.versions).join(', ') || '(none)'}`);
  log.info(
    `dist-tags: ${
      Object.entries(meta.distTags)
        .map(([t, v]) => `${t}→${v}`)
        .join(', ') || '(none)'
    }`,
  );
  log.info(`maintainers: ${meta.maintainers.join(', ')}`);
  const lv = meta.latest ? meta.versions[meta.latest] : undefined;
  if (lv) log.info(`integrity: ${lv.integrity}`);
  log.info(log.dim(`\nInstall:  lem add ${meta.name}`));
}

export async function cmdSearch(query: string, opts: GlobalOpts) {
  const { client } = makeClient(opts.registry);
  const { results } = await client.search(query);
  if (opts.json) return log.json(results);
  if (!results.length) return log.info('No packages found.');
  for (const r of results) {
    log.info(`${log.bold(r.name)}  ${log.yellow(r.latest ?? '')}  ${log.dim(`↓${r.downloads}`)}`);
    if (r.description) log.info(`  ${sanitizeTerminalText(r.description)}`);
  }
}

export async function cmdList(opts: GlobalOpts) {
  const cwd = process.cwd();
  const lock = readLockfile(cwd);
  if (!lock || Object.keys(lock.packages).length === 0) return log.info('No packages installed.');
  if (opts.json) return log.json(lock.packages);
  if (lock.lockfileVersion === 1) {
    for (const [name, entry] of Object.entries(lock.packages))
      log.info(`lemonize:${name}@${entry.version}`);
    return;
  }
  for (const entry of Object.values(lock.packages)) {
    log.info(`${entry.source}:${entry.name}@${entry.version}`);
  }
}

export async function cmdOutdated(opts: GlobalOpts) {
  const cwd = process.cwd();
  const ctx = makeClient(opts.registry);
  const lock = readLockfile(cwd);
  if (!lock) return log.info('No lockfile found.');
  const rows: { name: string; current: string; latest: string }[] = [];
  const lemonizeEntries =
    lock.lockfileVersion === 1
      ? Object.entries(lock.packages).map(([name, entry]) => ({ name, entry }))
      : Object.values(lock.packages)
          .filter((entry) => entry.source === 'lemonize')
          .map((entry) => ({ name: entry.name, entry }));
  const seen = new Set<string>();
  for (const { name, entry } of lemonizeEntries) {
    if (seen.has(`${name}@${entry.version}`)) continue;
    seen.add(`${name}@${entry.version}`);
    try {
      const meta = await ctx.client.getPackage(name);
      const latest = meta.latest ?? meta.distTags.latest ?? entry.version;
      if (latest !== entry.version) rows.push({ name, current: entry.version, latest });
    } catch {
      /* skip */
    }
  }
  if (opts.json) return log.json(rows);
  if (!rows.length) return log.success('All packages are up to date.');
  for (const r of rows) log.info(`${log.bold(r.name)}  ${r.current} → ${log.yellow(r.latest)}`);
}

// ---------------- deprecate / unpublish / tag ----------------
export async function cmdDeprecate(target: string, message: string, opts: GlobalOpts) {
  const { registry, token } = makeClient(opts.registry, true);
  const { name, spec } = parseInstallTarget(target);
  const res = await authedPost(
    registry,
    token,
    `/v1/packages/${encodeURIComponent(name)}/deprecate`,
    {
      version: spec,
      message,
    },
  );
  if (opts.json) return log.json(res);
  log.success(`Deprecated ${name}@${spec}`);
}

export async function cmdUnpublish(target: string, opts: GlobalOpts & { force?: boolean }) {
  const { registry, token } = makeClient(opts.registry, true);
  const { name, spec } = parseInstallTarget(target);
  const res = await authedPost(
    registry,
    token,
    `/v1/packages/${encodeURIComponent(name)}/unpublish`,
    {
      version: spec,
      force: !!opts.force,
    },
  );
  if (opts.json) return log.json(res);
  log.success(`Yanked ${name}@${spec}`);
}

export async function cmdTagAdd(target: string, tag: string, opts: GlobalOpts) {
  const { registry, token } = makeClient(opts.registry, true);
  const { name, spec } = parseInstallTarget(target);
  const res = await authedPost(
    registry,
    token,
    `/v1/packages/${encodeURIComponent(name)}/dist-tags`,
    {
      tag,
      version: spec,
    },
  );
  if (opts.json) return log.json(res);
  log.success(`Tagged ${name}@${spec} as ${tag}`);
}

export async function cmdTagRemove(name: string, tag: string, opts: GlobalOpts) {
  const { registry, token } = makeClient(opts.registry, true);
  const res = await authedDelete(
    registry,
    token,
    `/v1/packages/${encodeURIComponent(name)}/dist-tags/${tag}`,
  );
  if (opts.json) return log.json(res);
  log.success(`Removed tag ${tag} from ${name}`);
}

// ---------------- config ----------------
export function cmdConfigGet(key: string, opts: GlobalOpts) {
  const cfg = loadConfig() as Record<string, unknown>;
  const val = cfg[key];
  if (opts.json) return log.json({ [key]: val ?? null });
  log.info(val === undefined ? '(unset)' : String(val));
}

export function cmdConfigSet(key: string, value: string, opts: GlobalOpts) {
  const cfg = loadConfig() as Record<string, unknown>;
  const normalizedValue = key === 'registry' ? validateRegistryUrl(value) : value;
  cfg[key] = normalizedValue;
  saveConfig(cfg as never);
  if (opts.json) return log.json({ [key]: normalizedValue });
  log.success(`Set ${key} = ${normalizedValue}`);
}

export function cmdConfigDelete(key: string, opts: GlobalOpts) {
  const cfg = loadConfig() as Record<string, unknown>;
  delete cfg[key];
  saveConfig(cfg as never);
  if (opts.json) return log.json({ deleted: key });
  log.success(`Deleted ${key}`);
}

export function cmdCacheClean(opts: GlobalOpts) {
  cleanCache();
  if (opts.json) return log.json({ ok: true });
  log.success('Cache cleared.');
}

// ---------------- helpers ----------------
async function authedPost(registry: string, token: string | null, path: string, body: unknown) {
  if (!token) throw new Error(`Not logged in to ${registry}. Run "lem login" first.`);
  const res = await fetchRegistryWithToken(registry, path, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok)
    throw new ApiClientError(
      res.status,
      json,
      json?.error?.message ?? `Request failed (${res.status})`,
    );
  return json;
}

async function authedDelete(registry: string, token: string | null, path: string) {
  if (!token) throw new Error(`Not logged in to ${registry}. Run "lem login" first.`);
  const res = await fetchRegistryWithToken(registry, path, token, {
    method: 'DELETE',
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok)
    throw new ApiClientError(
      res.status,
      json,
      json?.error?.message ?? `Request failed (${res.status})`,
    );
  return json;
}
