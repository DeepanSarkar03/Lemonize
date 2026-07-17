import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parsePackageName, validatePackageName } from '@lemonize/shared';

function isStrictChild(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function assertValidPackageName(name: string): string {
  if (typeof name !== 'string') throw new Error('Invalid package name from registry metadata.');
  const validation = validatePackageName(name);
  if (!validation.ok || !validation.parsed) {
    throw new Error(`Invalid package name "${name}".`);
  }
  return validation.parsed.full;
}

/** npm names share the path-safety grammar but are not subject to Lemonize's reserved namespaces. */
export function assertSafePackageName(name: string): string {
  if (typeof name !== 'string' || name.length < 1 || name.length > 214 || name !== name.trim()) {
    throw new Error(`Invalid package name "${String(name)}".`);
  }
  const parsed = parsePackageName(name);
  const segment = /^[a-z0-9][a-z0-9._-]*$/;
  if (
    !parsed ||
    parsed.full !== name ||
    !segment.test(parsed.name) ||
    (parsed.scope !== null && !segment.test(parsed.scope))
  ) {
    throw new Error(`Invalid package name "${name}".`);
  }
  return parsed.full;
}

/**
 * Resolve a package directory and prove every existing path component remains
 * beneath node_modules. Symlinked scopes/packages are rejected before a
 * recursive delete or archive extraction can follow them outside the project.
 */
export function resolvePackageDirectory(
  cwd: string,
  inputName: string,
): {
  name: string;
  nodeModulesDir: string;
  packageDir: string;
} {
  const name = assertSafePackageName(inputName);
  const nodeModulesDir = resolve(cwd, 'node_modules');
  const components = name.split('/');
  const packageDir = resolve(nodeModulesDir, ...components);
  if (!isStrictChild(nodeModulesDir, packageDir)) {
    throw new Error('Package directory must be inside node_modules.');
  }

  const resolvedRoot = existsSync(nodeModulesDir) ? realpathSync(nodeModulesDir) : nodeModulesDir;
  let lexicalCursor = nodeModulesDir;
  let resolvedCursor = resolvedRoot;
  for (let index = 0; index < components.length; index += 1) {
    lexicalCursor = join(lexicalCursor, components[index]!);
    if (existsSync(lexicalCursor)) {
      if (lstatSync(lexicalCursor).isSymbolicLink()) {
        throw new Error('Package directory must not traverse a symbolic link.');
      }
      resolvedCursor = realpathSync(lexicalCursor);
      if (!isStrictChild(resolvedRoot, resolvedCursor)) {
        throw new Error('Resolved package directory must be inside node_modules.');
      }
      continue;
    }
    const remaining = components.slice(index);
    const prospective = resolve(resolvedCursor, ...remaining);
    if (!isStrictChild(resolvedRoot, prospective)) {
      throw new Error('Resolved package directory must be inside node_modules.');
    }
    break;
  }

  return { name, nodeModulesDir, packageDir };
}

export function resolveStrictChild(parent: string, child: string): string {
  const root = resolve(parent);
  const candidate = resolve(root, child);
  if (!isStrictChild(root, candidate))
    throw new Error('Resolved path must remain inside its root.');
  return candidate;
}
