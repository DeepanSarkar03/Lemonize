import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  scannerChallengeHeaders,
  verifyScannerChallenge,
} from './verify-appwrite-scanner-fallback.mjs';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;
const PINNED_APPWRITE_ENDPOINT = 'https://fra.cloud.appwrite.io/v1';
const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_FORMAT = '1.9.5';
const CHALLENGE_PATH = '/__lemonize_secret_challenge';
const CHALLENGE_BODY = '{}';
export const MAX_EXECUTION_RESPONSE_BYTES = 64 * 1024;

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

function requestTimeout(value) {
  if (value === undefined) return REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > REQUEST_TIMEOUT_MS) {
    throw new Error('Appwrite scanner challenge timeout is invalid');
  }
  return value;
}

function challengeTime(value) {
  if (value === undefined) return new Date();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('Appwrite scanner challenge time is invalid');
  }
  return value;
}

export function buildAppwriteScannerChallengeRequest({
  endpoint,
  projectId,
  apiKey,
  functionId,
  scannerSecret,
  now,
}) {
  const baseUrl = requireEndpoint(endpoint);
  requireId(projectId, 'APPWRITE_PROJECT_ID');
  requireSecret(apiKey, 'APPWRITE_DEPLOY_API_KEY');
  requireId(functionId, 'APPWRITE_SCANNER_FUNCTION_ID');
  const headers = scannerChallengeHeaders(scannerSecret, challengeTime(now));

  return {
    url: `${baseUrl}/functions/${encodeURIComponent(functionId)}/executions`,
    init: {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'identity',
        'content-type': 'application/json',
        'x-appwrite-project': projectId,
        'x-appwrite-key': apiKey,
        'x-appwrite-response-format': RESPONSE_FORMAT,
      },
      body: JSON.stringify({
        body: CHALLENGE_BODY,
        async: false,
        path: CHALLENGE_PATH,
        method: 'POST',
        headers,
      }),
      redirect: 'error',
    },
  };
}

async function readBoundedJson(response) {
  const declaredLength = response.headers.get('content-length');
  let expectedLength = null;
  if (declaredLength !== null) {
    const parsedLength = /^\d+$/.test(declaredLength) ? Number(declaredLength) : Number.NaN;
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength <= 0 ||
      parsedLength > MAX_EXECUTION_RESPONSE_BYTES
    ) {
      throw new Error('Appwrite scanner challenge response has an invalid size');
    }
    expectedLength = parsedLength;
  }
  if (!response.body) {
    throw new Error('Appwrite scanner challenge response was empty');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error('Appwrite scanner challenge response body is invalid');
      }
      total += value.byteLength;
      if (total > MAX_EXECUTION_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Appwrite scanner challenge response exceeds the size limit');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'Appwrite scanner challenge response body is invalid' ||
        error.message === 'Appwrite scanner challenge response exceeds the size limit')
    ) {
      throw error;
    }
    throw new Error('Appwrite scanner challenge response ended before completion');
  }
  if (total === 0) {
    throw new Error('Appwrite scanner challenge response was empty');
  }
  if (expectedLength !== null && total !== expectedLength) {
    throw new Error('Appwrite scanner challenge response did not match its declared size');
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch {
    throw new Error('Appwrite scanner challenge response was not valid UTF-8');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Appwrite scanner challenge response was not valid JSON');
  }
}

export async function executeAppwriteScannerChallenge(options, fetchImpl = fetch) {
  requireId(options.expectedDeploymentId, 'Expected Appwrite deployment ID');
  const request = buildAppwriteScannerChallengeRequest(options);
  const signal = AbortSignal.timeout(requestTimeout(options.timeoutMs));
  let response;
  try {
    response = await fetchImpl(request.url, { ...request.init, signal });
  } catch {
    if (signal.aborted) throw new Error('Appwrite scanner challenge request timed out');
    throw new Error('Appwrite scanner challenge request failed before a response');
  }
  if (
    !response ||
    !Number.isSafeInteger(response.status) ||
    !response.headers ||
    typeof response.headers.get !== 'function'
  ) {
    throw new Error('Appwrite scanner challenge returned an invalid HTTP response');
  }
  if (response.status !== 201) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Appwrite scanner challenge request failed with HTTP ${response.status}`);
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Appwrite scanner challenge response content-type is invalid');
  }

  const execution = await readBoundedJson(response);
  return verifyScannerChallenge(execution, options.expectedDeploymentId, options.functionId);
}

async function main() {
  const [expectedDeploymentId] = process.argv.slice(2);
  if (!expectedDeploymentId) {
    throw new Error('Usage: execute-appwrite-scanner-challenge.mjs <deployment-id>');
  }
  const verifiedDeploymentId = await executeAppwriteScannerChallenge({
    endpoint: process.env.APPWRITE_ENDPOINT,
    projectId: process.env.APPWRITE_PROJECT_ID,
    apiKey: process.env.APPWRITE_DEPLOY_API_KEY,
    functionId: process.env.APPWRITE_SCANNER_FUNCTION_ID,
    scannerSecret: process.env.SCANNER_SHARED_SECRET,
    expectedDeploymentId,
  });
  process.stdout.write(`${verifiedDeploymentId}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unknown challenge error'}\n`);
    process.exitCode = 1;
  });
}
