import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { create } from 'tar';
import {
  isExactArtifactHandoffFailure,
  scannerChallengeHeaders,
  verifyScannerFallback,
  verifyScannerChallenge,
  verifyScannerVariables,
} from './verify-appwrite-scanner-fallback.mjs';

const functionId = 'artifact-scanner';
const deploymentId = 'ready-deployment-1';

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
    providerRootDirectory: '',
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
  SCAN_SIGNING_SECRET: null,
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
    secret: key === 'SCAN_SIGNING_SECRET',
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

test('proves the hidden signing secret through a side-effect-free active execution', () => {
  const headers = scannerChallengeHeaders(
    'scanner-test-secret-that-is-long-enough',
    new Date('2026-07-29T00:00:00.000Z'),
  );
  assert.equal(headers['x-lemonize-timestamp'], '1785283200');
  assert.match(headers['x-lemonize-signature'], /^v1=[a-f0-9]{64}$/);

  const execution = {
    status: 'completed',
    deploymentId,
    requestMethod: 'POST',
    requestPath: '/__lemonize_secret_challenge',
    responseStatusCode: 400,
    responseBody: JSON.stringify({ ok: false, error: { code: 'invalid_job' } }),
  };
  assert.equal(verifyScannerChallenge(execution, deploymentId), deploymentId);
  assert.throws(
    () => verifyScannerChallenge({ ...execution, responseStatusCode: 401 }, deploymentId),
    /did not prove/,
  );
  assert.throws(
    () =>
      verifyScannerChallenge(
        {
          ...execution,
          responseBody: JSON.stringify({ ok: false, error: { code: 'invalid_signature' } }),
        },
        deploymentId,
      ),
    /did not prove/,
  );
});
