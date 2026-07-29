import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runScannerStorageCanary,
  verifyScannerKeyAttestation,
} from './verify-appwrite-scanner-storage-key.mjs';

const apiKey = 'scanner-storage-secret-that-must-never-be-printed';
const now = new Date('2026-07-29T00:00:00.000Z');
const baseAttestation = {
  environment: 'staging',
  projectId: 'lemonize-staging-2026',
  keyId: 'scanner-storage-key-20260728',
  scopes: ['files.read', 'files.write'],
  createdAt: '2026-07-28T00:00:00.000Z',
  expiresAt: '2026-08-28T00:00:00.000Z',
  reviewer: 'security-reviewer',
};

const attestationOptions = (overrides = {}) => ({
  attestationJson: JSON.stringify(baseAttestation),
  environment: 'staging',
  projectId: 'lemonize-staging-2026',
  keyId: 'scanner-storage-key-20260728',
  now,
  ...overrides,
});

const canaryOptions = (overrides = {}) => ({
  endpoint: 'https://fra.cloud.appwrite.io/v1',
  projectId: 'lemonize-staging-2026',
  apiKey,
  bucketId: 'quarantine',
  randomBytesImpl: () => Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
  ...overrides,
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function storageApi({ mismatchedDownload = false, cleanupStatus = 204 } = {}) {
  const calls = [];
  let stored;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.equal(
      url.startsWith('https://fra.cloud.appwrite.io/v1/storage/buckets/quarantine/'),
      true,
    );
    assert.equal(url.includes(apiKey), false);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['x-appwrite-key'], apiKey);
    assert.equal(init.headers['x-appwrite-project'], 'lemonize-staging-2026');
    assert.equal(init.headers['x-appwrite-response-format'], '1.9.5');
    assert.equal(init.signal instanceof AbortSignal, true);

    if (init.method === 'POST') {
      assert.equal(url, 'https://fra.cloud.appwrite.io/v1/storage/buckets/quarantine/files');
      assert.equal(init.body instanceof FormData, true);
      const fileId = init.body.get('fileId');
      const file = init.body.get('file');
      assert.equal(file instanceof Blob, true);
      assert.equal(file.name.endsWith('.tgz'), true);
      assert.equal(file.type, 'application/gzip');
      stored = {
        fileId,
        fileName: file.name,
        content: Buffer.from(await file.arrayBuffer()),
      };
      assert.deepEqual([...stored.content.subarray(0, 2)], [0x1f, 0x8b]);
      return jsonResponse(
        {
          $id: stored.fileId,
          bucketId: 'quarantine',
          name: stored.fileName,
          sizeOriginal: stored.content.byteLength,
        },
        201,
      );
    }
    if (init.method === 'DELETE') {
      if (cleanupStatus !== 204) {
        return new Response(`provider cleanup detail ${apiKey}`, { status: cleanupStatus });
      }
      stored = undefined;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/download')) {
      assert.ok(stored);
      return new Response(
        mismatchedDownload ? Buffer.from('wrong canary content') : stored.content,
        {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        },
      );
    }
    if (!stored) return new Response(null, { status: 404 });
    return jsonResponse({
      $id: stored.fileId,
      bucketId: 'quarantine',
      name: stored.fileName,
      sizeOriginal: stored.content.byteLength,
    });
  };
  return { calls, fetchImpl, getStored: () => stored };
}

test('accepts only a current exact-scope key attestation for the protected environment', () => {
  const result = verifyScannerKeyAttestation(attestationOptions());
  assert.deepEqual(result, baseAttestation);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.scopes), true);
});

test('rejects attestation drift, extra scopes, stale records, and unreasonable dates', () => {
  const cases = [
    { environment: 'production' },
    { projectId: 'lemonize-production-2026' },
    { keyId: 'different-key-id' },
    { scopes: ['files.write', 'files.read'] },
    { scopes: ['files.read', 'files.write', 'keys.read'] },
    { expiresAt: '2026-07-29T00:00:00.000Z' },
    { createdAt: '2026-07-29T00:06:00.000Z' },
    { expiresAt: '2026-11-01T00:00:00.000Z' },
    { reviewer: '' },
    { extra: true },
  ];
  for (const drift of cases) {
    assert.throws(
      () =>
        verifyScannerKeyAttestation(
          attestationOptions({
            attestationJson: JSON.stringify({ ...baseAttestation, ...drift }),
          }),
        ),
      /Scanner key attestation/,
    );
  }
  assert.throws(
    () => verifyScannerKeyAttestation(attestationOptions({ attestationJson: '{' })),
    /not valid JSON/,
  );
});

