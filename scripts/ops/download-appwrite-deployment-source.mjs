import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;
const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_SCANNER_SOURCE_BYTES = 20 * 1024 * 1024;
const RESPONSE_FORMAT = '1.9.5';
const PINNED_APPWRITE_ENDPOINT = 'https://fra.cloud.appwrite.io/v1';

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

function sourceByteLimit(value) {
  if (value === undefined) return MAX_SCANNER_SOURCE_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SCANNER_SOURCE_BYTES) {
    throw new Error('Scanner source byte limit is invalid');
  }
  return value;
}

function requestTimeout(value) {
  if (value === undefined) return REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > REQUEST_TIMEOUT_MS) {
    throw new Error('Appwrite source download timeout is invalid');
  }
  return value;
}

export function buildAppwriteDeploymentSourceRequest({
  endpoint,
  projectId,
  apiKey,
  functionId,
  deploymentId,
}) {
  const baseUrl = requireEndpoint(endpoint);
  requireId(projectId, 'APPWRITE_PROJECT_ID');
  requireSecret(apiKey, 'APPWRITE_DEPLOY_API_KEY');
  requireId(functionId, 'APPWRITE_SCANNER_FUNCTION_ID');
  requireId(deploymentId, 'Appwrite deployment ID');

  const url = new URL(
    `${baseUrl}/functions/${encodeURIComponent(functionId)}/deployments/${encodeURIComponent(deploymentId)}/download`,
  );
  url.searchParams.set('type', 'source');

  return {
    url: url.href,
    init: {
      method: 'GET',
      headers: {
        accept: 'application/octet-stream',
        'x-appwrite-project': projectId,
        'x-appwrite-key': apiKey,
        'x-appwrite-response-format': RESPONSE_FORMAT,
      },
      redirect: 'error',
    },
  };
}

async function readBoundedBody(response, limit) {
  const declaredLength = response.headers.get('content-length');
  let expectedLength = null;
  if (declaredLength !== null) {
    const parsedLength = /^\d+$/.test(declaredLength) ? Number(declaredLength) : Number.NaN;
    if (!Number.isSafeInteger(parsedLength) || parsedLength <= 0 || parsedLength > limit) {
      throw new Error('Appwrite deployment source has an invalid size');
    }
    expectedLength = parsedLength;
  }
  if (!response.body) {
    throw new Error('Appwrite deployment source response was empty');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let complete = false;
  try {
    while (!complete) {
      const { done, value } = await reader.read();
      complete = done;
      if (complete) continue;
      if (!(value instanceof Uint8Array)) {
        throw new Error('Appwrite deployment source returned an invalid body');
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error('Appwrite deployment source exceeds the download limit');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'Appwrite deployment source returned an invalid body' ||
        error.message === 'Appwrite deployment source exceeds the download limit')
    ) {
      throw error;
    }
    throw new Error('Appwrite deployment source response ended before completion', {
      cause: error,
    });
  }
  if (total === 0) {
    throw new Error('Appwrite deployment source response was empty');
  }
  if (expectedLength !== null && total !== expectedLength) {
    throw new Error('Appwrite deployment source response ended before its declared size');
  }
  return Buffer.concat(chunks, total);
}

export async function downloadAppwriteDeploymentSource(options, fetchImpl = fetch) {
  if (typeof options.destination !== 'string' || options.destination.length === 0) {
    throw new Error('Scanner source destination is required');
  }
  const destination = resolve(options.destination);
  const request = buildAppwriteDeploymentSourceRequest(options);
  const limit = sourceByteLimit(options.maxBytes);
  const timeoutMs = requestTimeout(options.timeoutMs);
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(request.url, { ...request.init, signal });
  } catch (error) {
    if (signal.aborted) {
      throw new Error('Appwrite deployment source request timed out', { cause: error });
    }
    throw new Error('Appwrite deployment source request failed before a response', {
      cause: error,
    });
  }
  if (response.status !== 200) {
    throw new Error(`Appwrite deployment source request failed with HTTP ${response.status}`);
  }

  const body = await readBoundedBody(response, limit);
  await writeFile(destination, body, { flag: 'wx', mode: 0o600 });
  return body.byteLength;
}

async function main() {
  const [deploymentId, destination] = process.argv.slice(2);
  if (!deploymentId || !destination) {
    throw new Error('Usage: download-appwrite-deployment-source.mjs <deployment-id> <destination>');
  }
  await downloadAppwriteDeploymentSource({
    endpoint: process.env.APPWRITE_ENDPOINT,
    projectId: process.env.APPWRITE_PROJECT_ID,
    apiKey: process.env.APPWRITE_DEPLOY_API_KEY,
    functionId: process.env.APPWRITE_SCANNER_FUNCTION_ID,
    deploymentId,
    destination,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
