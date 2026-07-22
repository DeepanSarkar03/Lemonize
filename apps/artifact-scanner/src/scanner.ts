import { createHash, timingSafeEqual } from 'node:crypto';
import { loadConfig } from './config.js';
import { ScannerError } from './errors.js';
import { canonicalManifestJson, ManifestJsonError } from './manifest-json.js';
import { signedHeaders, verifyRequestSignature } from './signing.js';
import { HARD_MAX_UNPACKED_BYTES, validateGzipTar } from './tar.js';
import type { ScanJob, ScannerConfig, ScanResult } from './types.js';

const EMPTY_BODY = new Uint8Array();
const MAX_JOB_BODY_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;
const SHA256 = /^[a-f0-9]{64}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function safeEqualAscii(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'ascii');
  const rightBytes = Buffer.from(right, 'ascii');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validIntegrity(value: string): boolean {
  if (!value.startsWith('sha512-')) return false;
  const encoded = value.slice('sha512-'.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.byteLength === 64 && decoded.toString('base64') === encoded;
}

function manifestSha256(manifest: Record<string, unknown>): string {
  try {
    return createHash('sha256').update(canonicalManifestJson(manifest)).digest('hex');
  } catch (error) {
    if (error instanceof ManifestJsonError) {
      throw new ScannerError('rejected', 'invalid_manifest', 422);
    }
    throw error;
  }
}

export function parseScanJob(value: unknown, config: ScannerConfig): ScanJob {
  if (!isRecord(value)) throw new ScannerError('bad_request', 'invalid_job', 400);
  const job = value as Partial<Record<keyof ScanJob, unknown>>;
  if (
    job.schemaVersion !== 1 ||
    typeof job.jobId !== 'string' ||
    !ID.test(job.jobId) ||
    typeof job.versionId !== 'string' ||
    !ID.test(job.versionId) ||
    typeof job.packageName !== 'string' ||
    job.packageName.length < 1 ||
    job.packageName.length > 214 ||
    hasControlCharacters(job.packageName) ||
    typeof job.version !== 'string' ||
    job.version.length < 1 ||
    job.version.length > 64 ||
    hasControlCharacters(job.version) ||
    typeof job.shasum !== 'string' ||
    !SHA256.test(job.shasum) ||
    typeof job.integrity !== 'string' ||
    !validIntegrity(job.integrity) ||
    typeof job.manifestSha256 !== 'string' ||
    !SHA256.test(job.manifestSha256) ||
    !Number.isSafeInteger(job.tarballSize) ||
    (job.tarballSize as number) < 1 ||
    (job.tarballSize as number) > config.maxArchiveBytes ||
    !Number.isSafeInteger(job.fileCount) ||
    (job.fileCount as number) < 1 ||
    (job.fileCount as number) > config.maxPackageFiles ||
    !Number.isSafeInteger(job.unpackedSize) ||
    (job.unpackedSize as number) < 1 ||
    (job.unpackedSize as number) > HARD_MAX_UNPACKED_BYTES
  ) {
    throw new ScannerError('bad_request', 'invalid_job', 400);
  }
  return value as unknown as ScanJob;
}

function registryJobUrl(config: ScannerConfig, jobId: string, resource: 'artifact' | 'result'): string {
  const base = `${config.registryInternalUrl.replace(/\/+$/, '')}/`;
  return new URL(
    `internal/v1/scan-jobs/${encodeURIComponent(jobId)}/${resource}`,
    base,
  ).toString();
}

async function readLimitedResponse(response: Response, limit: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > limit) {
      throw new ScannerError('rejected', 'archive_size_exceeded', 422);
    }
  }
  if (!response.body) return EMPTY_BODY;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ScannerError('rejected', 'archive_size_exceeded', 422);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks, size));
}

async function fetchArtifact(job: ScanJob, config: ScannerConfig): Promise<Uint8Array> {
  const url = registryJobUrl(config, job.jobId, 'artifact');
  let response: Response;
  try {
    response = await config.fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/gzip, application/octet-stream',
        ...signedHeaders({
          secret: config.signingSecret,
          method: 'GET',
          url,
          body: EMPTY_BODY,
          now: config.now(),
        }),
      },
    });
  } catch {
    throw new ScannerError('operational', 'artifact_fetch_failed', 502);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ScannerError('operational', 'artifact_fetch_failed', 502);
  }
  let archive: Uint8Array;
  try {
    archive = await readLimitedResponse(response, config.maxArchiveBytes);
  } catch (error) {
    if (error instanceof ScannerError) throw error;
    throw new ScannerError('operational', 'artifact_fetch_failed', 502);
  }
  if (archive.byteLength !== job.tarballSize) {
    throw new ScannerError('rejected', 'tarball_size_mismatch', 422);
  }
  return archive;
}

function verifyDigests(archive: Uint8Array, job: ScanJob): { shasum: string; integrity: string } {
  const shasum = createHash('sha256').update(archive).digest('hex');
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  if (!safeEqualAscii(shasum, job.shasum.toLowerCase())) {
    throw new ScannerError('rejected', 'sha256_mismatch', 422);
  }
  if (!safeEqualAscii(integrity, job.integrity)) {
    throw new ScannerError('rejected', 'sha512_mismatch', 422);
  }
  return { shasum, integrity };
}

function appwriteBase(config: ScannerConfig): string {
  const endpoint = config.appwriteEndpoint.replace(/\/+$/, '');
  return endpoint.endsWith('/v1') ? endpoint : `${endpoint}/v1`;
}

