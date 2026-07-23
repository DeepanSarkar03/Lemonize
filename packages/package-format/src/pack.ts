import { create } from 'tar';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { computeIntegrity, type TarballIntegrity } from './integrity.js';
import { readManifest } from './manifest.js';
import type { PackageManifest } from '@lemonize/shared';

export interface PackResult extends TarballIntegrity {
  tarball: Uint8Array;
  manifest: PackageManifest;
  files: string[];
  unpackedSize: number;
  fileCount: number;
}

const ALWAYS_INCLUDE = ['package.json', 'README.md', 'readme.md', 'LICENSE', 'license'];
const ALWAYS_IGNORE = new Set(['node_modules', '.git', '.lemonize', 'lemonize-lock.json']);

const SENSITIVE_FILE_NAMES = new Set([
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'auth.json',
  'credentials',
  'credentials.json',
  'secret.json',
  'secrets.json',
]);

const PRIVATE_KEY_EXTENSIONS = new Set(['der', 'json', 'key', 'pem']);

function isNameSeparator(char: string | undefined): boolean {
  return char === '-' || char === '_' || char === '.';
}

function delimitedCompoundEnd(
  value: string,
  start: number,
  first: string,
  second: string,
  allowDotBetweenWords: boolean,
): number | undefined {
  if (!value.startsWith(first, start)) return undefined;

  let cursor = start + first.length;
  if (
    value[cursor] === '-' ||
    value[cursor] === '_' ||
    (allowDotBetweenWords && value[cursor] === '.')
  ) {
    cursor += 1;
  }
  if (!value.startsWith(second, cursor)) return undefined;

  const end = cursor + second.length;
  return end === value.length || isNameSeparator(value[end]) ? end : undefined;
}

function containsDelimitedCompound(value: string, first: string, second: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (index > 0 && !isNameSeparator(value[index - 1])) continue;
    if (delimitedCompoundEnd(value, index, first, second, true) !== undefined) return true;
  }
  return false;
}

function endsWithDelimitedCompound(value: string, first: string, second: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (index > 0 && !isNameSeparator(value[index - 1])) continue;
    if (delimitedCompoundEnd(value, index, first, second, true) === value.length) return true;
  }
  return false;
}

function hasPrivateKeyFileName(name: string): boolean {
  const extensionSeparator = name.lastIndexOf('.');
  if (extensionSeparator <= 0) return false;

  const extension = name.slice(extensionSeparator + 1);
  if (!PRIVATE_KEY_EXTENSIONS.has(extension)) return false;

  return containsDelimitedCompound(name.slice(0, extensionSeparator), 'private', 'key');
}

function hasJsonCredentialFileName(name: string): boolean {
  if (!name.endsWith('.json')) return false;
  const stem = name.slice(0, -'.json'.length);

  return (
    delimitedCompoundEnd(stem, 0, 'client', 'secret', false) !== undefined ||
    delimitedCompoundEnd(stem, 0, 'service', 'account', false) !== undefined
  );
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function hasSymlinkComponent(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  let current = root;
  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function hasPrivateKeyHeader(abs: string): boolean {
  const content = readFileSync(abs, 'utf8');
  return /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(content);
}

function isSensitivePath(rel: string, abs?: string): boolean {
  const parts = rel.replaceAll('\\', '/').split('/');
  const lowerParts = parts.map((part) => part.toLowerCase());
  const name = lowerParts.at(-1) ?? '';

  if (lowerParts.some((part) => part.startsWith('.env') || part === '.ssh')) return true;
  if (SENSITIVE_FILE_NAMES.has(name)) return true;
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(name)) return true;
  if (/\.(?:key|p12|pfx|jks|keystore)$/.test(name)) return true;
  if (endsWithDelimitedCompound(name, 'private', 'key') || hasPrivateKeyFileName(name)) {
    return true;
  }
  if (hasJsonCredentialFileName(name)) return true;
  if (/^(?:.*[-_.])?credentials?(?:\.(?:ini|json|ya?ml))?$/.test(name)) return true;
  if (abs && name.endsWith('.pem') && hasPrivateKeyHeader(abs)) return true;
  return false;
}

function validateManifestPattern(root: string, pattern: string): string {
  const portable = pattern.replaceAll('\\', '/');
  if (
    !pattern ||
    pattern.includes('\0') ||
    posix.isAbsolute(portable) ||
    win32.isAbsolute(pattern) ||
    portable.split('/').some((part) => part === '..')
  ) {
    throw new Error(`Cannot pack path outside package root: "${pattern}".`);
  }
  const abs = resolve(root, pattern);
  if (!isContained(root, abs)) {
    throw new Error(`Cannot pack path outside package root: "${pattern}".`);
  }
  return abs;
}

/** Resolve the set of files to include using the manifest "files" allowlist. */
function collectFiles(dir: string, manifest: PackageManifest): string[] {
  const root = resolve(dir);
  const realRoot = realpathSync(root);
  const included = new Set<string>();
  const add = (rel: string) => included.add(rel.split(sep).join('/'));

  const inspect = (abs: string): ReturnType<typeof lstatSync> | undefined => {
    if (!isContained(root, abs)) throw new Error(`Cannot pack path outside package root: "${abs}".`);
    try {
      if (hasSymlinkComponent(root, abs)) return undefined;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) return undefined;
      if (!isContained(realRoot, realpathSync(abs))) {
        throw new Error(`Cannot pack path outside package root: "${abs}".`);
      }
      return st;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };

  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      if (ALWAYS_IGNORE.has(name)) continue;
      const full = join(abs, name);
      const rel = relative(root, full);
      if (isSensitivePath(rel)) continue;
      const st = inspect(full);
      if (!st) continue;
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && !isSensitivePath(rel, full)) add(rel);
    }
  };

  if (manifest.files && manifest.files.length) {
    for (const pattern of manifest.files) {
      const abs = validateManifestPattern(root, pattern);
      const rel = relative(root, abs);
      if (isSensitivePath(rel)) continue;
      const st = inspect(abs);
      if (!st) continue;
      if (st.isDirectory()) walk(abs);
      else if (st.isFile() && !isSensitivePath(rel, abs)) add(rel);
    }
    for (const f of ALWAYS_INCLUDE) {
      const abs = join(root, f);
      const st = inspect(abs);
      if (st?.isFile() && !isSensitivePath(f, abs)) add(f);
    }
  } else {
    walk(root);
  }
  return [...included].sort();
}

export async function packDirectory(dir: string): Promise<PackResult> {
  const root = resolve(dir);
  const res = await readManifest(dir);
  if (!res.ok || !res.manifest) {
    throw new Error(`Cannot pack: ${res.errors.join('; ')}`);
  }
  const manifest = res.manifest;
  const files = collectFiles(root, manifest);
  if (!files.includes('package.json')) {
    throw new Error('Cannot pack: package.json must be a regular file inside the package root.');
  }

  let unpackedSize = 0;
  for (const f of files) {
    unpackedSize += lstatSync(join(root, f)).size;
  }

  // Emit entries under the conventional "package/" prefix.
  const chunks: Buffer[] = [];
  const stream = create(
    {
      cwd: root,
      gzip: { level: 9 },
      portable: true,
      follow: false,
      prefix: 'package',
    },
    files,
  );
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  const tarball = new Uint8Array(Buffer.concat(chunks));
  const integ = await computeIntegrity(tarball);
  return { tarball, manifest, files, unpackedSize, fileCount: files.length, ...integ };
}

export { readFile };