test('creates, reads, byte-checks, deletes, and confirms cleanup in the exact bucket', async () => {
  const api = storageApi();
  assert.equal(await runScannerStorageCanary(canaryOptions(), api.fetchImpl), true);
  assert.equal(api.getStored(), undefined);
  assert.deepEqual(
    api.calls.map(({ init }) => init.method),
    ['GET', 'POST', 'GET', 'GET', 'DELETE', 'GET'],
  );
  assert.equal(api.calls[3].url.endsWith('/download'), true);
  assert.equal(api.calls[1].init.body.get('fileId'), 'lemcanary-00112233445566778899aabb');
  assert.equal(api.calls[1].init.body.get('file').name, 'lemcanary-00112233445566778899aabb.tgz');
  assert.equal(api.calls[1].init.body.get('file').size <= 256, true);
});

test('fails closed and still removes a canary after a read mismatch', async () => {
  const api = storageApi({ mismatchedDownload: true });
  await assert.rejects(
    runScannerStorageCanary(canaryOptions(), api.fetchImpl),
    /downloaded content did not match/,
  );
  assert.equal(api.getStored(), undefined);
  assert.deepEqual(
    api.calls.map(({ init }) => init.method),
    ['GET', 'POST', 'GET', 'GET', 'DELETE', 'GET'],
  );
});

test('fails deployment when cleanup cannot be confirmed without reflecting provider output', async () => {
  const api = storageApi({ mismatchedDownload: true, cleanupStatus: 500 });
  await assert.rejects(runScannerStorageCanary(canaryOptions(), api.fetchImpl), (error) => {
    assert.equal(error.message, 'Appwrite storage canary cleanup could not be confirmed');
    assert.doesNotMatch(error.message, /provider cleanup|scanner-storage-secret/);
    return true;
  });
  assert.ok(api.getStored());
});

test('never reads or reflects provider error bodies and rejects unpinned inputs before fetch', async () => {
  let requests = 0;
  await assert.rejects(
    runScannerStorageCanary(canaryOptions(), async (_url, init) => {
      requests += 1;
      if (init.method === 'GET') return new Response(null, { status: 404 });
      return new Response(`provider create detail ${apiKey}`, { status: 401 });
    }),
    (error) => {
      assert.equal(error.message, 'Appwrite storage canary create failed with HTTP 401');
      assert.doesNotMatch(error.message, /provider create|scanner-storage-secret/);
      return true;
    },
  );
  assert.equal(requests, 2);

  for (const overrides of [
    { endpoint: 'https://example.test/v1' },
    { projectId: '../project' },
    { bucketId: '../bucket' },
    { apiKey: '' },
    { timeoutMs: 0 },
  ]) {
    await assert.rejects(
      runScannerStorageCanary(canaryOptions(overrides), async () => {
        requests += 1;
        return new Response(null, { status: 500 });
      }),
    );
  }
  assert.equal(requests, 2);
});

test('cleans up an upload that may have completed before a network failure', async () => {
  const api = storageApi();
  let failedCreate = false;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST' && !failedCreate) {
      failedCreate = true;
      await api.fetchImpl(url, init);
      throw new Error(`network detail ${apiKey}`);
    }
    return api.fetchImpl(url, init);
  };
  await assert.rejects(runScannerStorageCanary(canaryOptions(), fetchImpl), (error) => {
    assert.equal(error.message, 'Appwrite storage canary create failed before a response');
    assert.doesNotMatch(error.message, /network detail|scanner-storage-secret/);
    return true;
  });
  assert.equal(api.getStored(), undefined);
});

test('always confirms absence after DELETE 404 or a lost timed-out DELETE response', async () => {
  for (const mode of ['not-found', 'timeout']) {
    const api = storageApi();
    const fetchImpl = async (url, init) => {
      if (init.method !== 'DELETE') return api.fetchImpl(url, init);
      await api.fetchImpl(url, init);
      if (mode === 'not-found') return new Response(null, { status: 404 });
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error(`lost ${apiKey}`)), {
          once: true,
        });
      });
    };
    assert.equal(await runScannerStorageCanary(canaryOptions({ timeoutMs: 10 }), fetchImpl), true);
    assert.equal(api.getStored(), undefined);
    assert.equal(api.calls.at(-1).init.method, 'GET');
  }
});

