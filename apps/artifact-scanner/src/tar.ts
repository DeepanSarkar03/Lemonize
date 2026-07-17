import { gunzipSync } from 'node:zlib';
import { ScannerError } from './errors.js';
import type { ArchiveValidation, ScanJob } from './types.js';

export const HARD_MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
const TAR_BLOCK_SIZE = 512;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_EXTENSION_BYTES = 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const PRIVATE_KEY_MARKERS = [
  '-----BEGIN PRIVATE KEY-----',
  '-----BEGIN ENCRYPTED PRIVATE KEY-----',
  '-----BEGIN RSA PRIVATE KEY-----',
  '-----BEGIN EC PRIVATE KEY-----',
  '-----BEGIN DSA PRIVATE KEY-----',
  '-----BEGIN OPENSSH PRIVATE KEY-----',
].map((value) => Buffer.from(value, 'ascii'));

function reject(code: string): never {
  throw new ScannerError('rejected', code, 422);
}

function decodeText(bytes: Uint8Array, code: string): string {
  const end = bytes.indexOf(0);
  const value = end < 0 ? bytes : bytes.subarray(0, end);
  try {
    return utf8.decode(value);
  } catch {
    return reject(code);
  }
}

function parseOctal(bytes: Uint8Array, code: string): number {
  if ((bytes[0] ?? 0) >= 0x80) return reject(code); // Base-256 values are intentionally unsupported.
  const text = Buffer.from(bytes).toString('ascii').replace(/\0.*$/s, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) return reject(code);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) return reject(code);
  return value;
}

function allZero(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte !== 0) return false;
  return true;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function verifyHeaderChecksum(header: Uint8Array): void {
  const recorded = parseOctal(header.subarray(148, 156), 'invalid_tar_checksum');
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < header.length; index += 1) {
    const raw = index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
    unsigned += raw;
    signed += raw > 127 ? raw - 256 : raw;
  }
  if (recorded !== unsigned && recorded !== signed) reject('invalid_tar_checksum');
}

function headerPath(header: Uint8Array): string {
  const name = decodeText(header.subarray(0, 100), 'invalid_tar_path_encoding');
  const prefix = decodeText(header.subarray(345, 500), 'invalid_tar_path_encoding');
  return prefix ? `${prefix}/${name}` : name;
}

function validateArchivePath(rawPath: string): string {
  if (
    rawPath.length === 0 ||
    Buffer.byteLength(rawPath, 'utf8') > 1_024 ||
    rawPath.includes('\\') ||
    rawPath.startsWith('/') ||
    /^[A-Za-z]:/.test(rawPath) ||
    hasControlCharacters(rawPath)
  ) {
    return reject('unsafe_tar_path');
  }

  const withoutTrailingSlash = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const segments = withoutTrailingSlash.split('/');
  if (
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':') ||
        segment.endsWith('.') ||
        segment.endsWith(' '),
    )
  ) {
    return reject('unsafe_tar_path');
  }

  const root = segments[0];
  if (root !== 'package') return reject('invalid_tar_root');
  return withoutTrailingSlash;
}

function validateNoPackagedSecrets(path: string, data: Uint8Array): void {
  const relative = path.slice('package/'.length).toLowerCase();
  const basename = relative.slice(relative.lastIndexOf('/') + 1);
  if (basename === '.env' || (basename.startsWith('.env.') && basename !== '.env.example')) {
    reject('packaged_environment_file');
  }
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (PRIVATE_KEY_MARKERS.some((marker) => bytes.includes(marker))) {
    reject('packaged_private_key');
  }
}

function parsePax(data: Uint8Array): string | undefined {
  if (data.byteLength > MAX_EXTENSION_BYTES) return reject('tar_extension_too_large');
  let offset = 0;
  let path: string | undefined;
  while (offset < data.byteLength) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) return reject('invalid_pax_header');
    const lengthText = Buffer.from(data.subarray(offset, space)).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(lengthText)) return reject('invalid_pax_header');
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > data.byteLength || data[end - 1] !== 0x0a) {
      return reject('invalid_pax_header');
    }
    const record = data.subarray(space + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals < 1) return reject('invalid_pax_header');
    const key = Buffer.from(record.subarray(0, equals)).toString('ascii');
    let value: string;
    try {
      value = utf8.decode(record.subarray(equals + 1));
    } catch {
      return reject('invalid_pax_header');
    }
    if (key === 'path') path = value;
    if (key === 'linkpath' || key === 'size') return reject('unsupported_pax_override');
    offset = end;
  }
  return path;
}

function validateRelativeManifestPath(value: unknown): void {
  const withoutCurrentDirectory =
    typeof value === 'string' && value.startsWith('./') ? value.slice(2) : value;
  const segments =
    typeof withoutCurrentDirectory === 'string'
      ? withoutCurrentDirectory.replace(/\/$/, '').split('/')
      : [];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(withoutCurrentDirectory as string) ||
    hasControlCharacters(value) ||
    segments.some(
      (part) =>
        part === '' ||
        part === '.' ||
        part === '..' ||
        part.includes(':') ||
        part.endsWith('.') ||
        part.endsWith(' '),
    )
  ) {
    reject('invalid_manifest_path');
  }
}

