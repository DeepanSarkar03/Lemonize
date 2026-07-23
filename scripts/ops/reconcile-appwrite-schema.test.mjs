import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  parseJson,
  reconcileAppwriteSchema,
  validateConfig,
} from './reconcile-appwrite-schema.mjs';

const endpoint = 'https://appwrite.test/v1';
const projectId = 'test-project';
const apiKey = 'test-secret-key';

function schema() {
  return {
    projectId,
    tablesDB: [{ $id: 'registry', name: 'Registry', enabled: true }],
    buckets: [
      {
        $id: 'quarantine',
        $permissions: [],
        name: 'Quarantine',
        fileSecurity: true,
        enabled: true,
        maximumFileSize: 20_971_520,
        allowedFileExtensions: ['tgz'],
        compression: 'none',
        encryption: true,
        antivirus: true,
      },
    ],
    tables: [
      {
        $id: 'packages',
        databaseId: 'registry',
        name: 'Packages',
        $permissions: [],
        rowSecurity: false,
        enabled: true,
        columns: [
          {
            key: 'description',
            type: 'varchar',
            required: false,
            array: false,
            size: 512,
            default: null,
            encrypt: false,
          },
        ],
        indexes: [
          {
            key: 'packages_description',
            type: 'key',
            status: 'available',
            columns: ['description'],
            orders: [],
          },
        ],
      },
    ],
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function missing() {
  return json({ message: 'not found' }, 404);
}

function makeFake({ populated = false, drift = false, failColumn = false } = {}) {
  const desired = schema();
  const state = {
    database: populated ? { ...desired.tablesDB[0] } : null,
    bucket: populated ? { ...desired.buckets[0] } : null,
    table: populated
      ? {
          ...desired.tables[0],
          name: drift ? 'Wrong name' : desired.tables[0].name,
          columns: [{ ...desired.tables[0].columns[0], status: 'available', error: '' }],
          indexes: [{ ...desired.tables[0].indexes[0], status: 'available', error: '' }],
        }
      : null,
    column: null,
    index: null,
    columnReads: 0,
    indexReads: 0,
  };
  const calls = [];

  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    const method = init.method;
    const path = url.pathname.replace(/^\/v1/, '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path, body, apiKey: init.headers['X-Appwrite-Key'] });

    if (method === 'GET' && path === '/tablesdb/registry') {
      return state.database ? json(state.database) : missing();
    }
    if (method === 'POST' && path === '/tablesdb') {
      state.database = { $id: body.databaseId, name: body.name, enabled: body.enabled };
      return json(state.database, 201);
    }
    if (method === 'GET' && path === '/storage/buckets/quarantine') {
      return state.bucket ? json(state.bucket) : missing();
    }
    if (method === 'POST' && path === '/storage/buckets') {
      state.bucket = { $id: body.bucketId, ...body };
      delete state.bucket.bucketId;
      state.bucket.$permissions = body.permissions;
      delete state.bucket.permissions;
      return json(state.bucket, 201);
    }
    if (method === 'GET' && path === '/tablesdb/registry/tables/packages') {
      return state.table ? json(state.table) : missing();
    }
    if (method === 'POST' && path === '/tablesdb/registry/tables') {
      state.table = {
        $id: body.tableId,
        name: body.name,
        $permissions: body.permissions,
        rowSecurity: body.rowSecurity,
        enabled: body.enabled,
        columns: [],
        indexes: [],
      };
      return json(state.table, 201);
    }
    if (method === 'POST' && path === '/tablesdb/registry/tables/packages/columns/varchar') {
      state.column = {
        ...body,
        type: 'varchar',
        default: body.default ?? null,
        status: failColumn ? 'failed' : 'processing',
        error: failColumn ? 'simulated build failure' : '',
      };
      return json(state.column, 202);
    }
    if (method === 'GET' && path === '/tablesdb/registry/tables/packages/columns/description') {
      if (!state.column) return missing();
      state.columnReads += 1;
      if (!failColumn && state.columnReads >= 2) state.column.status = 'available';
      return json(state.column);
    }
    if (method === 'POST' && path === '/tablesdb/registry/tables/packages/indexes') {
      state.index = { ...body, status: 'processing', error: '' };
      return json(state.index, 202);
    }
    if (
      method === 'GET' &&
      path === '/tablesdb/registry/tables/packages/indexes/packages_description'
    ) {
      if (!state.index) return missing();
      state.indexReads += 1;
      if (state.indexReads >= 2) state.index.status = 'available';
      return json(state.index);
    }
    throw new Error(`Unexpected fake request: ${method} ${path}`);
  };

  return { fetchImpl, calls, state };
}

function run(config, fake, overrides = {}) {
  return reconcileAppwriteSchema({
    config,
    endpoint,
    projectId,
    apiKey,
    fetchImpl: fake.fetchImpl,
    sleep: async () => {},
    logger: { info() {} },
    limits: { pollAttempts: 5, pollTimeoutMs: 1_000 },
    ...overrides,
  });
}

test('creates absent resources through POST-only additive operations and waits for async schema work', async () => {
  const fake = makeFake();
  const result = await run(schema(), fake);

  assert.deepEqual(result, { created: 5, verified: 0, planned: 0 });
  assert.deepEqual(
    fake.calls.filter((call) => call.method === 'POST').map((call) => call.path),
    [
      '/tablesdb',
      '/storage/buckets',
      '/tablesdb/registry/tables',
      '/tablesdb/registry/tables/packages/columns/varchar',
      '/tablesdb/registry/tables/packages/indexes',
    ],
  );
  assert.equal(
    fake.calls.some((call) => ['PATCH', 'PUT', 'DELETE'].includes(call.method)),
    false,
  );
  assert.equal(
    fake.calls.every((call) => call.apiKey === apiKey),
    true,
  );
});

test('is idempotent when every resource already matches', async () => {
  const fake = makeFake({ populated: true });
  const result = await run(schema(), fake);

  assert.deepEqual(result, { created: 0, verified: 5, planned: 0 });
  assert.equal(
    fake.calls.some((call) => call.method !== 'GET'),
    false,
  );
});

test('stops on existing non-additive drift without writing', async () => {
  const fake = makeFake({ populated: true, drift: true });

  await assert.rejects(
    run(schema(), fake),
    /table registry\/packages has non-additive drift in: name/,
  );
  assert.equal(
    fake.calls.some((call) => call.method !== 'GET'),
    false,
  );
});

test('fails closed when an asynchronous column build enters a terminal state', async () => {
  const desired = schema();
  const fake = makeFake({ failColumn: true });

  await assert.rejects(run(desired, fake), /terminal status failed: simulated build failure/);
  assert.equal(fake.calls.filter((call) => call.path.endsWith('/columns/description')).length, 1);
  assert.equal(
    fake.calls.some((call) => ['PATCH', 'PUT', 'DELETE'].includes(call.method)),
    false,
  );
});

test('dry-run reports the complete creation plan without sending writes', async () => {
  const fake = makeFake();
  const result = await run(schema(), fake, { dryRun: true });

  assert.deepEqual(result, { created: 0, verified: 0, planned: 5 });
  assert.equal(
    fake.calls.some((call) => call.method !== 'GET'),
    false,
  );
});

test('requires an explicit migration for a missing required column on an existing table', async () => {
  const desired = schema();
  desired.tables[0].columns[0].required = true;
  const fake = makeFake({ populated: true });
  fake.state.table.columns = [];
  fake.state.table.indexes = [];

  await assert.rejects(run(desired, fake), /an explicit data migration is required/);
  assert.equal(
    fake.calls.some((call) => call.method !== 'GET'),
    false,
  );
});

test('preserves 64-bit integer bounds when parsing and serializing schema JSON', () => {
  const source = '{"min":-9223372036854775808,"max":9223372036854775807}';
  assert.equal(JSON.stringify(parseJson(source)), source);
});

for (const environment of ['staging', 'production']) {
  test(`accepts the complete checked-in ${environment} schema`, async () => {
    const config = parseJson(
      await readFile(
        new URL(
          `../../infrastructure/appwrite/${environment}/appwrite.config.json`,
          import.meta.url,
        ),
        'utf8',
      ),
    );
    assert.doesNotThrow(() => validateConfig(config, config.projectId));
  });
}
