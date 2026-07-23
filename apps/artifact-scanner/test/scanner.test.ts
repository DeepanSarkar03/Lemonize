import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { handleScanRequest, parseScanJob } from '../src/scanner.js';
import { signRequest, signedHeaders, verifyRequestSignature } from '../src/signing.js';
import { validateGzipTar } from '../src/tar.js';
import type { ScanJob, ScannerConfig, ScannerFetch } from '../src/types.js';

const NOW = new Date('2026-07-17T05:00:00.000Z');
const SECRET = 'test-signing-secret-with-at-least-32-bytes';

interface TarEntry {
  path: string;
  data?: Uint8Array;
  type?: '0' | '5';
}

function writeString(target: Uint8Array, offset: number, length: number, value: string): void {
  target.set(Buffer.from(value).subarray(0, length), offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0') + '\0';
  writeString(target, offset, length, encoded);
}

function tar(entries: TarEntry[]): Uint8Array {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? new Uint8Array());
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, entry.path);
    writeOctal(header, 100, 8, entry.type === '5' ? 0o755 : 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    writeString(header, 257, 6, 'ustar\0');
    writeString(header, 263, 2, '00');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    chunks.push(header, data);
    const padding = (512 - (data.byteLength % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function packageArchive(input: {
  name?: string;
  version?: string;
  main?: string;
  manifestExtra?: Record<string, unknown>;
  extraEntries?: TarEntry[];
} = {}): { archive: Uint8Array; fileCount: number; unpackedSize: number } {
  const manifest = Buffer.from(
    JSON.stringify({
      name: input.name ?? '@demo/pkg',
      version: input.version ?? '1.2.3',
      main: input.main ?? 'index.js',
      files: ['index.js'],
      ...input.manifestExtra,
    }),
  );
  const index = Buffer.from('export const answer = 42;\n');
  const entries: TarEntry[] = [
    { path: 'package/', type: '5' },
    { path: 'package/package.json', data: manifest },
    { path: 'package/index.js', data: index },
    ...(input.extraEntries ?? []),
  ];
  const unpackedSize = entries.reduce(
    (sum, entry) => sum + (entry.type === '5' ? 0 : (entry.data?.byteLength ?? 0)),
    0,
  );
  const fileCount = entries.filter((entry) => entry.type !== '5').length;
  return { archive: gzipSync(tar(entries)), fileCount, unpackedSize };
}

function jobFor(
  archive: Uint8Array,
  fileCount: number,
  unpackedSize: number,
  overrides: Partial<ScanJob> = {},
): ScanJob {
  return {
    schemaVersion: 1,
    jobId: 'job-123',
    versionId: 'version-123',
    packageName: '@demo/pkg',
    version: '1.2.3',
    shasum: createHash('sha256').update(archive).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
    manifestSha256: createHash('sha256')
      .update(
        JSON.stringify({
          files: ['index.js'],
          main: 'index.js',
          name: '@demo/pkg',
          version: '1.2.3',
        }),
      )
      .digest('hex'),
    tarballSize: archive.byteLength,
    fileCount,
    unpackedSize,
    ...overrides,
  };
}

function config(fetcher: ScannerFetch): ScannerConfig {
  return {
    registryInternalUrl: 'https://registry.internal.example',
    signingSecret: SECRET,
    appwriteEndpoint: 'https://fra.cloud.appwrite.io/v1',
    appwriteProjectId: 'lemonize-prod-2026',
    appwriteApiKey: 'appwrite-secret-key',
    quarantineBucketId: 'quarantine',
    maxArchiveBytes: 20 * 1024 * 1024,
    maxPackageFiles: 10_000,
    maxClockSkewSeconds: 300,
    fetch: fetcher,
    now: () => NOW,
  };
}

function signedJobRequest(job: ScanJob): Request {
  const url = 'https://scanner.functions.example/';
  const body = new TextEncoder().encode(JSON.stringify(job));
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...signedHeaders({ secret: SECRET, method: 'POST', url, body, now: NOW }),
    },
    body,
  });
}

