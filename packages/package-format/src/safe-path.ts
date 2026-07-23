import { posix, win32 } from 'node:path';

const MAX_PERCENT_DECODE_LAYERS = 8;

function hexValue(char: string): number {
  const code = char.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

/**
 * Decode only characters that can change path semantics. Tar entry names are
 * not URLs, but rejecting encoded separators and dot segments avoids handing
 * an ambiguous name to a later URL-decoding layer.
 */
function decodePathSyntaxOnce(value: string): string {
  let decoded = '';
  let changed = false;

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%' || index + 2 >= value.length) {
      decoded += value[index];
      continue;
    }

    const high = hexValue(value[index + 1]!);
    const low = hexValue(value[index + 2]!);
    if (high < 0 || low < 0) {
      decoded += value[index];
      continue;
    }

    const byte = high * 16 + low;
    if (byte === 0x25 || byte === 0x2e || byte === 0x2f || byte === 0x5c || byte === 0x3a) {
      decoded += String.fromCharCode(byte);
      index += 2;
      changed = true;
      continue;
    }

    decoded += value[index];
  }

  return changed ? decoded : value;
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
  const isSafeAcrossLayers = (
    decodeOnce: (value: string) => string,
    tolerateMalformedEncoding = false,
  ): boolean => {
    let candidate = entryPath;

    for (let layer = 0; layer <= MAX_PERCENT_DECODE_LAYERS; layer += 1) {
      if (!isSafePathForm(candidate) || !isSafePathForm(candidate.normalize('NFKC'))) {
        return false;
      }

      let decoded: string;
      try {
        decoded = decodeOnce(candidate);
      } catch {
        // A malformed URI escape has no whole-string URI-decoded form. The
        // targeted decoder is checked independently and still catches path
        // syntax hidden alongside malformed escapes.
        return tolerateMalformedEncoding;
      }

      if (decoded === candidate) return true;

      // Deeply nested encodings are ambiguous and can otherwise make this
      // validation quadratic. Reject them rather than accepting an unchecked
      // decoding layer.
      if (layer === MAX_PERCENT_DECODE_LAYERS) return false;
      candidate = decoded;
    }

    return false;
  };

  if (!isSafeAcrossLayers(decodePathSyntaxOnce)) return false;
  if (!isSafeAcrossLayers(decodeURIComponent, true)) return false;

  return true;
}

/** All published entries must live under the conventional "package/" prefix. */
export function isUnderPackageRoot(entryPath: string): boolean {
  return entryPath === 'package' || entryPath.startsWith('package/');
}
