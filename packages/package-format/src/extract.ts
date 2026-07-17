import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { list, type ReadEntry } from 'tar';
import { Readable } from 'node:stream';
import { isSafeEntryPath, isUnderPackageRoot } from './safe-path.js';

export interface ExtractOptions {
  /** Strip the leading "package/" directory (npm-style). Default true. */
  stripPackagePrefix?: boolean;
  /** Max number of entries permitted (defense against tar bombs). */
  maxFiles?: number;
}

/**
 * Safely extract a gzipped tarball (in memory) to a destination directory.
 *
 * Security properties:
 *  - Rejects absolute paths, "..", drive letters, backslashes and NUL bytes.
 *  - Rejects symlinks and hardlinks entirely.
 *  - Requires the conventional "package/" root and a package/package.json.
 *  - Never executes any code; lifecycle scripts are ignored by design.
 */
export async function extractTarball(
  tarball: Uint8Array,
  dest: string,
  opts: ExtractOptions = {},
): Promise<{ files: string[] }> {
  const stripPackagePrefix = opts.stripPackagePrefix ?? true;
  const maxFiles = opts.maxFiles ?? 5000;

  // First pass: validate every entry header before writing anything.
  const entries: { path: string; rawPath: string; type: string }[] = [];
  await scan(tarball, (e) => {
    entries.push({ path: e.path, rawPath: e.header.path ?? e.path, type: String(e.type) });
    e.resume();
  });

  if (entries.length > maxFiles) {
    throw new Error(`Refusing to extract: ${entries.length} entries exceeds limit ${maxFiles}.`);
  }
  let sawManifest = false;
  for (const e of entries) {
    if (e.type === 'SymbolicLink' || e.type === 'Link') {
      throw new Error(`Refusing to extract link entry "${e.path}".`);
    }
    if (!isSafeEntryPath(e.rawPath) || !isSafeEntryPath(e.path)) {
      throw new Error(`Unsafe path in tarball: "${e.path}" (possible path traversal).`);
    }
    if (!isUnderPackageRoot(e.path)) {
      throw new Error(`Entry "${e.path}" is outside the "package/" root.`);
    }
    if (e.path === 'package/package.json') sawManifest = true;
  }
  if (!sawManifest) throw new Error('Tarball does not contain package/package.json.');

  // Resolve the requested directory once, then use its canonical location for
  // every containment check. This avoids sibling-prefix bugs such as treating
  // "/tmp/pkg-evil" as if it were inside "/tmp/pkg".
  const requestedRoot = resolve(dest);
  await mkdir(requestedRoot, { recursive: true });
  const destinationRoot = await realpath(requestedRoot);

  // Second pass: write files. Listeners are attached synchronously so no entry
  // data is lost, and scan() awaits every per-entry promise before resolving.
  const written: string[] = [];
  await scan(tarball, (entry) => {
    if (String(entry.type) !== 'File') {
      entry.resume();
      return;
    }
    let rel = entry.path;
    if (stripPackagePrefix) rel = rel.replace(/^package\//, '');
    if (rel === '' || rel === 'package') {
      entry.resume();
      return;
    }
    const outPath = resolveContainedPath(destinationRoot, rel, entry.path);

    const chunks: Buffer[] = [];
    return new Promise<void>((resolve, reject) => {
      entry.on('data', (c: Buffer) => chunks.push(c));
      entry.on('error', reject);
      entry.on('end', () => {
        ensureSafeDirectory(destinationRoot, dirname(outPath), entry.path)
          // Exclusive creation refuses existing files and final-component
          // symlinks instead of following them outside the destination.
          .then(() => writeFile(outPath, Buffer.concat(chunks), { flag: 'wx', mode: 0o644 }))
          .then(() => realpath(outPath))
          .then((resolvedOutput) => {
            assertContained(destinationRoot, resolvedOutput, entry.path);
          })
          .then(() => {
            written.push(rel);
            resolve();
          })
          .catch(reject);
      });
    });
  });

  return { files: written };
}

function assertContained(root: string, candidate: string, entryPath: string): void {
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes destination: ${entryPath}`);
  }
}

function resolveContainedPath(root: string, rel: string, entryPath: string): string {
  const candidate = resolve(root, rel);
  assertContained(root, candidate, entryPath);
  if (candidate === root) throw new Error(`Path resolves to destination root: ${entryPath}`);
  return candidate;
}

async function ensureSafeDirectory(root: string, target: string, entryPath: string): Promise<void> {
  assertContained(root, target, entryPath);
  const rel = relative(root, target);
  let current = root;

  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const st = await lstat(current);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`Refusing to extract through non-directory or symlink: ${entryPath}`);
    }
    assertContained(root, await realpath(current), entryPath);
  }
}

function scan(
  tarball: Uint8Array,
  onEntry: (e: ReadEntry) => void | Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parser = list({ preservePaths: true });
    const pending: Promise<void>[] = [];
    parser.on('entry', (e: ReadEntry) => {
      try {
        const maybe = onEntry(e);
        if (maybe) pending.push(maybe);
      } catch (err) {
        reject(err);
      }
    });
    parser.on('end', () => {
      Promise.all(pending).then(() => resolve(), reject);
    });
    parser.on('error', reject);
    Readable.from(Buffer.from(tarball)).pipe(parser);
  });
}
