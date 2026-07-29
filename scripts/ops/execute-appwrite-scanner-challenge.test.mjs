import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAppwriteScannerChallengeRequest,
  executeAppwriteScannerChallenge,
  MAX_EXECUTION_RESPONSE_BYTES,
} from './execute-appwrite-scanner-challenge.mjs';

const functionId = 'artifact-scanner';
const deploymentId = 'ready-deployment-1';
const apiKey = 'scanner-deploy-api-key-value';
const scannerSecret = 'scanner-test-secret-that-is-long-enough';
const now = new Date('2026-07-29T00:00:00.000Z');

const options = (overrides = {}) => ({
  endpoint: 'https://fra.cloud.appwrite.io/v1',
  projectId: 'lemonize-staging-2026',
  apiKey,
  functionId,
  scannerSecret,
  expectedDeploymentId: deploymentId,
  now,
  ...overrides,
});

const execution = (overrides = {}) => ({
  $id: 'execution-1',
  functionId,
  status: 'completed',
  deploymentId,
  requestMethod: 'POST',
  requestPath: '/__lemonize_secret_challenge',
  responseStatusCode: 400,
  responseBody: JSON.stringify({ ok: false, error: { code: 'invalid_job' } }),
  ...overrides,
});

function jsonResponse(payload, { status = 201, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

test('builds the exact authenticated synchronous Appwrite execution request', () => {
  const request = buildAppwriteScannerChallengeRequest(options());
  assert.equal(
    request.url,
    'https://fra.cloud.appwrite.io/v1/functions/artifact-scanner/executions',
  );
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.redirect, 'error');
  assert.deepEqual(request.init.headers, {
    accept: 'application/json',
    'accept-encoding': 'identity',
    'content-type': 'application/json',
    'x-appwrite-project': 'lemonize-staging-2026',
    'x-appwrite-key': apiKey,
    'x-appwrite-response-format': '1.9.5',
  });
  assert.deepEqual(JSON.parse(request.init.body), {
    body: '{}',
    async: false,
    path: '/__lemonize_secret_challenge',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-lemonize-timestamp': '1785283200',
      'x-lemonize-signature': 'v1=955f0c9ccb11fadebf8887c2c0a840efacf8885b521907b7d283ab61aaf9029c',
    },
  });
  assert.equal(request.url.includes(apiKey), false);
  assert.equal(request.init.body.includes(apiKey), false);
  assert.equal(request.init.body.includes(scannerSecret), false);
});

test('accepts only a 201 modern execution for the requested function and deployment', async () => {
  let captured;
  const verified = await executeAppwriteScannerChallenge(options(), async (url, init) => {
    captured = { url, init };
    return jsonResponse(execution());
  });
  assert.equal(verified, deploymentId);
  assert.equal(captured.url.endsWith(`/functions/${functionId}/executions`), true);
  assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.init.signal instanceof AbortSignal, true);
  assert.equal(captured.init.signal.aborted, false);
});

test('rejects legacy response-format fields with field-name-only diagnostics', async () => {
  const legacySecret = 'legacy-response-must-not-be-printed';
  const legacy = execution({
    responseStatusCode: undefined,
    responseBody: undefined,
    statusCode: 400,
    response: legacySecret,
  });
  await assert.rejects(
    executeAppwriteScannerChallenge(options(), async () => jsonResponse(legacy)),
    (error) => {
      assert.match(error.message, /mismatched fields: responseStatusCode, responseBody/);
      assert.doesNotMatch(error.message, /statusCode|legacy-response|invalid_job|400/);
      return true;
    },
  );
});

test('reports only mismatched modern field names and never provider values', async () => {
  const providerValue = 'provider-value-that-must-not-be-printed';
  await assert.rejects(
    executeAppwriteScannerChallenge(options(), async () =>
      jsonResponse(
        execution({
          functionId: providerValue,
          deploymentId: providerValue,
          requestPath: providerValue,
          responseBody: providerValue,
        }),
      ),
    ),
    (error) => {
      assert.match(error.message, /functionId/);
      assert.match(error.message, /deploymentId/);
      assert.match(error.message, /requestPath/);
      assert.match(error.message, /responseBody/);
      assert.match(error.message, /failure class: contract_mismatch/);
      assert.doesNotMatch(error.message, /provider-value|invalid_job/);
      return true;
    },
  );
});

