import semver from 'semver';

export interface VersionLike {
  version: string;
}

/** Resolve a semver range or dist-tag alias against available versions. */
export function resolveVersion(
  spec: string,
  versions: string[],
  distTags: Record<string, string> = {},
): string | null {
  const wanted = (spec ?? '').trim();
  if (!wanted || wanted === 'latest') {
    return distTags.latest ?? maxStable(versions) ?? maxAny(versions);
  }
  // Dist-tag alias (e.g. "beta", "next")
  if (distTags[wanted]) return distTags[wanted]!;
  // Exact version
  if (semver.valid(wanted) && versions.includes(wanted)) return wanted;
  // Range
  if (semver.validRange(wanted)) {
    return semver.maxSatisfying(versions, wanted, { includePrerelease: false }) ?? null;
  }
  return null;
}

export function maxStable(versions: string[]): string | null {
  const stable = versions.filter((v) => semver.valid(v) && !semver.prerelease(v));
  return stable.length ? stable.sort(semver.rcompare)[0]! : null;
}

export function maxAny(versions: string[]): string | null {
  const valid = versions.filter((v) => semver.valid(v));
  return valid.length ? valid.sort(semver.rcompare)[0]! : null;
}

export function isValidVersion(v: string): boolean {
  return semver.valid(v) !== null;
}

export function isGreater(a: string, b: string): boolean {
  return semver.gt(a, b);
}

/**
 * Parse an install target into a package name + version spec.
 *
 * Both separators are accepted:
 *   - `@`  : "react@^18", "@scope/pkg@1.2.3"        (npm-style)
 *   - `/`  : "stape-cli/latest", "@scope/pkg/1.2.3" (Lemonize-style)
 *
 * When no version is given the spec defaults to "latest".
 */
export function parseInstallTarget(input: string): { name: string; spec: string } {
  const trimmed = input.trim();
  const out = (name: string, spec: string) => ({ name, spec: spec || 'latest' });

  if (trimmed.startsWith('@')) {
    // Scoped: the first "/" is the scope boundary and belongs to the name.
    const scopeSlash = trimmed.indexOf('/', 1);
    if (scopeSlash === -1) return out(trimmed, 'latest'); // malformed; treat whole as name

    // Prefer an "@" version separator after the scope boundary...
    const at = trimmed.indexOf('@', scopeSlash + 1);
    if (at !== -1) return out(trimmed.slice(0, at), trimmed.slice(at + 1));

    // ...otherwise a second "/" separates the version.
    const verSlash = trimmed.indexOf('/', scopeSlash + 1);
    if (verSlash !== -1) return out(trimmed.slice(0, verSlash), trimmed.slice(verSlash + 1));

    return out(trimmed, 'latest');
  }

  // Unscoped: whichever of "@" or "/" appears first separates the version.
  const at = trimmed.indexOf('@');
  const slash = trimmed.indexOf('/');
  const seps = [at, slash].filter((i) => i !== -1);
  if (seps.length === 0) return out(trimmed, 'latest');
  const sep = Math.min(...seps);
  return out(trimmed.slice(0, sep), trimmed.slice(sep + 1));
}
