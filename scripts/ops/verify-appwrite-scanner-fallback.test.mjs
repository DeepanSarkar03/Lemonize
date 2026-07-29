import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { create } from 'tar';
import {
  isExactArtifactHandoffFailure,
  scannerChallengeHeaders,
  verifyAppwriteServerVersion,
  verifyAttestedStaleScannerFunctionState,
  verifyScannerFallback,
  verifyScannerChallenge,
  verifyScannerFunctionConfiguration,
  verifyRegistryWriteGate,
  verifyScannerVariables,
} from './verify-appwrite-scanner-fallback.mjs';
import {
  buildScannerFunctionRequest,
  reconcileScannerFunction,
  scannerFunctionConfiguration,
} from './reconcile-appwrite-scanner-function.mjs';
import {
  buildAppwriteDeploymentSourceRequest,
  downloadAppwriteDeploymentSource,
} from './download-appwrite-deployment-source.mjs';

const functionId = 'artifact-scanner';
const deploymentId = 'ready-deployment-1';
const attestedStagingDeploymentId = '6a6181a0da2eaed03005';
const attestedStagingProjectId = 'lemonize-staging-2026';
const attestedProductionDeploymentId = '6a61824d9976c050eeee';
const attestedProductionProjectId = 'lemonize-prod-2026';

function writeField(buffer, value, offset, length) {
  Buffer.from(value).copy(buffer, offset, 0, Math.min(Buffer.byteLength(value), length));
}

function writeOctal(buffer, value, offset, length) {
  writeField(buffer, `${value.toString(8).padStart(length - 1, '0')}\0`, offset, length);
}