test('classifies challenge failures without reflecting provider-controlled values', async () => {
  const providerSecret = `provider-detail ${apiKey} ${scannerSecret}`;
  const cases = [
    {
      expected: 'scanner_misconfigured',
      overrides: {
        status: 'failed',
        responseStatusCode: 500,
        responseBody: JSON.stringify({
          ok: false,
          error: { code: 'scanner_misconfigured' },
        }),
        errors: providerSecret,
      },
    },
    {
      expected: 'scanner_failure',
      overrides: {
        status: 'failed',
        responseStatusCode: 500,
        responseBody: JSON.stringify({ ok: false, error: { code: 'scanner_failure' } }),
        errors: providerSecret,
      },
    },
    {
      expected: 'runtime_load',
      overrides: {
        status: 'failed',
        responseStatusCode: 503,
        responseBody: '',
        errors: `Failed to load module: ${providerSecret}`,
      },
    },
    {
      expected: 'unknown_5xx',
      overrides: {
        status: 'failed',
        responseStatusCode: 500,
        responseBody: providerSecret,
        errors: providerSecret,
      },
    },
    {
      expected: 'unknown_5xx',
      overrides: {
        status: 'failed',
        responseStatusCode: 500,
        responseBody: JSON.stringify({
          ok: false,
          error: { code: 'scanner_failure', detail: providerSecret },
        }),
        errors: providerSecret,
      },
    },
    {
      expected: 'not_completed',
      overrides: {
        status: 'processing',
        responseStatusCode: 0,
        responseBody: '',
        errors: providerSecret,
      },
    },
  ];

  for (const { expected, overrides } of cases) {
    await assert.rejects(
      executeAppwriteScannerChallenge(options(), async () => jsonResponse(execution(overrides))),
      (error) => {
        assert.match(error.message, new RegExp(`failure class: ${expected}$`));
        assert.doesNotMatch(error.message, /provider-detail|scanner-deploy|scanner-test/);
        return true;
      },
    );
  }
});

test('requires exact pinned identifiers and credentials before making a request', async () => {
  const invalid = [
    { endpoint: 'https://fra.cloud.appwrite.io/v1/other' },
    { endpoint: 'https://example.test/v1' },
    { projectId: '../project' },
    { apiKey: '' },
    { functionId: '../function' },
    { scannerSecret: 'too-short' },
    { expectedDeploymentId: '../deployment' },
    { now: new Date(Number.NaN) },
    { timeoutMs: 0 },
  ];
  let requests = 0;
  for (const override of invalid) {
    await assert.rejects(
      executeAppwriteScannerChallenge(options(override), async () => {
        requests += 1;
        return jsonResponse(execution());
      }),
    );
  }
  assert.equal(requests, 0);
});

test('fails on non-201 responses without reading or disclosing the response body', async () => {
  const responseSecret = `provider-error ${apiKey} ${scannerSecret}`;
  await assert.rejects(
    executeAppwriteScannerChallenge(
      options(),
      async () => new Response(responseSecret, { status: 401 }),
    ),
    (error) => {
      assert.equal(error.message, 'Appwrite scanner challenge request failed with HTTP 401');
      assert.doesNotMatch(error.message, /provider-error|scanner-deploy|scanner-test/);
      return true;
    },
  );
});

test('bounds successful JSON responses before parsing', async () => {
  const oversized = JSON.stringify({ padding: 'x'.repeat(MAX_EXECUTION_RESPONSE_BYTES) });
  await assert.rejects(
    executeAppwriteScannerChallenge(
      options(),
      async () =>
        new Response(oversized, {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    ),
    /response exceeds the size limit/,
  );
  await assert.rejects(
    executeAppwriteScannerChallenge(
      options(),
      async () =>
        new Response('{}', {
          status: 201,
          headers: {
            'content-type': 'application/json',
            'content-length': String(MAX_EXECUTION_RESPONSE_BYTES + 1),
          },
        }),
    ),
    /response has an invalid size/,
  );
});

test('rejects truncated and overlong bodies against the declared content length', async () => {
  const body = JSON.stringify(execution());
  const actualLength = Buffer.byteLength(body);
  for (const declaredLength of [actualLength - 1, actualLength + 1]) {
    await assert.rejects(
      executeAppwriteScannerChallenge(
        options(),
        async () =>
          new Response(body, {
            status: 201,
            headers: {
              'content-type': 'application/json',
              'content-length': String(declaredLength),
            },
          }),
      ),
      /response did not match its declared size/,
    );
  }
});

test('rejects malformed response framing without reflecting content', async () => {
  const malformed = `not-json ${apiKey} ${scannerSecret}`;
  await assert.rejects(
    executeAppwriteScannerChallenge(
      options(),
      async () =>
        new Response(malformed, {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    ),
    (error) => {
      assert.equal(error.message, 'Appwrite scanner challenge response was not valid JSON');
      assert.doesNotMatch(error.message, /not-json|scanner-deploy|scanner-test/);
      return true;
    },
  );
  await assert.rejects(
    executeAppwriteScannerChallenge(
      options(),
      async () =>
        new Response(JSON.stringify(execution()), {
          status: 201,
          headers: { 'content-type': 'text/plain' },
        }),
    ),
    /response content-type is invalid/,
  );
});

test('redacts network failures and enforces the request timeout', async () => {
  await assert.rejects(
    executeAppwriteScannerChallenge(options(), async () => {
      throw new Error(`network failure ${apiKey} ${scannerSecret}`);
    }),
    (error) => {
      assert.equal(error.message, 'Appwrite scanner challenge request failed before a response');
      assert.doesNotMatch(error.message, /network failure|scanner-deploy|scanner-test/);
      return true;
    },
  );

  await assert.rejects(
    executeAppwriteScannerChallenge(
      options({ timeoutMs: 10 }),
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            'abort',
            () => reject(new Error(`timeout ${apiKey} ${scannerSecret}`)),
            { once: true },
          );
        }),
    ),
    (error) => {
      assert.equal(error.message, 'Appwrite scanner challenge request timed out');
      assert.doesNotMatch(error.message, /scanner-deploy|scanner-test/);
      return true;
    },
  );
});
