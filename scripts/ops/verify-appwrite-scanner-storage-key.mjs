import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;
const ENVIRONMENTS = new Set(['staging', 'production']);
const PINNED_APPWRITE_ENDPOINT = 'https://fra.cloud.appwrite.io/v1';
const RESPONSE_FORMAT = '1.9.5';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_CANARY_BYTES = 256;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_KEY_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;
const ATTESTATION_FIELDS = [
  'createdAt',
  'environment',
  'expiresAt',
  'keyId',
  'projectId',
  'reviewer',
  'scopes',
];
const EXACT_SCOPES = ['files.read', 'files.write'];

function requireId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid Appwrite ID`);
  }
  return value;
}

function requireSecret(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requireEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('APPWRITE_ENDPOINT must be a valid URL');
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  ) {
    throw new Error('APPWRITE_ENDPOINT must be an HTTPS URL without credentials or parameters');
  }
  const normalized = endpoint.href.replace(/\/+$/, '');
  if (normalized !== PINNED_APPWRITE_ENDPOINT || value.replace(/\/+$/, '') !== normalized) {
    throw new Error('APPWRITE_ENDPOINT must match the pinned Lemonize Appwrite endpoint');
  }
  return normalized;
}

function requireTime(value, label) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    throw new Error(`Scanner key attestation ${label} must be an RFC 3339 UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Scanner key attestation ${label} is invalid`);
  }
  return milliseconds;
}

function requireNow(value) {
  if (value === undefined) return new Date();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('Scanner key attestation time is invalid');
  }
  return value;
}

function requestTimeout(value) {
  if (value === undefined) return REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > REQUEST_TIMEOUT_MS) {
    throw new Error('Appwrite storage canary timeout is invalid');
  }
  return value;
}

export function verifyScannerKeyAttestation({
  attestationJson,
  environment,
  projectId,
  keyId,
  now,
}) {
  if (typeof attestationJson !== 'string' || attestationJson.length === 0) {
    throw new Error('APPWRITE_SCANNER_API_KEY_ATTESTATION_JSON is required');
  }
  if (Buffer.byteLength(attestationJson) > MAX_RESPONSE_BYTES) {
    throw new Error('Scanner key attestation is too large');
  }
  if (!ENVIRONMENTS.has(environment)) {
    throw new Error('DEPLOY_ENV must be staging or production');
  }
  requireId(projectId, 'APPWRITE_PROJECT_ID');
  requireId(keyId, 'APPWRITE_SCANNER_API_KEY_ID');

  let attestation;
  try {
    attestation = JSON.parse(attestationJson);
  } catch {
    throw new Error('Scanner key attestation is not valid JSON');
  }
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    throw new Error('Scanner key attestation must be an object');
  }
  const fields = Object.keys(attestation).sort();
  if (
    fields.length !== ATTESTATION_FIELDS.length ||
    fields.some((field, index) => field !== ATTESTATION_FIELDS[index])
  ) {
    throw new Error('Scanner key attestation fields do not match the exact schema');
  }
  if (
    attestation.environment !== environment ||
    attestation.projectId !== projectId ||
    attestation.keyId !== keyId
  ) {
    throw new Error('Scanner key attestation does not match the protected environment');
  }
  if (
    !Array.isArray(attestation.scopes) ||
    attestation.scopes.length !== EXACT_SCOPES.length ||
    attestation.scopes.some((scope, index) => scope !== EXACT_SCOPES[index])
  ) {
    throw new Error('Scanner key attestation must contain only files.read and files.write');
  }
  if (
    typeof attestation.reviewer !== 'string' ||
    attestation.reviewer.length === 0 ||
    attestation.reviewer.length > 128 ||
    attestation.reviewer.trim() !== attestation.reviewer ||
    /[\u0000-\u001f\u007f]/.test(attestation.reviewer)
  ) {
    throw new Error('Scanner key attestation reviewer is invalid');
  }

  const checkedAt = requireNow(now).getTime();
  const createdAt = requireTime(attestation.createdAt, 'createdAt');
  const expiresAt = requireTime(attestation.expiresAt, 'expiresAt');
  if (createdAt > checkedAt + MAX_CLOCK_SKEW_MS) {
    throw new Error('Scanner key attestation creation time is in the future');
  }
  if (expiresAt <= checkedAt) {
    throw new Error('Scanner key attestation has expired');
  }
  if (expiresAt <= createdAt || expiresAt - createdAt > MAX_KEY_LIFETIME_MS) {
    throw new Error('Scanner key attestation lifetime must be at most 90 days');
  }
  return Object.freeze({ ...attestation, scopes: Object.freeze([...attestation.scopes]) });
}

function baseHeaders(projectId, apiKey, accept) {
  return {
    accept,
    'accept-encoding': 'identity',
    'x-appwrite-project': projectId,
    'x-appwrite-key': apiKey,
    'x-appwrite-response-format': RESPONSE_FORMAT,
  };
}

async function fetchBounded(fetchImpl, url, init, timeoutMs, label) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal });
    if (
      !response ||
      !Number.isSafeInteger(response.status) ||
      !response.headers ||
      typeof response.headers.get !== 'function'
    ) {
      throw new Error(`Appwrite storage canary ${label} returned an invalid HTTP response`);
    }
    return response;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Appwrite storage canary ')) {
      throw error;
    }
    if (signal.aborted) throw new Error(`Appwrite storage canary ${label} timed out`);
    throw new Error(`Appwrite storage canary ${label} failed before a response`);
  }
}

async function readBounded(response, label, limit = MAX_RESPONSE_BYTES) {
  const declaredLength = response.headers.get('content-length');
  let expectedLength = null;
  if (declaredLength !== null) {
    const parsed = /^\d+$/.test(declaredLength) ? Number(declaredLength) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > limit) {
      throw new Error(`Appwrite storage canary ${label} response has an invalid size`);
    }
    expectedLength = parsed;
  }
  if (!response.body) {
    throw new Error(`Appwrite storage canary ${label} response was empty`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error(`Appwrite storage canary ${label} response body is invalid`);
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Appwrite storage canary ${label} response exceeds the size limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Appwrite storage canary ')) {
      throw error;
    }
    throw new Error(`Appwrite storage canary ${label} response ended before completion`);
  }
  if (expectedLength !== null && total !== expectedLength) {
    throw new Error(`Appwrite storage canary ${label} response size did not match its header`);
  }
  return Buffer.concat(chunks, total);
}

async function readJson(response, label) {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Appwrite storage canary ${label} response content-type is invalid`);
  }
  const body = await readBounded(response, label);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new Error(`Appwrite storage canary ${label} response was not valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Appwrite storage canary ${label} response was not valid JSON`);
  }
}