function rawTarEntry(name, { type = '0', body = '', linkname = '' } = {}) {
  const bytes = Buffer.from(body);
  const header = Buffer.alloc(512);
  writeField(header, name, 0, 100);
  writeOctal(header, type === '5' ? 0o755 : 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, bytes.length, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  writeField(header, type, 156, 1);
  writeField(header, linkname, 157, 100);
  writeField(header, 'ustar\0', 257, 6);
  writeField(header, '00', 263, 2);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeField(header, `${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return Buffer.concat([header, bytes, padding]);
}

async function writeRawTar(path, entries) {
  await writeFile(path, Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function functionPayload(overrides = {}) {
  return {
    $id: functionId,
    name: 'Lemonize artifact scanner',
    deploymentId,
    enabled: true,
    live: true,
    logging: true,
    runtime: 'node-25',
    timeout: 60,
    entrypoint: 'dist/main.js',
    commands: 'node --check dist/main.js',
    schedule: '',
    deploymentRetention: 3,
    scopes: ['files.read', 'files.write'],
    execute: [],
    events: [],
    installationId: '',
    providerRepositoryId: '',
    providerBranch: '',
    providerSilentMode: false,
    providerRootDirectory: '',
    providerBranches: [],
    providerPaths: [],
    buildSpecification: 's-2vcpu-2gb',
    runtimeSpecification: 's-0.5vcpu-512mb',
    ...overrides,
  };
}

function deploymentPayload(overrides = {}) {
  return {
    $id: deploymentId,
    resourceId: functionId,
    resourceType: 'functions',
    status: 'ready',
    entrypoint: 'dist/main.js',
    sourceSize: 256,
    buildSize: 512,
    ...overrides,
  };
}

const variableValues = {
  REGISTRY_INTERNAL_URL: 'https://registry.example.test',
  SCAN_SIGNING_SECRET: '',
  APPWRITE_API_KEY: '',
  APPWRITE_QUARANTINE_BUCKET_ID: 'quarantine',
  MAX_ARCHIVE_BYTES: '10485760',
  MAX_PACKAGE_FILES: '2000',
  MAX_SIGNATURE_AGE_SECONDS: '300',
};

function variablePayload(overrides = {}) {
  const variables = Object.entries(variableValues).map(([key, value], index) => ({
    $id: `variable-${index}`,
    key,
    value,
    secret: new Set(['SCAN_SIGNING_SECRET', 'APPWRITE_API_KEY']).has(key),
    resourceType: 'function',
    resourceId: functionId,
  }));
  return { total: variables.length, variables, ...overrides };
}

function verifyVariables(overrides = {}) {
  return verifyScannerVariables({
    functionVariablesPayload: variablePayload(),
    projectVariablesPayload: { total: 0, variables: [] },
    functionId,
    registryUrl: variableValues.REGISTRY_INTERNAL_URL,
    quarantineBucketId: variableValues.APPWRITE_QUARANTINE_BUCKET_ID,
    maxArchiveBytes: variableValues.MAX_ARCHIVE_BYTES,
    maxPackageFiles: variableValues.MAX_PACKAGE_FILES,
    ...overrides,
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lemonize-scanner-test-'));
  const candidate = join(root, 'candidate');
  await mkdir(join(candidate, 'dist'), { recursive: true });
  await writeFile(join(candidate, 'package.json'), '{"name":"scanner"}\n');
  await writeFile(join(candidate, 'dist', 'main.js'), 'export default () => {};\n');
  await writeFile(join(candidate, 'dist', 'main.js.map'), '{}\n');
  const archive = join(root, 'source.tar.gz');
  await create({ cwd: candidate, file: archive, gzip: true }, ['package.json', 'dist']);
  return { root, candidate, archive };
}

async function verify(input = {}) {
  const files = await fixture();
  try {
    return await verifyScannerFallback({
      functionPayload: functionPayload(),
      deploymentPayload: deploymentPayload(),
      expectedDeploymentId: deploymentId,
      functionId,
      candidateDirectory: files.candidate,
      sourceArchive: files.archive,
      ...input,
    });
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
}

test('accepts only an active ready deployment with byte-identical source', async () => {
  assert.equal(await verify(), deploymentId);
});

test('accepts a stale marker only for the checked-in deployment attestation', async () => {
  const files = await fixture();
  try {
    const staleFunction = functionPayload({
      deploymentId: attestedStagingDeploymentId,
      live: false,
    });
    const readyDeployment = deploymentPayload({ $id: attestedStagingDeploymentId });
    assert.equal(
      verifyAttestedStaleScannerFunctionState(
        staleFunction,
        attestedStagingDeploymentId,
        functionId,
        attestedStagingProjectId,
      ),
      attestedStagingDeploymentId,
    );
    assert.equal(
      verifyAttestedStaleScannerFunctionState(
        functionPayload({ deploymentId: attestedProductionDeploymentId, live: false }),
        attestedProductionDeploymentId,
        functionId,
        attestedProductionProjectId,
      ),
      attestedProductionDeploymentId,
    );
    assert.equal(
      await verifyScannerFallback({
        functionPayload: staleFunction,
        deploymentPayload: readyDeployment,
        expectedDeploymentId: attestedStagingDeploymentId,
        functionId,
        candidateDirectory: files.candidate,
        sourceArchive: files.archive,
        attestedStaleProjectId: attestedStagingProjectId,
      }),
      attestedStagingDeploymentId,
    );
    assert.throws(
      () =>
        verifyAttestedStaleScannerFunctionState(
          { ...staleFunction, live: true },
          attestedStagingDeploymentId,
          functionId,
          attestedStagingProjectId,
        ),
      /exact stale configuration marker/,
    );
    assert.throws(
      () =>
        verifyAttestedStaleScannerFunctionState(
          staleFunction,
          attestedStagingDeploymentId,
          functionId,
          'unreviewed-project',
        ),
      /not covered by a checked-in attestation/,
    );
    assert.throws(
      () =>
        verifyAttestedStaleScannerFunctionState(
          staleFunction,
          attestedStagingDeploymentId,
          functionId,
          attestedProductionProjectId,
        ),
      /not covered by a checked-in attestation/,
    );
    await assert.rejects(
      verifyScannerFallback({
        functionPayload: staleFunction,
        deploymentPayload: { ...readyDeployment, status: 'failed' },
        expectedDeploymentId: attestedStagingDeploymentId,
        functionId,
        candidateDirectory: files.candidate,
        sourceArchive: files.archive,
        attestedStaleProjectId: attestedStagingProjectId,
      }),
      /not a complete ready build/,
    );
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test('pins the stale fallback exception to Appwrite 1.9.5', () => {
  assert.equal(verifyAppwriteServerVersion({ version: '1.9.5' }), '1.9.5');
  assert.throws(
    () => verifyAppwriteServerVersion({ version: '1.9.6' }),
    /not approved for Appwrite 1.9.6/,
  );
});

test('accepts exact scanner configuration without requiring a live deployment', () => {
  assert.equal(
    verifyScannerFunctionConfiguration(functionPayload({ live: false }), functionId),
    functionId,
  );
  for (const drift of [
    { execute: ['any'] },
    { events: ['users.*.create'] },
    { providerBranches: ['*'] },
    { providerPaths: ['**/*'] },
    { providerSilentMode: true },
    { buildSpecification: 's-1vcpu-512mb' },
    { runtimeSpecification: 's-1vcpu-1gb' },
  ]) {
    assert.throws(
      () => verifyScannerFunctionConfiguration(functionPayload(drift), functionId),
      /configuration has drifted/,
    );
  }
});

test('reconciles empty Appwrite arrays as JSON instead of bare CLI flags', async () => {
  const apiKey = 'test-api-key';
  const options = {
    command: 'update',
    endpoint: 'https://fra.cloud.appwrite.io/v1/',
    projectId: 'lemonize-staging-2026',
    apiKey,
    functionId,
  };
  const request = buildScannerFunctionRequest(options);
  assert.equal(request.url, `https://fra.cloud.appwrite.io/v1/functions/${functionId}`);
  assert.equal(request.init.method, 'PUT');
  assert.equal(request.init.headers['x-appwrite-key'], apiKey);
  assert.equal(request.init.headers['x-appwrite-response-format'], '1.9.5');
  assert.deepEqual(JSON.parse(request.init.body), scannerFunctionConfiguration());

  let captured;
  const result = await reconcileScannerFunction(options, async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify(functionPayload({ live: false })), { status: 200 });
  });
  assert.equal(result.$id, functionId);
  assert.equal(captured.url, request.url);
  assert.equal(captured.init.method, request.init.method);
  assert.equal(captured.init.body, request.init.body);
  assert.deepEqual(captured.init.headers, request.init.headers);
  assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.init.signal.aborted, false);

  const create = buildScannerFunctionRequest({ ...options, command: 'create' });
  assert.equal(create.url, 'https://fra.cloud.appwrite.io/v1/functions');
  assert.equal(create.init.method, 'POST');
  assert.deepEqual(JSON.parse(create.init.body), {
    functionId,
    ...scannerFunctionConfiguration(),
  });

  const get = buildScannerFunctionRequest({ ...options, command: 'get' });
  assert.equal(get.url, `https://fra.cloud.appwrite.io/v1/functions/${functionId}`);
  assert.equal(get.init.method, 'GET');
  assert.equal(get.init.headers['x-appwrite-response-format'], '1.9.5');
  assert.equal('body' in get.init, false);

  const listVariables = buildScannerFunctionRequest({
    ...options,
    command: 'list-variables',
  });
  const variablesUrl = new URL(listVariables.url);
  assert.equal(
    `${variablesUrl.origin}${variablesUrl.pathname}`,
    `https://fra.cloud.appwrite.io/v1/functions/${functionId}/variables`,
  );
  assert.deepEqual(JSON.parse(variablesUrl.searchParams.get('queries[]')), {
    method: 'limit',
    values: [100],
  });
  assert.equal(listVariables.init.method, 'GET');
  assert.equal('body' in listVariables.init, false);

  const variables = await reconcileScannerFunction(
    { ...options, command: 'list-variables' },
    async () => new Response(JSON.stringify({ total: 0, variables: [] }), { status: 200 }),
  );
  assert.deepEqual(variables, { total: 0, variables: [] });
  await assert.rejects(
    reconcileScannerFunction(
      { ...options, command: 'list-variables' },
      async () => new Response(JSON.stringify({ total: 0 }), { status: 200 }),
    ),
    /invalid function variable list/,
  );
  await assert.rejects(
    reconcileScannerFunction(
      { ...options, command: 'list-variables' },
      async () => new Response(JSON.stringify({ total: 101, variables: [] }), { status: 200 }),
    ),
    /invalid function variable list/,
  );
});