describe('request signing', () => {
  it('binds the signature to timestamp, method, target, and body', () => {
    const url = 'https://scanner.example/run?attempt=1';
    const body = new TextEncoder().encode('{"job":1}');
    const timestamp = String(Math.floor(NOW.getTime() / 1000));
    const signature = signRequest(SECRET, 'POST', url, timestamp, body);

    expect(() =>
      verifyRequestSignature({
        secret: SECRET,
        method: 'POST',
        url,
        headers: new Headers({
          'x-lemonize-timestamp': timestamp,
          'x-lemonize-signature': signature,
        }),
        body,
        now: NOW,
        maxClockSkewSeconds: 300,
      }),
    ).not.toThrow();
    expect(() =>
      verifyRequestSignature({
        secret: SECRET,
        method: 'POST',
        url,
        headers: new Headers({
          'x-lemonize-timestamp': String(Number(timestamp) - 301),
          'x-lemonize-signature': signature,
        }),
        body,
        now: NOW,
        maxClockSkewSeconds: 300,
      }),
    ).toThrow('stale_signature');
  });
});

describe('archive validation', () => {
  it('validates a normal package manifest, count, and unpacked size', () => {
    const pkg = packageArchive();
    const job = jobFor(pkg.archive, pkg.fileCount, pkg.unpackedSize);
    expect(validateGzipTar(pkg.archive, job, 100)).toMatchObject({
      fileCount: 2,
      unpackedSize: pkg.unpackedSize,
      manifest: { name: '@demo/pkg', version: '1.2.3' },
    });
  });

  it('accepts one conventional leading current-directory segment', () => {
    const pkg = packageArchive({
      main: './index.js',
    });
    const job = jobFor(pkg.archive, pkg.fileCount, pkg.unpackedSize);
    expect(() => validateGzipTar(pkg.archive, job, 100)).not.toThrow();
  });

  it('rejects traversal paths before extraction or upload', () => {
    const evil = Buffer.from('owned');
    const pkg = packageArchive({
      extraEntries: [{ path: 'package/../outside.js', data: evil }],
    });
    const job = jobFor(pkg.archive, pkg.fileCount, pkg.unpackedSize);
    expect(() => validateGzipTar(pkg.archive, job, 100)).toThrow('unsafe_tar_path');
  });

  it('rejects a manifest whose signed package identity does not match', () => {
    const pkg = packageArchive({ name: '@attacker/pkg' });
    const job = jobFor(pkg.archive, pkg.fileCount, pkg.unpackedSize);
    expect(() => validateGzipTar(pkg.archive, job, 100)).toThrow(
      'manifest_identity_mismatch',
    );
  });

  it('rejects packaged runtime environment files and private keys', () => {
    const environment = packageArchive({
      extraEntries: [{ path: 'package/.env.production', data: Buffer.from('TOKEN=secret') }],
    });
    expect(() =>
      validateGzipTar(
        environment.archive,
        jobFor(environment.archive, environment.fileCount, environment.unpackedSize),
        100,
      ),
    ).toThrow('packaged_environment_file');

    const privateKey = packageArchive({
      extraEntries: [
        {
          path: 'package/fixture.txt',
          data: Buffer.from('-----BEGIN PRIVATE KEY-----\nnot-a-real-key'),
        },
      ],
    });
    expect(() =>
      validateGzipTar(
        privateKey.archive,
        jobFor(privateKey.archive, privateKey.fileCount, privateKey.unpackedSize),
        100,
      ),
    ).toThrow('packaged_private_key');
  });

  it('enforces the hard 100 MiB unpacked limit in signed jobs', () => {
    const pkg = packageArchive();
    const candidate = jobFor(pkg.archive, pkg.fileCount, pkg.unpackedSize, {
      unpackedSize: 100 * 1024 * 1024 + 1,
    });
    expect(() => parseScanJob(candidate, config(vi.fn()))).toThrow('invalid_job');
  });

  it('rejects a depth-3000 manifest without overflowing canonicalization', () => {
    let extension: unknown = 'leaf';
    for (let depth = 0; depth < 3_000; depth += 1) extension = { nested: extension };
    const pkg = packageArchive({ manifestExtra: { customMetadata: extension } });
    const job = jobFor(pkg.archive, pkg.fileCount, pkg.unpackedSize, {
      manifestSha256: '0'.repeat(64),
    });

    expect(() => validateGzipTar(pkg.archive, job, 100)).toThrow('invalid_manifest');
  });
});