function verifyMetadata(payload, { fileId, bucketId, fileName, contentLength }) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    payload.$id !== fileId ||
    payload.bucketId !== bucketId ||
    payload.name !== fileName ||
    payload.sizeOriginal !== contentLength
  ) {
    throw new Error('Appwrite storage canary metadata did not match the uploaded file');
  }
}

function randomCanary(randomBytesImpl) {
  const entropy = randomBytesImpl(16);
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 16) {
    throw new Error('Appwrite storage canary entropy source failed');
  }
  const token = Buffer.from(entropy).toString('hex');
  const fileId = `lemcanary-${token.slice(0, 24)}`;
  const fileName = `${fileId}.tgz`;
  const marker = Buffer.from(`lemonize-scanner-canary:${token}\n`, 'utf8');
  const content = gzipSync(marker, { level: 9, mtime: 0 });
  if (content.byteLength > MAX_CANARY_BYTES) {
    throw new Error('Appwrite storage canary content exceeds its limit');
  }
  return { fileId, fileName, content };
}

export async function runScannerStorageCanary(options, fetchImpl = fetch) {
  const baseUrl = requireEndpoint(options.endpoint);
  const projectId = requireId(options.projectId, 'APPWRITE_PROJECT_ID');
  const bucketId = requireId(options.bucketId, 'APPWRITE_QUARANTINE_BUCKET_ID');
  const apiKey = requireSecret(options.apiKey, 'APPWRITE_SCANNER_API_KEY');
  const timeoutMs = requestTimeout(options.timeoutMs);
  const randomBytesImpl = options.randomBytesImpl ?? randomBytes;
  const { fileId, fileName, content } = randomCanary(randomBytesImpl);
  const fileUrl = `${baseUrl}/storage/buckets/${encodeURIComponent(bucketId)}/files/${encodeURIComponent(fileId)}`;
  const filesUrl = `${baseUrl}/storage/buckets/${encodeURIComponent(bucketId)}/files`;
  const headers = baseHeaders(projectId, apiKey, 'application/json');
  let createAttempted = false;
  let createMayHaveSucceeded = false;
  let primaryError;

  try {
    const absent = await fetchBounded(
      fetchImpl,
      fileUrl,
      { method: 'GET', headers },
      timeoutMs,
      'collision check',
    );
    if (absent.status !== 404) {
      await absent.body?.cancel().catch(() => undefined);
      throw new Error(`Appwrite storage canary collision check failed with HTTP ${absent.status}`);
    }
    await absent.body?.cancel().catch(() => undefined);

    const form = new FormData();
    form.set('fileId', fileId);
    form.set('file', new Blob([content], { type: 'application/gzip' }), fileName);
    createAttempted = true;
    createMayHaveSucceeded = true;
    const created = await fetchBounded(
      fetchImpl,
      filesUrl,
      { method: 'POST', headers, body: form },
      timeoutMs,
      'create',
    );
    if (created.status !== 201) {
      if (created.status >= 400 && created.status < 500) createMayHaveSucceeded = false;
      await created.body?.cancel().catch(() => undefined);
      throw new Error(`Appwrite storage canary create failed with HTTP ${created.status}`);
    }
    const expected = { fileId, bucketId, fileName, contentLength: content.byteLength };
    verifyMetadata(await readJson(created, 'create'), expected);

    const metadata = await fetchBounded(
      fetchImpl,
      fileUrl,
      { method: 'GET', headers },
      timeoutMs,
      'metadata read',
    );
    if (metadata.status !== 200) {
      await metadata.body?.cancel().catch(() => undefined);
      throw new Error(`Appwrite storage canary metadata read failed with HTTP ${metadata.status}`);
    }
    verifyMetadata(await readJson(metadata, 'metadata read'), expected);

    const download = await fetchBounded(
      fetchImpl,
      `${fileUrl}/download`,
      {
        method: 'GET',
        headers: baseHeaders(projectId, apiKey, 'application/octet-stream'),
      },
      timeoutMs,
      'content read',
    );
    if (download.status !== 200) {
      await download.body?.cancel().catch(() => undefined);
      throw new Error(`Appwrite storage canary content read failed with HTTP ${download.status}`);
    }
    const downloaded = await readBounded(download, 'content read', MAX_CANARY_BYTES);
    if (downloaded.byteLength !== content.byteLength || !downloaded.equals(content)) {
      throw new Error('Appwrite storage canary downloaded content did not match');
    }
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error('Appwrite storage canary failed');
  }

  let cleanupError;
  if (createAttempted && createMayHaveSucceeded) {
    let deleteError;
    try {
      const removed = await fetchBounded(
        fetchImpl,
        fileUrl,
        { method: 'DELETE', headers },
        timeoutMs,
        'cleanup',
      );
      if (removed.status !== 204 && removed.status !== 404) {
        await removed.body?.cancel().catch(() => undefined);
        throw new Error(`Appwrite storage canary cleanup failed with HTTP ${removed.status}`);
      }
      await removed.body?.cancel().catch(() => undefined);
    } catch (error) {
      deleteError =
        error instanceof Error ? error : new Error('Appwrite storage canary cleanup failed');
    }

    // A DELETE response can be lost after Appwrite commits it. Always perform
    // an independent authenticated read: exact 404 proves absence even when
    // DELETE returned 404, an error status, or timed out.
    try {
      const confirmed = await fetchBounded(
        fetchImpl,
        fileUrl,
        { method: 'GET', headers },
        timeoutMs,
        'cleanup confirmation',
      );
      if (confirmed.status !== 404) {
        await confirmed.body?.cancel().catch(() => undefined);
        throw new Error(
          `Appwrite storage canary cleanup confirmation failed with HTTP ${confirmed.status}`,
        );
      }
      await confirmed.body?.cancel().catch(() => undefined);
    } catch (error) {
      cleanupError =
        error instanceof Error
          ? error
          : (deleteError ?? new Error('Appwrite storage canary cleanup failed'));
    }
  }

  if (cleanupError) {
    throw new Error('Appwrite storage canary cleanup could not be confirmed', {
      cause: cleanupError,
    });
  }
  if (primaryError) throw primaryError;
  return true;
}

async function main() {
  verifyScannerKeyAttestation({
    attestationJson: process.env.APPWRITE_SCANNER_API_KEY_ATTESTATION_JSON,
    environment: process.env.DEPLOY_ENV,
    projectId: process.env.APPWRITE_PROJECT_ID,
    keyId: process.env.APPWRITE_SCANNER_API_KEY_ID,
  });
  await runScannerStorageCanary({
    endpoint: process.env.APPWRITE_ENDPOINT,
    projectId: process.env.APPWRITE_PROJECT_ID,
    apiKey: process.env.APPWRITE_SCANNER_API_KEY,
    bucketId: process.env.APPWRITE_QUARANTINE_BUCKET_ID,
  });
  process.stdout.write('Scanner storage API key attestation and canary passed\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Scanner storage key check failed'}\n`,
    );
    process.exitCode = 1;
  });
}
