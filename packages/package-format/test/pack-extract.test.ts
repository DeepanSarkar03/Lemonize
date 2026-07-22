import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { create, Header, Pax } from 'tar';
import { packDirectory } from '../src/pack.js';
import { extractTarball } from '../src/extract.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'lem-'));
}

async function tarOf(dir: string, files: string[], prefix?: string): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  const stream = create({ cwd: dir, gzip: true, portable: true, prefix }, files);
  await new Promise<void>((res, rej) => {
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => res());
    stream.on('error', rej);
  });
  return new Uint8Array(Buffer.concat(chunks));
}

function rawTarOf(entries: Array<[path: string, content: string]>): Uint8Array {
  const chunks: Buffer[] = [];
  for (const [path, content] of entries) {
    const data = Buffer.from(content);
    const header = new Header({
      path,
      type: 'File',
      mode: 0o644,
      uid: 0,
      gid: 0,
      size: data.length,
      mtime: new Date(0),
    });
    const headerBlock = Buffer.alloc(512);
    if (header.encode(headerBlock)) throw new Error(`Test tar path requires a PAX header: ${path}`);
    chunks.push(headerBlock, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(chunks)));
}

function paxTarOf(path: string, content: string): Uint8Array {
  const data = Buffer.from(content);
  const pax = new Pax({ path, size: data.length, mtime: new Date(0) }).encode();
  const header = new Header({
    path: 'pax-entry',
    type: 'File',
    mode: 0o644,
    uid: 0,
    gid: 0,
    size: data.length,
    mtime: new Date(0),
  });
  const headerBlock = Buffer.alloc(512);
  if (header.encode(headerBlock)) throw new Error('Fallback tar path unexpectedly requires PAX.');
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return new Uint8Array(
    gzipSync(Buffer.concat([pax, headerBlock, data, padding, Buffer.alloc(1024)])),
  );
}

describe('pack + extract round-trip', () => {
  it('packs a project and extracts it safely', async () => {
    const src = tmp();
    writeFileSync(
      join(src, 'package.json'),
      JSON.stringify({ name: 'roundtrip', version: '1.0.0', files: ['index.js'] }),
    );
    writeFileSync(join(src, 'index.js'), 'export const x = 1;\n');
    const packed = await packDirectory(src);
    expect(packed.fileCount).toBeGreaterThanOrEqual(2);
    expect(packed.integrity).toMatch(/^sha512-/);

    const dest = tmp();
    const { files } = await extractTarball(packed.tarball, dest, { stripPackagePrefix: true });
    expect(files).toContain('package.json');
    expect(existsSync(join(dest, 'index.js'))).toBe(true);
    expect(readFileSync(join(dest, 'index.js'), 'utf8')).toContain('export const x');
  });
});