describe('artifact scanner function', () => {
  it('fetches with a signature, validates, uploads for Appwrite antivirus, and posts a signed result', async () => {
    const pkg = packageArchive();
    const job = jobFor(pkg.archive, pkg.fileCount, pkg.unpackedSize);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let deliveredResult: unknown;
    const fetcher: ScannerFetch = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/artifact')) {
        verifyRequestSignature({
          secret: SECRET,
          method: 'GET',
          url,
          headers: new Headers(init?.headers),
          body: new Uint8Array(),
          now: NOW,
          maxClockSkewSeconds: 300,
        });
        return new Response(pkg.archive, {
          status: 200,
          headers: { 'content-length': String(pkg.archive.byteLength) },
        });
      }
      if (url.includes('/storage/buckets/quarantine/files')) {
        expect(new Headers(init?.headers).get('x-appwrite-key')).toBe('appwrite-secret-key');
        expect(init?.body).toBeInstanceOf(FormData);
        const fileId = (init?.body as FormData).get('fileId');
        expect(fileId).toBe(`scan-${job.shasum.slice(0, 30)}`);
        return Response.json({ $id: fileId }, { status: 201 });
      }
      if (url.endsWith('/result')) {
        const body = new Uint8Array(init?.body as ArrayBuffer);
        verifyRequestSignature({
          secret: SECRET,
          method: 'POST',
          url,
          headers: new Headers(init?.headers),
          body,
          now: NOW,
          maxClockSkewSeconds: 300,
        });
        deliveredResult = JSON.parse(new TextDecoder().decode(body));
        return new Response(null, { status: 204 });
      }
      throw new Error('unexpected URL');
    };

    const scannerConfig = config(fetcher);
    const adversarialSuffix = '/'.repeat(250_000);
    scannerConfig.registryInternalUrl += adversarialSuffix;
    scannerConfig.appwriteEndpoint += adversarialSuffix;
    const response = await handleScanRequest(signedJobRequest(job), scannerConfig);
    const responseBody = (await response.json()) as { result: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(responseBody.result).toMatchObject({
      status: 'clean',
      code: 'scan_passed',
      shasum: job.shasum,
      manifestSha256: job.manifestSha256,
      fileCount: pkg.fileCount,
    });
    expect(deliveredResult).toEqual(responseBody.result);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/internal/v1/scan-jobs/job-123/artifact',
      '/v1/storage/buckets/quarantine/files',
      '/internal/v1/scan-jobs/job-123/result',
    ]);
  });

  it('posts a signed rejection and never uploads when SHA-256 is wrong', async () => {
    const pkg = packageArchive();
    const valid = jobFor(pkg.archive, pkg.fileCount, pkg.unpackedSize);
    const job = { ...valid, shasum: `${valid.shasum[0] === 'a' ? 'b' : 'a'}${valid.shasum.slice(1)}` };
    const urls: string[] = [];
    let resultStatus = '';
    const fetcher: ScannerFetch = async (url, init) => {
      urls.push(url);
      if (url.endsWith('/artifact')) return new Response(pkg.archive);
      if (url.endsWith('/result')) {
        const parsed = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as {
          status: string;
          code: string;
        };
        resultStatus = `${parsed.status}:${parsed.code}`;
        return new Response(null, { status: 204 });
      }
      throw new Error('quarantine upload must not occur');
    };

    const response = await handleScanRequest(signedJobRequest(job), config(fetcher));

    expect(response.status).toBe(200);
    expect(resultStatus).toBe('rejected:sha256_mismatch');
    expect(urls).toHaveLength(2);
  });

  it('rejects an archive whose complete manifest differs from the declared metadata', async () => {
    const pkg = packageArchive();
    const job = jobFor(pkg.archive, pkg.fileCount, pkg.unpackedSize, {
      manifestSha256: '0'.repeat(64),
    });
    const urls: string[] = [];
    let resultStatus = '';
    const fetcher: ScannerFetch = async (url, init) => {
      urls.push(url);
      if (url.endsWith('/artifact')) return new Response(pkg.archive);
      if (url.endsWith('/result')) {
        const parsed = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as {
          status: string;
          code: string;
        };
        resultStatus = `${parsed.status}:${parsed.code}`;
        return new Response(null, { status: 204 });
      }
      throw new Error('quarantine upload must not occur');
    };

    const response = await handleScanRequest(signedJobRequest(job), config(fetcher));

    expect(response.status).toBe(200);
    expect(resultStatus).toBe('rejected:manifest_mismatch');
    expect(urls).toHaveLength(2);
  });

  it('rejects a tampered job before making any outbound request', async () => {
    const fetcher: ScannerFetch = vi.fn();
    const pkg = packageArchive();
    const job = jobFor(pkg.archive, pkg.fileCount, pkg.unpackedSize);
    const request = signedJobRequest(job);
    const body = JSON.stringify({ ...job, version: '9.9.9' });
    const tampered = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body,
    });

    const response = await handleScanRequest(tampered, config(fetcher));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_signature' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