test('Appwrite reconciliation validates destinations and redacts API errors', async () => {
  for (const endpoint of [
    'http://fra.cloud.appwrite.io/v1',
    'https://attacker.example/v1',
    'https://127.0.0.1/v1',
    'https://fra.cloud.appwrite.io:443/v1',
    'https://fra.cloud.appwrite.io:8443/v1',
    'https://fra.cloud.appwrite.io/v1/functions',
  ]) {
    assert.throws(
      () =>
        buildScannerFunctionRequest({
          command: 'update',
          endpoint,
          projectId: 'lemonize-staging-2026',
          apiKey: 'secret-key',
          functionId,
        }),
      /HTTPS URL|pinned Lemonize Appwrite endpoint/,
    );
  }
  await assert.rejects(
    reconcileScannerFunction(
      {
        command: 'update',
        endpoint: 'https://fra.cloud.appwrite.io/v1',
        projectId: 'lemonize-staging-2026',
        apiKey: 'secret-key',
        functionId,
      },
      async () => new Response('request rejected for secret-key', { status: 400 }),
    ),
    (error) => {
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /\[REDACTED\]/);
      assert.doesNotMatch(error.message, /secret-key/);
      return true;
    },
  );
});

test('rejects inactive, failed, or configuration-drifted deployments', async () => {
  await assert.rejects(
    verify({ functionPayload: functionPayload({ deploymentId: 'other-deployment' }) }),
    /not the function active deployment/,
  );
  await assert.rejects(
    verify({ deploymentPayload: deploymentPayload({ status: 'failed' }) }),
    /not a complete ready build/,
  );
  await assert.rejects(
    verify({ functionPayload: functionPayload({ runtime: 'node-24' }) }),
    /configuration has drifted/,
  );
  for (const drift of [
    { live: false },
    { timeout: 59 },
    { scopes: ['files.read'] },
    { execute: ['any'] },
    { events: ['users.*.create'] },
    { schedule: '* * * * *' },
    { providerRepositoryId: 'untrusted-repository' },
  ]) {
    await assert.rejects(
      verify({ functionPayload: functionPayload(drift) }),
      /configuration has drifted/,
    );
  }
  await assert.rejects(verify({ expectedDeploymentId: '../invalid' }), /valid Appwrite IDs/);
  await assert.rejects(verify({ functionPayload: [] }), /Function response is not an object/);
});