describe('extract rejects malicious / malformed archives', () => {
  it('rejects an archive whose entries are not under the package/ root', async () => {
    const src = tmp();
    writeFileSync(join(src, 'notpackage.json'), '{}');
    const evil = await tarOf(src, ['notpackage.json']);
    await expect(extractTarball(evil, tmp())).rejects.toThrow(/outside the "package\/" root|does not contain/);
  });

  it('rejects an archive with no package/package.json manifest', async () => {
    const src = tmp();
    writeFileSync(join(src, 'index.js'), 'x');
    const noManifest = await tarOf(src, ['index.js'], 'package');
    await expect(extractTarball(noManifest, tmp())).rejects.toThrow(/does not contain package\/package\.json/);
  });

  it('rejects raw, encoded, and backslash traversal entries before writing', async () => {
    const unsafePaths = [
      'package/a/../escape.txt',
      'package/%2e%2e/escape.txt',
      'package/%252e%252e/escape.txt',
      'package\\..\\escape.txt',
    ];

    for (const unsafePath of unsafePaths) {
      const dest = tmp();
      const evil = rawTarOf([
        ['package/package.json', '{}'],
        [unsafePath, 'escaped'],
      ]);
      await expect(extractTarball(evil, dest)).rejects.toThrow(/Unsafe path/);
      expect(existsSync(join(dest, 'package.json'))).toBe(false);
    }
  });

  it('does not confuse a sibling with a destination child', async () => {
    const base = tmp();
    const dest = join(base, 'pkg');
    const siblingEscape = join(base, 'pkg-evil', 'escape.txt');
    const evil = rawTarOf([
      ['package/package.json', '{}'],
      ['package/../pkg-evil/escape.txt', 'escaped'],
    ]);

    await expect(extractTarball(evil, dest)).rejects.toThrow(/Unsafe path/);
    expect(existsSync(siblingEscape)).toBe(false);
  });

  it('refuses to write through a pre-existing symlinked directory', async () => {
    const dest = tmp();
    const outside = tmp();
    symlinkSync(outside, join(dest, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const evil = rawTarOf([
      ['package/package.json', '{}'],
      ['package/linked/escape.txt', 'escaped'],
    ]);

    await expect(extractTarball(evil, dest)).rejects.toThrow(/symlink/);
    expect(existsSync(join(outside, 'escape.txt'))).toBe(false);
  });

  it('handles an excessively deep PAX path without crashing the process', () => {
    // GHSA-r292-9mhp-454m: tar <=7.5.20 could recurse without a bound while
    // filtering an archive entry by filename. Keep the pathological parse in a
    // child process so a regression can fail this test without taking down the
    // Vitest worker itself.
    const work = tmp();
    const archivePath = join(work, 'deep-path.tgz');
    const dest = join(work, 'out');
    const deepPath = `package/${Array.from({ length: 12_000 }, () => 'd').join('/')}/payload.txt`;
    writeFileSync(archivePath, paxTarOf(deepPath, 'payload'));

    const extractorUrl = new URL('../src/extract.ts', import.meta.url).href;
    const childScript = `
      import { readFile } from 'node:fs/promises';
      import { Readable } from 'node:stream';
      import { list } from 'tar';
      import { extractTarball } from ${JSON.stringify(extractorUrl)};

      const tarball = await readFile(process.argv[1]);
      await new Promise((resolve, reject) => {
        const parser = list({ preservePaths: true }, ['package/package.json']);
        parser.once('end', resolve);
        parser.once('error', reject);
        Readable.from(tarball).once('error', reject).pipe(parser);
      });
      console.log('filtered-list-complete');

      try {
        await extractTarball(tarball, process.argv[2]);
        throw new Error('Pathological archive was unexpectedly accepted.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('does not contain package/package.json')) throw error;
      }
      console.log('controlled-extract-rejection');
    `;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--eval', childScript, archivePath, dest],
      {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );

    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('filtered-list-complete');
    expect(child.stdout).toContain('controlled-extract-rejection');
  });
});

describe('pack rejects root escapes and secrets', () => {
  it('rejects a manifest files entry that names a parent path', async () => {
    const base = tmp();
    const src = join(base, 'pkg');
    mkdirSync(src);
    writeFileSync(join(base, 'outside.txt'), 'private');
    writeFileSync(
      join(src, 'package.json'),
      JSON.stringify({ name: 'parent-escape', version: '1.0.0', files: ['../outside.txt'] }),
    );

    await expect(packDirectory(src)).rejects.toThrow(/safe relative package path/);
  });

  it('does not follow a symlinked directory named by the allowlist', async () => {
    const src = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'secret.txt'), 'private');
    writeFileSync(join(src, 'index.js'), 'export {};');
    symlinkSync(outside, join(src, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(
      join(src, 'package.json'),
      JSON.stringify({
        name: 'symlink-escape',
        version: '1.0.0',
        files: ['index.js', 'linked/secret.txt'],
      }),
    );

    const packed = await packDirectory(src);
    expect(packed.files).toContain('index.js');
    expect(packed.files).not.toContain('linked/secret.txt');
  });

  it('does not follow symlinked directories during recursive discovery', async () => {
    const src = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'secret.txt'), 'private');
    writeFileSync(join(src, 'index.js'), 'export {};');
    symlinkSync(outside, join(src, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(
      join(src, 'package.json'),
      JSON.stringify({ name: 'recursive-symlink', version: '1.0.0' }),
    );

    const packed = await packDirectory(src);
    expect(packed.files).toContain('index.js');
    expect(packed.files.some((file) => file.startsWith('linked/'))).toBe(false);
  });

  it('excludes environment files, registry credentials, and private keys', async () => {
    const src = tmp();
    mkdirSync(join(src, '.ssh'));
    const sensitive = [
      '.env',
      '.env.production',
      '.envrc',
      '.npmrc',
      'credentials.json',
      'client_secret_oauth.json',
      'service-account-prod.json',
      'server.key',
      'id_ed25519',
      'private.pem',
      'deploy-private-key.pem',
      '.ssh/custom-private-key',
    ];
    for (const file of sensitive) {
      writeFileSync(
        join(src, file),
        file === 'private.pem' ? '-----BEGIN PRIVATE KEY-----\nsecret\n' : 'secret',
      );
    }
    writeFileSync(join(src, 'index.js'), 'export {};');
    writeFileSync(join(src, 'credential-parser.ts'), 'export const parse = () => {};');
    writeFileSync(join(src, 'public-cert.pem'), '-----BEGIN CERTIFICATE-----\npublic\n');
    writeFileSync(
      join(src, 'package.json'),
      JSON.stringify({
        name: 'sensitive-files',
        version: '1.0.0',
        files: ['index.js', 'credential-parser.ts', 'public-cert.pem', ...sensitive],
      }),
    );

    const packed = await packDirectory(src);
    expect(packed.files).toEqual(
      expect.arrayContaining(['package.json', 'index.js', 'credential-parser.ts', 'public-cert.pem']),
    );
    for (const file of sensitive) expect(packed.files).not.toContain(file);
  });
});