test('accepts DELETE 404 plus GET 404 after an uncertain create attempt', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init.method);
    if (init.method === 'POST') {
      const file = init.body.get('file');
      const content = Buffer.from(await file.arrayBuffer());
      assert.equal(file.name.endsWith('.tgz'), true);
      assert.equal(file.type, 'application/gzip');
      assert.deepEqual([...content.subarray(0, 2)], [0x1f, 0x8b]);
      throw new Error(`uncertain create ${apiKey}`);
    }
    if (init.method === 'DELETE') return new Response(null, { status: 404 });
    return new Response(null, { status: 404 });
  };
  await assert.rejects(runScannerStorageCanary(canaryOptions(), fetchImpl), (error) => {
    assert.equal(error.message, 'Appwrite storage canary create failed before a response');
    assert.doesNotMatch(error.message, /uncertain create|scanner-storage-secret/);
    return true;
  });
  assert.deepEqual(calls, ['GET', 'POST', 'DELETE', 'GET']);
});

test('fails closed on redirects and request timeouts without reflecting network details', async () => {
  await assert.rejects(
    runScannerStorageCanary(
      canaryOptions(),
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://redirect.test/${apiKey}` },
        }),
    ),
    (error) => {
      assert.equal(error.message, 'Appwrite storage canary collision check failed with HTTP 302');
      assert.doesNotMatch(error.message, /redirect\.test|scanner-storage-secret/);
      return true;
    },
  );

  await assert.rejects(
    runScannerStorageCanary(canaryOptions({ timeoutMs: 10 }), async (_url, init) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error(`network ${apiKey}`)), {
          once: true,
        });
      });
    }),
    (error) => {
      assert.equal(error.message, 'Appwrite storage canary collision check timed out');
      assert.doesNotMatch(error.message, /network|scanner-storage-secret/);
      return true;
    },
  );
});

test('bounds and frames provider bodies, then cleans every possibly created file', async () => {
  for (const mode of ['oversized', 'partial']) {
    const api = storageApi();
    const fetchImpl = async (url, init) => {
      const response = await api.fetchImpl(url, init);
      if (init.method !== 'POST') return response;
      const body = JSON.stringify({ ok: true });
      return new Response(body, {
        status: 201,
        headers: {
          'content-type': 'application/json',
          'content-length': mode === 'oversized' ? String(16 * 1024 + 1) : String(body.length + 1),
        },
      });
    };
    await assert.rejects(
      runScannerStorageCanary(canaryOptions(), fetchImpl),
      mode === 'oversized' ? /response has an invalid size/ : /size did not match its header/,
    );
    assert.equal(api.getStored(), undefined);
    assert.deepEqual(
      api.calls.slice(-2).map(({ init }) => init.method),
      ['DELETE', 'GET'],
    );
  }
});

test('cleans up after every validation or HTTP failure following successful create', async () => {
  for (const mode of [
    'create-metadata',
    'metadata-status',
    'metadata-mismatch',
    'download-status',
    'download-mismatch',
  ]) {
    const api = storageApi();
    let metadataReads = 0;
    const fetchImpl = async (url, init) => {
      const response = await api.fetchImpl(url, init);
      if (mode === 'create-metadata' && init.method === 'POST') {
        return jsonResponse(
          {
            $id: 'wrong-id',
            bucketId: 'quarantine',
            name: 'wrong.tgz',
            sizeOriginal: 1,
          },
          201,
        );
      }
      if (init.method === 'GET' && !url.endsWith('/download') && api.getStored()) {
        metadataReads += 1;
        if (mode === 'metadata-status' && metadataReads === 1) {
          return new Response(`metadata provider detail ${apiKey}`, { status: 500 });
        }
        if (mode === 'metadata-mismatch' && metadataReads === 1) {
          return jsonResponse({
            $id: 'wrong-id',
            bucketId: 'quarantine',
            name: 'wrong.tgz',
            sizeOriginal: 1,
          });
        }
      }
      if (url.endsWith('/download')) {
        if (mode === 'download-status') {
          return new Response(`download provider detail ${apiKey}`, { status: 500 });
        }
        if (mode === 'download-mismatch') return new Response('not-the-canary', { status: 200 });
      }
      return response;
    };
    await assert.rejects(runScannerStorageCanary(canaryOptions(), fetchImpl), (error) => {
      assert.doesNotMatch(error.message, /provider detail|scanner-storage-secret/);
      return true;
    });
    assert.equal(api.getStored(), undefined, mode);
    assert.deepEqual(
      api.calls.slice(-2).map(({ init }) => init.method),
      ['DELETE', 'GET'],
      mode,
    );
  }
});
