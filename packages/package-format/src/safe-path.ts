import { posix, win32 } from 'node:path';

/**
 * Decode only characters that can change path semantics. Tar entry names are
 * not URLs, but rejecting encoded separators and dot segments avoids handing
 * an ambiguous name to a later URL-decoding layer.
 */
function decodePathSyntax(value: string): string {
  return value
    .replace(/%25/gi, '%')
    .replace(/%2e/gi, '.')
    .replace(/%2f/gi, '/')
    .replace(/%5c/gi, '\\')
    .replace(/%3a/gi, ':');
}

function isSafePathForm(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('\\')) return false;
  if (posix.isAbsolute(value) || win32.isAbsolute(value)) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;

  const segments = value.split('/');
  for (const segment of segments) {
    // Reject the raw segment before normalization. In particular,
    // "package/a/../b" must not become an accepted "package/b" entry.
    const unicodeNormalized = segment.normalize('NFKC');
    const windowsNormalized = unicodeNormalized.replace(/[ .]+$/u, '');
    if (
      unicodeNormalized === '..' ||
      /^\.\.[ .]*$/u.test(unicodeNormalized) ||
      windowsNormalized === '..'
    ) {
      return false;
    }
  }

  const normalized = posix.normalize(value);
  return normalized !== '..' && !normalized.startsWith('../');
}

/**
 * Return true when `entryPath` (a tar entry name) is safe to extract under a
 * package root. Rejects absolute paths, "..", drive letters and backslashes.
 */
export function isSafeEntryPath(entryPath: string): boolean {
  const candidates = [entryPath];
  const seen = new Set<string>();

  // Validate the literal name and every security-relevant decoding layer.
  // Each decoded variant is shorter and the set prevents repeated work.
  while (candidates.length) {
    const candidate = candidates.pop()!;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!isSafePathForm(candidate) || !isSafePathForm(candidate.normalize('NFKC'))) return false;

    const syntaxDecoded = decodePathSyntax(candidate);
    if (syntaxDecoded !== candidate) candidates.push(syntaxDecoded);

    try {
      const uriDecoded = decodeURIComponent(candidate);
      if (uriDecoded !== candidate) candidates.push(uriDecoded);
    } catch {
      // A literal or malformed percent sequence has no URL-decoded form. The
      // targeted decoding above still catches encoded dots and separators.
    }
  }

  return seen.size > 0;
}

/** All published entries must live under the conventional "package/" prefix. */
export function isUnderPackageRoot(entryPath: string): boolean {
  return entryPath === 'package' || entryPath.startsWith('package/');
}
