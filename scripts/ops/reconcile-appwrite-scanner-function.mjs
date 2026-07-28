import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;
const REQUEST_TIMEOUT_MS = 30_000;

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

export function scannerFunctionConfiguration() {
  return {
    name: 'Lemonize artifact scanner',
    runtime: 'node-25',
    execute: [],
    events: [],
    schedule: '',
    timeout: 60,
    enabled: true,
    logging: true,
    entrypoint: 'dist/main.js',
    commands: 'node --check dist/main.js',
    scopes: ['files.read', 'files.write'],
    installationId: '',
    providerRepositoryId: '',
    providerBranch: '',
    providerSilentMode: false,
    providerRootDirectory: '',
    providerBranches: [],
    providerPaths: [],
    buildSpecification: 's-2vcpu-2gb',
    runtimeSpecification: 's-0.5vcpu-512mb',
    deploymentRetention: 3,
  };
}

export function buildScannerFunctionRequest({ command, endpoint, projectId, apiKey, functionId }) {
  if (command !== 'create' && command !== 'update') {
    throw new Error('Scanner reconciliation command must be create or update');
  }
  requireId(projectId, 'APPWRITE_PROJECT_ID');
  requireId(functionId, 'APPWRITE_SCANNER_FUNCTION_ID');
  requireSecret(apiKey, 'APPWRITE_DEPLOY_API_KEY');

  let base;
  try {
    base = new URL(endpoint);
  } catch {
    throw new Error('APPWRITE_ENDPOINT must be a valid URL');
  }
  if (
    base.protocol !== 'https:' ||
    base.username !== '' ||
    base.password !== '' ||
    base.search !== '' ||
    base.hash !== ''
  ) {
    throw new Error('APPWRITE_ENDPOINT must be an HTTPS URL without credentials or parameters');
  }

  const baseUrl = base.href.replace(/\/+$/, '');
  const resource =
    command === 'create'
      ? `${baseUrl}/functions`
      : `${baseUrl}/functions/${encodeURIComponent(functionId)}`;
  const body = {
    ...(command === 'create' ? { functionId } : {}),
    ...scannerFunctionConfiguration(),
  };

  return {
    url: resource,
    init: {
      method: command === 'create' ? 'POST' : 'PUT',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-appwrite-project': projectId,
        'x-appwrite-key': apiKey,
        'x-appwrite-response-format': '1.8.1',
      },
      body: JSON.stringify(body),
      redirect: 'error',
    },
  };
}

export async function reconcileScannerFunction(options, fetchImpl = fetch) {
  const request = buildScannerFunctionRequest(options);
  const response = await fetchImpl(request.url, {
    ...request.init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const responseText = await response.text();
  if (!response.ok) {
    const safeMessage = responseText
      // eslint-disable-next-line no-control-regex -- API errors can contain terminal control bytes.
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replaceAll(options.apiKey, '[REDACTED]')
      .trim()
      .slice(0, 2_000);
    throw new Error(
      `Appwrite function reconciliation failed with HTTP ${response.status}${
        safeMessage ? `: ${safeMessage}` : ''
      }`,
    );
  }

  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error('Appwrite function reconciliation returned malformed JSON');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Appwrite function reconciliation returned an invalid object');
  }
  if (result.$id !== options.functionId) {
    throw new Error('Appwrite reconciled a different function than requested');
  }
  return result;
}

async function main() {
  const [command] = process.argv.slice(2);
  const result = await reconcileScannerFunction({
    command,
    endpoint: process.env.APPWRITE_ENDPOINT,
    projectId: process.env.APPWRITE_PROJECT_ID,
    apiKey: process.env.APPWRITE_DEPLOY_API_KEY,
    functionId: process.env.APPWRITE_SCANNER_FUNCTION_ID,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