function validateManifest(data: Uint8Array, job: ScanJob): Record<string, unknown> {
  if (data.byteLength === 0 || data.byteLength > MAX_MANIFEST_BYTES) {
    return reject('invalid_manifest_size');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(data));
  } catch {
    return reject('invalid_manifest_json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return reject('invalid_manifest');
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest.name !== job.packageName || manifest.version !== job.version) {
    return reject('manifest_identity_mismatch');
  }

  if (manifest.files !== undefined) {
    if (!Array.isArray(manifest.files) || manifest.files.length > 10_000) {
      return reject('invalid_manifest_files');
    }
    for (const path of manifest.files) validateRelativeManifestPath(path);
  }
  for (const key of ['main', 'module', 'types', 'typings'] as const) {
    if (manifest[key] !== undefined) validateRelativeManifestPath(manifest[key]);
  }
  if (manifest.bin !== undefined) {
    if (typeof manifest.bin === 'string') {
      validateRelativeManifestPath(manifest.bin);
    } else if (
      typeof manifest.bin === 'object' &&
      manifest.bin !== null &&
      !Array.isArray(manifest.bin)
    ) {
      for (const value of Object.values(manifest.bin as Record<string, unknown>)) {
        validateRelativeManifestPath(value);
      }
    } else {
      return reject('invalid_manifest_bin');
    }
  }
  return manifest;
}

/**
 * Validates and inspects a gzip-compressed npm-style tar archive. Only regular
 * files and directories are accepted; links and special files are rejected so
 * extraction can never redirect writes outside the package root.
 */
export function validateGzipTar(
  archive: Uint8Array,
  job: ScanJob,
  maxPackageFiles: number,
): ArchiveValidation {
  const metadataAllowance = Math.min(
    32 * 1024 * 1024,
    Math.max(8 * 1024 * 1024, maxPackageFiles * 2_048),
  );
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, {
      maxOutputLength: HARD_MAX_UNPACKED_BYTES + metadataAllowance,
    });
  } catch {
    return reject('invalid_or_oversized_gzip');
  }

  let offset = 0;
  let zeroBlocks = 0;
  let ended = false;
  let pendingPath: string | undefined;
  let fileCount = 0;
  let entryCount = 0;
  let unpackedSize = 0;
  let manifest: Record<string, unknown> | undefined;
  const exactPaths = new Set<string>();
  const foldedPaths = new Set<string>();

  while (offset + TAR_BLOCK_SIZE <= tar.byteLength) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;
    if (allZero(header)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) {
        if (!allZero(tar.subarray(offset))) return reject('data_after_tar_end');
        ended = true;
        break;
      }
      continue;
    }
    if (zeroBlocks !== 0) return reject('invalid_tar_terminator');

    verifyHeaderChecksum(header);
    const size = parseOctal(header.subarray(124, 136), 'invalid_tar_size');
    const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (!Number.isSafeInteger(paddedSize) || offset + paddedSize > tar.byteLength) {
      return reject('truncated_tar_entry');
    }
    const data = tar.subarray(offset, offset + size);
    if (!allZero(tar.subarray(offset + size, offset + paddedSize))) {
      return reject('invalid_tar_padding');
    }
    offset += paddedSize;

    const typeByte = header[156] ?? 0;
    const type = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
    if (type === 'x') {
      if (pendingPath !== undefined) return reject('stacked_tar_extensions');
      pendingPath = parsePax(data);
      continue;
    }
    if (type === 'L') {
      if (pendingPath !== undefined || data.byteLength > MAX_EXTENSION_BYTES) {
        return reject('invalid_gnu_long_path');
      }
      pendingPath = decodeText(data, 'invalid_gnu_long_path').replace(/\n$/, '');
      continue;
    }
    if (type === 'g' || type === 'K') return reject('unsupported_tar_extension');

    const path = validateArchivePath(pendingPath ?? headerPath(header));
    pendingPath = undefined;
    entryCount += 1;
    if (entryCount > maxPackageFiles * 4 + 1_024) return reject('too_many_tar_entries');

    const folded = path.toLocaleLowerCase('en-US');
    if (exactPaths.has(path) || foldedPaths.has(folded)) return reject('duplicate_tar_path');
    exactPaths.add(path);
    foldedPaths.add(folded);

    if (type === '5') {
      if (size !== 0) return reject('invalid_directory_entry');
      continue;
    }
    if (type !== '0') return reject('unsupported_tar_entry_type');

    validateNoPackagedSecrets(path, data);

    fileCount += 1;
    if (fileCount > maxPackageFiles || fileCount > job.fileCount) {
      return reject('file_count_exceeded');
    }
    unpackedSize += size;
    if (
      !Number.isSafeInteger(unpackedSize) ||
      unpackedSize > HARD_MAX_UNPACKED_BYTES ||
      unpackedSize > job.unpackedSize
    ) {
      return reject('unpacked_size_exceeded');
    }

    if (path === 'package/package.json') {
      if (manifest !== undefined) return reject('duplicate_manifest');
      manifest = validateManifest(data, job);
    }
  }

  if (!ended || pendingPath !== undefined) return reject('unterminated_tar');
  if (!manifest) return reject('missing_manifest');
  if (fileCount !== job.fileCount) return reject('file_count_mismatch');
  if (unpackedSize !== job.unpackedSize) return reject('unpacked_size_mismatch');
  return { fileCount, unpackedSize, manifest };
}