test('rejects source drift even when the deployment is ready', async () => {
  const files = await fixture();
  try {
    await writeFile(join(files.candidate, 'dist', 'main.js'), 'export default () => false;\n');
    await assert.rejects(
      verifyScannerFallback({
        functionPayload: functionPayload(),
        deploymentPayload: deploymentPayload(),
        expectedDeploymentId: deploymentId,
        functionId,
        candidateDirectory: files.candidate,
        sourceArchive: files.archive,
      }),
      /differs from the candidate/,
    );
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test('rejects additional downloaded source files', async () => {
  const files = await fixture();
  try {
    const extra = join(files.root, 'extra');
    await mkdir(join(extra, 'dist'), { recursive: true });
    await writeFile(join(extra, 'package.json'), '{"name":"scanner"}\n');
    await writeFile(join(extra, 'dist', 'main.js'), 'export default () => {};\n');
    await writeFile(join(extra, 'dist', 'main.js.map'), '{}\n');
    await writeFile(join(extra, 'unexpected.txt'), 'not part of the candidate\n');
    await create({ cwd: extra, file: files.archive, gzip: true }, [
      'package.json',
      'dist',
      'unexpected.txt',
    ]);
    await assert.rejects(
      verifyScannerFallback({
        functionPayload: functionPayload(),
        deploymentPayload: deploymentPayload(),
        expectedDeploymentId: deploymentId,
        functionId,
        candidateDirectory: files.candidate,
        sourceArchive: files.archive,
      }),
      /file set does not match/,
    );
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test('requires the artifact-handoff error to be the exact terminal log line', () => {
  assert.equal(
    isExactArtifactHandoffFailure({
      buildLogs: `build complete\nBuild produced no output artifact.\n`,
    }),
    true,
  );
  assert.equal(
    isExactArtifactHandoffFailure({
      buildLogs: 'prefix Build produced no output artifact.\nsubsequent failure',
    }),
    false,
  );
  assert.equal(isExactArtifactHandoffFailure({ buildLogs: 'unrelated failure' }), false);
});

test('rejects archive links and traversal entries before comparison', async () => {
  for (const unsafeEntry of [
    rawTarEntry('dist/link', { type: '2', linkname: '../package.json' }),
    rawTarEntry('../outside.txt', { body: 'escape' }),
  ]) {
    const files = await fixture();
    try {
      await writeRawTar(files.archive, [
        rawTarEntry('package.json', { body: '{"name":"scanner"}\n' }),
        rawTarEntry('dist/', { type: '5' }),
        rawTarEntry('dist/main.js', { body: 'export default () => {};\n' }),
        unsafeEntry,
      ]);
      await assert.rejects(
        verifyScannerFallback({
          functionPayload: functionPayload(),
          deploymentPayload: deploymentPayload(),
          expectedDeploymentId: deploymentId,
          functionId,
          candidateDirectory: files.candidate,
          sourceArchive: files.archive,
        }),
        /may not contain links|may not escape their extraction root/,
      );
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  }
});

test('accepts only the exact scanner and empty project variable sets', () => {
  assert.equal(verifyVariables(), functionId);
  assert.equal(variablePayload().total, 7);
  const withNodeOptions = variablePayload();
  withNodeOptions.variables.push({
    $id: 'injected',
    key: 'NODE_OPTIONS',
    value: '--import=/tmp/injected.mjs',
    secret: false,
    resourceType: 'function',
    resourceId: functionId,
  });
  withNodeOptions.total += 1;
  assert.throws(
    () => verifyVariables({ functionVariablesPayload: withNodeOptions }),
    /exact allowlist/,
  );

  const exposedSecret = variablePayload();
  const secret = exposedSecret.variables.find((item) => item.key === 'SCAN_SIGNING_SECRET');
  secret.secret = false;
  secret.value = 'exposed';
  assert.throws(
    () => verifyVariables({ functionVariablesPayload: exposedSecret }),
    /exact allowlist/,
  );

  const exposedStaticKey = variablePayload();
  const staticKey = exposedStaticKey.variables.find((item) => item.key === 'APPWRITE_API_KEY');
  staticKey.secret = false;
  staticKey.value = 'provider-value-that-must-not-be-printed';
  assert.throws(
    () => verifyVariables({ functionVariablesPayload: exposedStaticKey }),
    (error) => {
      assert.match(error.message, /exact allowlist/);
      assert.doesNotMatch(error.message, /provider-value/);
      return true;
    },
  );

  const overClassified = variablePayload();
  const publicRegistryUrl = overClassified.variables.find(
    (item) => item.key === 'REGISTRY_INTERNAL_URL',
  );
  publicRegistryUrl.secret = true;
  publicRegistryUrl.value = '';
  assert.throws(
    () => verifyVariables({ functionVariablesPayload: overClassified }),
    /exact allowlist/,
  );

  const wrongSecretReadback = variablePayload();
  wrongSecretReadback.variables.find((item) => item.key === 'SCAN_SIGNING_SECRET').value = null;
  assert.throws(
    () => verifyVariables({ functionVariablesPayload: wrongSecretReadback }),
    /exact allowlist/,
  );

  const wrongStaticKeyReadback = variablePayload();
  wrongStaticKeyReadback.variables.find((item) => item.key === 'APPWRITE_API_KEY').value = null;
  assert.throws(
    () => verifyVariables({ functionVariablesPayload: wrongStaticKeyReadback }),
    /exact allowlist/,
  );

  assert.throws(
    () =>
      verifyVariables({
        projectVariablesPayload: {
          total: 1,
          variables: [{ key: 'NODE_OPTIONS', value: '--require=unsafe', secret: false }],
        },
      }),
    /Project-level Appwrite variables are not allowed/,
  );
});

test('allows secret classification repair only behind the live read-only gate', () => {
  const limits = {
    registryBaseUrl: 'https://registry-staging.lemonize.cyou',
    registryMode: 'read_only',
    allowPublicPublish: false,
    publishRestricted: true,
    openSignup: false,
  };
  assert.equal(
    verifyRegistryWriteGate(limits, 'https://registry-staging.lemonize.cyou'),
    'https://registry-staging.lemonize.cyou',
  );
  for (const drift of [
    { registryMode: 'public' },
    { allowPublicPublish: true },
    { publishRestricted: false },
    { openSignup: true },
    { registryBaseUrl: 'https://registry.lemonize.cyou' },
  ]) {
    assert.throws(
      () =>
        verifyRegistryWriteGate({ ...limits, ...drift }, 'https://registry-staging.lemonize.cyou'),
      /writes are not safely gated/,
    );
  }
});

test('proves the hidden signing secret through a side-effect-free active execution', () => {
  const headers = scannerChallengeHeaders(
    'scanner-test-secret-that-is-long-enough',
    new Date('2026-07-29T00:00:00.000Z'),
  );
  assert.equal(headers['x-lemonize-timestamp'], '1785283200');
  assert.equal(
    headers['x-lemonize-signature'],
    'v1=955f0c9ccb11fadebf8887c2c0a840efacf8885b521907b7d283ab61aaf9029c',
  );

  const execution = {
    functionId,
    status: 'completed',
    deploymentId,
    requestMethod: 'POST',
    requestPath: '/__lemonize_secret_challenge',
    responseStatusCode: 400,
    responseBody: JSON.stringify({ ok: false, error: { code: 'invalid_job' } }),
  };
  assert.equal(verifyScannerChallenge(execution, deploymentId, functionId), deploymentId);
  assert.throws(
    () =>
      verifyScannerChallenge({ ...execution, responseStatusCode: 401 }, deploymentId, functionId),
    /mismatched fields: responseStatusCode/,
  );
  assert.throws(
    () =>
      verifyScannerChallenge(
        {
          ...execution,
          responseBody: JSON.stringify({ ok: false, error: { code: 'invalid_signature' } }),
        },
        deploymentId,
        functionId,
      ),
    /mismatched fields: responseBody/,
  );
});

const sourceDownloadOptions = (destination, overrides = {}) => ({
  endpoint: 'https://fra.cloud.appwrite.io/v1/',
  projectId: 'lemonize-staging-2026',
  apiKey: 'scanner-deploy-secret-key',
  functionId,
  deploymentId: attestedStagingDeploymentId,
  destination,
  ...overrides,
});

async function sourceDownloadFixture() {
  const root = await mkdtemp(join(tmpdir(), 'lemonize-scanner-download-test-'));
  return { root, destination: join(root, 'source.tar.gz') };
}

async function assertMissing(path) {
  await assert.rejects(readFile(path), (error) => error?.code === 'ENOENT');
}

test('builds an exact authenticated Appwrite source download request', () => {
  const request = buildAppwriteDeploymentSourceRequest(sourceDownloadOptions('unused'));
  assert.equal(
    request.url,
    `https://fra.cloud.appwrite.io/v1/functions/${functionId}/deployments/${attestedStagingDeploymentId}/download?type=source`,
  );
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.redirect, 'error');
  assert.equal('body' in request.init, false);
  assert.deepEqual(request.init.headers, {
    accept: 'application/octet-stream',
    'x-appwrite-project': 'lemonize-staging-2026',
    'x-appwrite-key': 'scanner-deploy-secret-key',
    'x-appwrite-response-format': '1.9.5',
  });
});

test('rejects unsafe Appwrite source download destinations and identifiers', async () => {
  const valid = sourceDownloadOptions('unused');
  for (const endpoint of [
    'http://fra.cloud.appwrite.io/v1',
    'https://user@fra.cloud.appwrite.io/v1',
    'https://fra.cloud.appwrite.io/v1?unsafe=true',
    'https://attacker.example/v1',
    'https://127.0.0.1/v1',
    'https://fra.cloud.appwrite.io:443/v1',
    'https://fra.cloud.appwrite.io:8443/v1',
    'https://fra.cloud.appwrite.io/v1/functions',
    'not a URL',
  ]) {
    assert.throws(
      () => buildAppwriteDeploymentSourceRequest({ ...valid, endpoint }),
      /valid URL|HTTPS URL|pinned Lemonize Appwrite endpoint/,
    );
  }
  for (const drift of [
    { projectId: '../project' },
    { functionId: '../function' },
    { deploymentId: '../deployment' },
    { apiKey: '' },
  ]) {
    assert.throws(
      () => buildAppwriteDeploymentSourceRequest({ ...valid, ...drift }),
      /valid Appwrite ID|required/,
    );
  }
  await assert.rejects(
    downloadAppwriteDeploymentSource({ ...valid, destination: '' }),
    /destination is required/,
  );
});

test('downloads the authenticated Appwrite source without following redirects', async () => {
  const files = await sourceDownloadFixture();
  const expected = Buffer.from('exact scanner archive bytes');
  try {
    let captured;
    const size = await downloadAppwriteDeploymentSource(
      sourceDownloadOptions(files.destination),
      async (url, init) => {
        captured = { url, init };
        return new Response(expected, {
          status: 200,
          headers: { 'content-length': String(expected.byteLength) },
        });
      },
    );
    assert.equal(size, expected.byteLength);
    assert.deepEqual(await readFile(files.destination), expected);
    assert.equal(captured.url.includes('scanner-deploy-secret-key'), false);
    assert.equal(captured.init.redirect, 'error');
    assert.equal(captured.init.headers['x-appwrite-key'], 'scanner-deploy-secret-key');
    assert.equal(captured.init.signal.aborted, false);
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test('fails closed on Appwrite source redirects, status errors, and timeouts', async () => {
  for (const scenario of ['redirect', 'status', 'timeout']) {
    const files = await sourceDownloadFixture();
    try {
      let request;
      const fetchImpl = async (_url, init) => {
        request = init;
        if (scenario === 'redirect') throw new TypeError('redirect rejected');
        if (scenario === 'status') {
          return new Response('scanner-deploy-secret-key must not be reported', { status: 401 });
        }
        return await new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      };
      const operation = downloadAppwriteDeploymentSource(
        sourceDownloadOptions(files.destination, {
          ...(scenario === 'timeout' ? { timeoutMs: 5 } : {}),
        }),
        fetchImpl,
      );
      await assert.rejects(operation, (error) => {
        if (scenario === 'redirect') assert.match(error.message, /failed before a response/);
        if (scenario === 'status') {
          assert.match(error.message, /HTTP 401/);
          assert.doesNotMatch(error.message, /scanner-deploy-secret-key/);
        }
        if (scenario === 'timeout') assert.match(error.message, /timed out/);
        return true;
      });
      assert.equal(request.redirect, 'error');
      await assertMissing(files.destination);
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  }
});

test('rejects empty, oversized, and partial Appwrite source bodies without a file', async () => {
  const scenarios = [
    {
      name: 'empty',
      response: () => new Response(null, { status: 200 }),
      pattern: /response was empty/,
    },
    {
      name: 'declared oversized',
      response: () => new Response('12345', { status: 200, headers: { 'content-length': '5' } }),
      pattern: /invalid size/,
    },
    {
      name: 'streamed oversized',
      response: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Uint8Array.from([1, 2, 3]));
              controller.enqueue(Uint8Array.from([4, 5, 6]));
              controller.close();
            },
          }),
          { status: 200 },
        ),
      pattern: /exceeds the download limit/,
    },
    {
      name: 'partial',
      response: () => ({
        status: 200,
        headers: new Headers(),
        body: {
          getReader() {
            let reads = 0;
            return {
              async read() {
                reads += 1;
                if (reads === 1) return { done: false, value: Uint8Array.from([1, 2]) };
                throw new Error('connection reset');
              },
              async cancel() {},
            };
          },
        },
      }),
      pattern: /ended before completion/,
    },
    {
      name: 'shorter than content length',
      response: () =>
        new Response(Uint8Array.from([1, 2]), {
          status: 200,
          headers: { 'content-length': '4' },
        }),
      pattern: /ended before its declared size/,
    },
  ];

  for (const scenario of scenarios) {
    const files = await sourceDownloadFixture();
    try {
      await assert.rejects(
        downloadAppwriteDeploymentSource(
          sourceDownloadOptions(files.destination, { maxBytes: 4 }),
          async () => scenario.response(),
        ),
        scenario.pattern,
        scenario.name,
      );
      await assertMissing(files.destination);
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  }
});

test('never overwrites an existing scanner source archive', async () => {
  const files = await sourceDownloadFixture();
  const original = Buffer.from('trusted existing file');
  try {
    await writeFile(files.destination, original);
    await assert.rejects(
      downloadAppwriteDeploymentSource(
        sourceDownloadOptions(files.destination),
        async () => new Response('replacement', { status: 200 }),
      ),
      (error) => error?.code === 'EEXIST',
    );
    assert.deepEqual(await readFile(files.destination), original);
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test('wires scanner fallback to the authenticated downloader instead of the CLI URL', async () => {
  const script = await readFile(new URL('./deploy-appwrite-scanner.sh', import.meta.url), 'utf8');
  const endpointGate = script.indexOf(
    "readonly PINNED_APPWRITE_ENDPOINT='https://fra.cloud.appwrite.io/v1'",
  );
  const firstKeyBearingCliCommand = script.indexOf('"$APPWRITE_BIN" client');
  assert.notEqual(endpointGate, -1);
  assert.ok(endpointGate < firstKeyBearingCliCommand);
  assert.match(script, /download-appwrite-deployment-source\.mjs/);
  assert.doesNotMatch(script, /functions get-deployment-download/);
  assert.match(
    script,
    /verify_active_secret\(\)[\s\S]*execute-appwrite-scanner-challenge\.mjs" \\\r?\n\s+"\$expected_deployment_id"/,
  );
  assert.doesNotMatch(script, /functions create-execution/);
  assert.doesNotMatch(script, /--challenge-(?:headers|result)/);
  assert.match(script, /APPWRITE_SCANNER_API_KEY APPWRITE_SCANNER_API_KEY_ID/);
  assert.match(script, /readonly deploy_api_key=\$APPWRITE_DEPLOY_API_KEY/);
  assert.match(script, /readonly scanner_api_key=\$APPWRITE_SCANNER_API_KEY/);
  assert.match(script, /readonly scanner_shared_secret=\$SCANNER_SHARED_SECRET/);
  assert.match(
    script,
    /unset APPWRITE_DEPLOY_API_KEY APPWRITE_SCANNER_API_KEY SCANNER_SHARED_SECRET/,
  );
  const secretUnset = script.indexOf(
    'unset APPWRITE_DEPLOY_API_KEY APPWRITE_SCANNER_API_KEY SCANNER_SHARED_SECRET',
  );
  const build = script.indexOf('pnpm --filter @lemonize/artifact-scanner build');
  const syntaxCheck = script.indexOf('node --check "$deploy_dir/dist/main.js"');
  const deployExport = script.indexOf('export APPWRITE_DEPLOY_API_KEY=$deploy_api_key');
  const hmacExport = script.indexOf('export SCANNER_SHARED_SECRET=$scanner_shared_secret');
  assert.ok(secretUnset < build);
  assert.ok(build < syntaxCheck);
  assert.ok(syntaxCheck < deployExport);
  assert.ok(syntaxCheck < hmacExport);
  assert.doesNotMatch(script, /export APPWRITE_SCANNER_API_KEY=/);
  assert.match(script, /"\$scanner_api_key" == "\$deploy_api_key"/);
  assert.match(script, /"\$scanner_api_key" == "\$scanner_shared_secret"/);
  assert.match(script, /"\$deploy_api_key" == "\$scanner_shared_secret"/);
  assert.match(script, /"APPWRITE_API_KEY",/);
  assert.match(
    script,
    /upsert_variable appwrite_api_key APPWRITE_API_KEY "\$scanner_api_key" true/,
  );
  assert.match(script, /'APPWRITE_SCANNER_API_KEY',/);
  assert.doesNotMatch(script, /APPWRITE_RUNTIME_API_KEY/);
});

test('always gates, canary-checks, and reconciles a rotated scanner key before fallback', async () => {
  const script = await readFile(new URL('./deploy-appwrite-scanner.sh', import.meta.url), 'utf8');
  const environmentPin = script.indexOf('verify-appwrite-config.mjs" "$DEPLOY_ENV"');
  const gate = script.indexOf('if ! verify_live_registry_write_gate; then');
  const canary = script.indexOf('verify-appwrite-scanner-storage-key.mjs');
  const reconcile = script.indexOf('"$function_command" > "$reconcile_response_file"');
  const keyUpsert = script.indexOf(
    'upsert_variable appwrite_api_key APPWRITE_API_KEY "$scanner_api_key" true',
  );
  const fallback = script.indexOf('try_identical_active_fallback()');
  assert.ok(environmentPin >= 0);
  assert.ok(environmentPin < gate);
  assert.ok(gate < canary);
  assert.ok(canary < reconcile);
  assert.ok(reconcile < keyUpsert);
  assert.ok(keyUpsert < fallback);
  assert.doesNotMatch(script, /fallback_eligible|fallback-preflight/);
  assert.match(script, /\[\[ "\$stale_fallback_candidate" == true \]\] \|\| return 1/);
});

test('passes the dedicated scanner key only to scanner deployment workflow steps', async () => {
  const workflows = [
    {
      path: '../../.github/workflows/deploy.yml',
      step: 'Reconcile and deploy Appwrite artifact scanner',
    },
    {
      path: '../../.github/workflows/deploy-appwrite-scanner.yml',
      step: 'Deploy dependency-free scanner bundle',
    },
  ];

  for (const workflow of workflows) {
    const source = await readFile(new URL(workflow.path, import.meta.url), 'utf8');
    const marker = `      - name: ${workflow.step}`;
    const start = source.indexOf(marker);
    const end = source.indexOf('\n      - name:', start + marker.length);
    assert.notEqual(start, -1, `${workflow.step} is present`);
    const step = source.slice(start, end === -1 ? source.length : end);
    assert.match(step, /APPWRITE_SCANNER_API_KEY: \$\{\{ secrets\.APPWRITE_SCANNER_API_KEY \}\}/);
    assert.match(
      step,
      /APPWRITE_SCANNER_API_KEY_ID: \$\{\{ vars\.APPWRITE_SCANNER_API_KEY_ID \}\}/,
    );
    assert.match(
      step,
      /APPWRITE_SCANNER_API_KEY_ATTESTATION_JSON: \$\{\{ vars\.APPWRITE_SCANNER_API_KEY_ATTESTATION_JSON \}\}/,
    );
    assert.match(step, /DEPLOY_ENV: \$\{\{ inputs\.environment \}\}/);
    assert.equal(source.match(/^\s*APPWRITE_SCANNER_API_KEY:/gm)?.length, 1);
    assert.equal(source.match(/^\s*APPWRITE_SCANNER_API_KEY_ID:/gm)?.length, 1);
    assert.equal(source.match(/^\s*APPWRITE_SCANNER_API_KEY_ATTESTATION_JSON:/gm)?.length, 1);
    assert.doesNotMatch(
      step,
      /APPWRITE_(?:RUNTIME|DEPLOY)_API_KEY: \$\{\{ secrets\.APPWRITE_SCANNER_API_KEY \}\}/,
    );
  }
});

test('runs the scanner storage-key suite in the required CI scanner check', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  assert.match(
    workflow,
    /node --test[\s\S]*scripts\/ops\/verify-appwrite-scanner-fallback\.test\.mjs[\s\S]*scripts\/ops\/execute-appwrite-scanner-challenge\.test\.mjs[\s\S]*scripts\/ops\/verify-appwrite-scanner-storage-key\.test\.mjs/,
  );
  assert.equal(
    workflow.match(/scripts\/ops\/verify-appwrite-scanner-storage-key\.test\.mjs/g)?.length,
    1,
  );
  assert.equal(workflow.match(/scripts\/ops\/verify-appwrite-config\.test\.mjs/g)?.length, 1);
});