function appwriteHeaders(config: ScannerConfig): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-Appwrite-Project': config.appwriteProjectId,
    'X-Appwrite-Key': config.appwriteApiKey,
  };
}

async function uploadToQuarantine(
  archive: Uint8Array,
  job: ScanJob,
  config: ScannerConfig,
): Promise<string> {
  // The file ID is content-addressed, making retries safe without accepting an
  // arbitrary ID from the signed event.
  const fileId = `scan-${job.shasum.toLowerCase().slice(0, 30)}`;
  const bucket = encodeURIComponent(config.quarantineBucketId);
  const collectionUrl = `${appwriteBase(config)}/storage/buckets/${bucket}/files`;
  const form = new FormData();
  const fileBytes = new ArrayBuffer(archive.byteLength);
  new Uint8Array(fileBytes).set(archive);
  form.set('fileId', fileId);
  form.set(
    'file',
    new Blob([fileBytes], { type: 'application/gzip' }),
    `${fileId}.tgz`,
  );

  let response: Response;
  try {
    response = await config.fetch(collectionUrl, {
      method: 'POST',
      headers: appwriteHeaders(config),
      body: form,
    });
  } catch {
    throw new ScannerError('operational', 'quarantine_upload_failed', 502);
  }

  if (response.status === 409) {
    const existingUrl = `${collectionUrl}/${encodeURIComponent(fileId)}`;
    try {
      const existing = await config.fetch(existingUrl, {
        method: 'GET',
        headers: appwriteHeaders(config),
      });
      if (existing.ok) return fileId;
    } catch {
      // Converted to the same safe operational error below.
    }
    throw new ScannerError('operational', 'quarantine_upload_failed', 502);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new ScannerError('rejected', 'quarantine_rejected', 422);
    }
    throw new ScannerError('operational', 'quarantine_upload_failed', 502);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ScannerError('operational', 'quarantine_upload_failed', 502);
  }
  if (!isRecord(parsed) || parsed.$id !== fileId) {
    throw new ScannerError('operational', 'quarantine_upload_failed', 502);
  }
  return fileId;
}

export async function executeScan(job: ScanJob, config: ScannerConfig): Promise<ScanResult> {
  const scannedAt = config.now().toISOString();
  try {
    const archive = await fetchArtifact(job, config);
    const digests = verifyDigests(archive, job);
    const validation = validateGzipTar(archive, job, config.maxPackageFiles);
    const scannedManifestSha256 = manifestSha256(validation.manifest);
    if (!safeEqualAscii(scannedManifestSha256, job.manifestSha256.toLowerCase())) {
      throw new ScannerError('rejected', 'manifest_mismatch', 422);
    }
    const quarantineFileId = await uploadToQuarantine(archive, job, config);
    return {
      schemaVersion: 1,
      jobId: job.jobId,
      versionId: job.versionId,
      status: 'clean',
      code: 'scan_passed',
      scannedAt,
      ...digests,
      manifestSha256: scannedManifestSha256,
      fileCount: validation.fileCount,
      unpackedSize: validation.unpackedSize,
      quarantineFileId,
    };
  } catch (error) {
    const scannerError =
      error instanceof ScannerError
        ? error
        : new ScannerError('operational', 'scanner_failure', 500);
    return {
      schemaVersion: 1,
      jobId: job.jobId,
      versionId: job.versionId,
      status: scannerError.kind === 'rejected' ? 'rejected' : 'error',
      code: scannerError.code,
      scannedAt,
    };
  }
}

async function postResult(result: ScanResult, config: ScannerConfig): Promise<void> {
  const url = registryJobUrl(config, result.jobId, 'result');
  const body = new TextEncoder().encode(JSON.stringify(result));
  let response: Response;
  try {
    response = await config.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...signedHeaders({
          secret: config.signingSecret,
          method: 'POST',
          url,
          body,
          now: config.now(),
        }),
      },
      body,
    });
  } catch {
    throw new ScannerError('operational', 'result_delivery_failed', 502);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ScannerError('operational', 'result_delivery_failed', 502);
  }
}

async function readLimitedRequest(request: Request, limit: number): Promise<Uint8Array> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > limit) {
      throw new ScannerError('bad_request', 'job_too_large', 413);
    }
  }
  if (!request.body) return EMPTY_BODY;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ScannerError('bad_request', 'job_too_large', 413);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks, size));
}

function jsonResponse(status: number, code: string, result?: ScanResult): Response {
  return Response.json(
    result ? { ok: true, result } : { ok: false, error: { code } },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      },
    },
  );
}

export async function handleScanRequest(
  request: Request,
  suppliedConfig?: ScannerConfig,
): Promise<Response> {
  let config: ScannerConfig;
  try {
    config = suppliedConfig ?? loadConfig();
  } catch {
    return jsonResponse(500, 'scanner_misconfigured');
  }
  if (request.method.toUpperCase() !== 'POST') return jsonResponse(405, 'method_not_allowed');

  try {
    const body = await readLimitedRequest(request, MAX_JOB_BODY_BYTES);
    verifyRequestSignature({
      secret: config.signingSecret,
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
      now: config.now(),
      maxClockSkewSeconds: config.maxClockSkewSeconds,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch {
      throw new ScannerError('bad_request', 'invalid_job_json', 400);
    }
    const job = parseScanJob(parsed, config);
    const result = await executeScan(job, config);
    await postResult(result, config);
    return jsonResponse(200, 'ok', result);
  } catch (error) {
    const scannerError =
      error instanceof ScannerError
        ? error
        : new ScannerError('operational', 'scanner_failure', 500);
    return jsonResponse(scannerError.httpStatus, scannerError.code);
  }
}
