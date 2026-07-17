import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { create, Header } from 'tar';
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
