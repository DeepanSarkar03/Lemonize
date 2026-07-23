#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SUPPORTED_ENVIRONMENTS = new Set(['staging', 'production']);
const SUPPORTED_COLUMN_TYPES = new Set(['varchar', 'integer', 'datetime', 'longtext']);
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const defaults = Object.freeze({
  requestTimeoutMs: 15_000,
  readAttempts: 3,
  createAttempts: 3,
  presentAttempts: 6,
  pollAttempts: 60,
  pollTimeoutMs: 90_000,
});

class AppwriteHttpError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'AppwriteHttpError';
    this.status = status;
    this.retryable = retryable;
  }
}

function parseJson(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      !Number.isSafeInteger(value) &&
      context?.source
    ) {
      return JSON.rawJSON(context.source);
    }
    return value;
  });
}

function delayFor(attempt) {
  return Math.min(250 * 2 ** attempt, 2_000);
}

function cleanErrorMessage(value, secret) {
  const message = value instanceof Error ? value.message : String(value);
  return secret ? message.split(secret).join('[redacted]') : message;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertUnique(items, keyFor, label) {
  const seen = new Set();
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) throw new Error(`Duplicate ${label}: ${key}`);
    seen.add(key);
  }
}

function validateConfig(config, projectId) {
  if (!config || typeof config !== 'object') throw new Error('Appwrite config must be an object');
  if (config.projectId !== projectId) {
    throw new Error(
      `Config project ${config.projectId ?? '(missing)'} does not match APPWRITE_PROJECT_ID`,
    );
  }
  for (const key of ['tablesDB', 'tables', 'buckets']) {
    if (!Array.isArray(config[key])) throw new Error(`Appwrite config ${key} must be an array`);
  }

  assertUnique(
    config.tablesDB,
    (database) => requiredString(database.$id, 'database.$id'),
    'database ID',
  );
  assertUnique(
    config.tables,
    (table) =>
      `${requiredString(table.databaseId, 'table.databaseId')}/${requiredString(table.$id, 'table.$id')}`,
    'table ID',
  );
  assertUnique(config.buckets, (bucket) => requiredString(bucket.$id, 'bucket.$id'), 'bucket ID');

  const databaseIds = new Set(config.tablesDB.map((database) => database.$id));
  for (const database of config.tablesDB) {
    requiredString(database.name, `database ${database.$id} name`);
    if (typeof database.enabled !== 'boolean')
      throw new Error(`database ${database.$id} enabled must be boolean`);
  }

  for (const table of config.tables) {
    const label = `table ${table.databaseId}/${table.$id}`;
    if (!databaseIds.has(table.databaseId))
      throw new Error(`${label} references an undeclared database`);
    requiredString(table.name, `${label} name`);
    if (!Array.isArray(table.$permissions))
      throw new Error(`${label} permissions must be an array`);
    if (!Array.isArray(table.columns) || !Array.isArray(table.indexes)) {
      throw new Error(`${label} columns and indexes must be arrays`);
    }
    assertUnique(
      table.columns,
      (column) => requiredString(column.key, `${label} column key`),
      `${label} column`,
    );
    assertUnique(
      table.indexes,
      (index) => requiredString(index.key, `${label} index key`),
      `${label} index`,
    );
    const columnKeys = new Set(table.columns.map((column) => column.key));
    for (const column of table.columns) {
      if (!SUPPORTED_COLUMN_TYPES.has(column.type)) {
        throw new Error(`${label} column ${column.key} has unsupported type ${column.type}`);
      }
      if (typeof column.required !== 'boolean' || typeof column.array !== 'boolean') {
        throw new Error(`${label} column ${column.key} required and array must be boolean`);
      }
      if (column.required && column.default != null) {
        throw new Error(`${label} column ${column.key} cannot be required and have a default`);
      }
      if (column.type === 'varchar' && (!Number.isSafeInteger(column.size) || column.size < 1)) {
        throw new Error(`${label} column ${column.key} has an invalid varchar size`);
      }
    }
    for (const index of table.indexes) {
      if (!['key', 'unique', 'fulltext'].includes(index.type)) {
        throw new Error(`${label} index ${index.key} has unsupported type ${index.type}`);
      }
      if (!Array.isArray(index.columns) || index.columns.length === 0) {
        throw new Error(`${label} index ${index.key} must contain columns`);
      }
      for (const column of index.columns) {
        if (!columnKeys.has(column))
          throw new Error(`${label} index ${index.key} references missing column ${column}`);
      }
    }
  }

  for (const bucket of config.buckets) {
    const label = `bucket ${bucket.$id}`;
    requiredString(bucket.name, `${label} name`);
    if (!Array.isArray(bucket.$permissions) || !Array.isArray(bucket.allowedFileExtensions)) {
      throw new Error(`${label} permissions and allowedFileExtensions must be arrays`);
    }
    if (!Number.isSafeInteger(bucket.maximumFileSize) || bucket.maximumFileSize < 1) {
      throw new Error(`${label} maximumFileSize must be a positive safe integer`);
    }
  }
}

function validateEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  ) {
    throw new Error(
      'APPWRITE_ENDPOINT must be an HTTPS URL without credentials, query, or fragment',
    );
  }
  return url.toString().replace(/\/+$/, '');
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertExact(label, actual, expected) {
  const mismatches = Object.keys(expected).filter((key) => !sameValue(actual[key], expected[key]));
  if (mismatches.length > 0) {
    throw new Error(`${label} has non-additive drift in: ${mismatches.join(', ')}`);
  }
}

function databaseShape(value) {
  return { $id: value.$id, name: value.name, enabled: value.enabled };
}

function tableShape(value) {
  return {
    $id: value.$id,
    name: value.name,
    $permissions: value.$permissions ?? [],
    rowSecurity: value.rowSecurity,
    enabled: value.enabled,
  };
}

function bucketShape(value) {
  return {
    $id: value.$id,
    name: value.name,
    $permissions: value.$permissions ?? [],
    fileSecurity: value.fileSecurity,
    enabled: value.enabled,
    maximumFileSize: value.maximumFileSize,
    allowedFileExtensions: value.allowedFileExtensions ?? [],
    compression: value.compression,
    encryption: value.encryption,
    antivirus: value.antivirus,
  };
}

function columnShape(value) {
  const shape = {
    key: value.key,
    type: value.type,
    required: value.required,
    array: value.array ?? false,
    default: value.default ?? null,
  };
  if (value.type === 'varchar') {
    shape.size = value.size;
    shape.encrypt = value.encrypt ?? false;
  } else if (value.type === 'integer') {
    shape.min = value.min ?? null;
    shape.max = value.max ?? null;
  } else if (value.type === 'datetime') {
    shape.format = value.format ?? '';
  } else if (value.type === 'longtext') {
    shape.encrypt = value.encrypt ?? false;
  }
  return shape;
}

function indexShape(value) {
  return {
    key: value.key,
    type: value.type,
    columns: value.columns ?? [],
    orders: value.orders ?? [],
  };
}

function columnPayload(column) {
  const payload = {
    key: column.key,
    required: column.required,
    array: column.array,
  };
  if (column.default != null) payload.default = column.default;
  if (column.type === 'varchar') {
    payload.size = column.size;
    payload.encrypt = column.encrypt ?? false;
  } else if (column.type === 'integer') {
    if (column.min != null) payload.min = column.min;
    if (column.max != null) payload.max = column.max;
  } else if (column.type === 'longtext') {
    payload.encrypt = column.encrypt ?? false;
  }
  return payload;
}

function createClient({ endpoint, projectId, apiKey, fetchImpl, sleep, options }) {
  async function request(method, path, body, { retryReads = method === 'GET' } = {}) {
    const attempts = retryReads ? options.readAttempts : 1;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetchImpl(`${endpoint}${path}`, {
          method,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'lemonize-schema-reconciler/1.0',
            'X-Appwrite-Project': projectId,
            'X-Appwrite-Key': apiKey,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(options.requestTimeoutMs),
        });
        const text = await response.text();
        let payload = null;
        if (text) {
          try {
            payload = parseJson(text);
          } catch {
            throw new AppwriteHttpError(`Appwrite returned invalid JSON for ${method} ${path}`, {
              status: response.status,
              retryable: RETRYABLE_STATUSES.has(response.status),
            });
          }
        }
        if (!response.ok) {
          const detail =
            typeof payload?.message === 'string' ? `: ${payload.message.slice(0, 300)}` : '';
          throw new AppwriteHttpError(
            `Appwrite ${method} ${path} failed with HTTP ${response.status}${detail}`,
            {
              status: response.status,
              retryable: RETRYABLE_STATUSES.has(response.status),
            },
          );
        }
        return payload;
      } catch (error) {
        lastError =
          error instanceof AppwriteHttpError
            ? error
            : new AppwriteHttpError(`Appwrite ${method} ${path} request failed`, {
                retryable: true,
              });
        if (attempt + 1 >= attempts || !lastError.retryable) throw lastError;
        await sleep(delayFor(attempt));
      }
    }
    throw lastError;
  }

  async function getOrNull(path) {
    try {
      return await request('GET', path);
    } catch (error) {
      if (error instanceof AppwriteHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async function waitUntilPresent(path) {
    for (let attempt = 0; attempt < options.presentAttempts; attempt += 1) {
      const value = await getOrNull(path);
      if (value) return value;
      if (attempt + 1 < options.presentAttempts) await sleep(delayFor(attempt));
    }
    return null;
  }

  async function createAndRead({ path, body, readPath, label }) {
    let lastError;
    for (let attempt = 0; attempt < options.createAttempts; attempt += 1) {
      let acceptedByThisRun = false;
      try {
        await request('POST', path, body, { retryReads: false });
        acceptedByThisRun = true;
      } catch (error) {
        lastError = error;
        const convergent =
          error instanceof AppwriteHttpError && (error.status === 409 || error.retryable);
        if (!convergent) throw error;
      }

      const value = await waitUntilPresent(readPath);
      if (value) return { value, acceptedByThisRun };
      if (attempt + 1 < options.createAttempts) await sleep(delayFor(attempt));
    }
    if (lastError) throw lastError;
    throw new Error(`${label} was accepted but did not become readable`);
  }

  return { request, getOrNull, createAndRead };
}

async function waitForAvailable({ client, path, initial, label, sleep, options }) {
  let value = initial;
  const deadline = Date.now() + options.pollTimeoutMs;
  for (let attempt = 0; attempt < options.pollAttempts; attempt += 1) {
    if (!value || attempt > 0) value = await client.request('GET', path);
    if (!value.status || value.status === 'available') return value;
    if (['failed', 'stuck', 'deleting'].includes(value.status)) {
      const detail =
        typeof value.error === 'string' && value.error ? `: ${value.error.slice(0, 300)}` : '';
      throw new Error(`${label} entered terminal status ${value.status}${detail}`);
    }
    if (Date.now() >= deadline || attempt + 1 >= options.pollAttempts) {
      throw new Error(`${label} did not become available within the bounded polling window`);
    }
    await sleep(delayFor(attempt));
  }
  throw new Error(`${label} did not become available`);
}

export async function reconcileAppwriteSchema({
  config,
  endpoint,
  projectId,
  apiKey,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
  logger = console,
  limits = {},
}) {
  requiredString(projectId, 'APPWRITE_PROJECT_ID');
  requiredString(apiKey, 'APPWRITE_DEPLOY_API_KEY');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  const normalizedEndpoint = validateEndpoint(endpoint);
  validateConfig(config, projectId);
  const options = { ...defaults, ...limits };
  for (const [key, value] of Object.entries(options)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`${key} must be a positive safe integer`);
  }

  const client = createClient({
    endpoint: normalizedEndpoint,
    projectId,
    apiKey,
    fetchImpl,
    sleep,
    options,
  });
  const summary = { created: 0, verified: 0, planned: 0 };
  const encoded = (value) => encodeURIComponent(value);
  const note = (action, label) => logger.info(`${dryRun ? '[dry-run] ' : ''}${action} ${label}`);

  async function ensureSimple({ label, getPath, createPath, body, expected, shape }) {
    const actual = await client.getOrNull(getPath);
    if (actual) {
      assertExact(label, shape(actual), shape(expected));
      summary.verified += 1;
      note('verified', label);
      return { value: actual, created: false };
    }
    if (dryRun) {
      summary.planned += 1;
      note('would create', label);
      return { value: null, created: true };
    }
    const creation = await client.createAndRead({
      path: createPath,
      body,
      readPath: getPath,
      label,
    });
    assertExact(label, shape(creation.value), shape(expected));
    summary[creation.acceptedByThisRun ? 'created' : 'verified'] += 1;
    note(creation.acceptedByThisRun ? 'created' : 'verified after concurrent creation', label);
    return { value: creation.value, created: creation.acceptedByThisRun };
  }

  for (const database of config.tablesDB) {
    const databasePath = `/tablesdb/${encoded(database.$id)}`;
    await ensureSimple({
      label: `database ${database.$id}`,
      getPath: databasePath,
      createPath: '/tablesdb',
      body: { databaseId: database.$id, name: database.name, enabled: database.enabled },
      expected: database,
      shape: databaseShape,
    });
  }

  for (const bucket of config.buckets) {
    const bucketPath = `/storage/buckets/${encoded(bucket.$id)}`;
    await ensureSimple({
      label: `bucket ${bucket.$id}`,
      getPath: bucketPath,
      createPath: '/storage/buckets',
      body: {
        bucketId: bucket.$id,
        name: bucket.name,
        permissions: bucket.$permissions,
        fileSecurity: bucket.fileSecurity,
        enabled: bucket.enabled,
        maximumFileSize: bucket.maximumFileSize,
        allowedFileExtensions: bucket.allowedFileExtensions,
        compression: bucket.compression,
        encryption: bucket.encryption,
        antivirus: bucket.antivirus,
      },
      expected: bucket,
      shape: bucketShape,
    });
  }

  for (const table of config.tables) {
    const databaseId = encoded(table.databaseId);
    const tableId = encoded(table.$id);
    const tablePath = `/tablesdb/${databaseId}/tables/${tableId}`;
    const tableResult = await ensureSimple({
      label: `table ${table.databaseId}/${table.$id}`,
      getPath: tablePath,
      createPath: `/tablesdb/${databaseId}/tables`,
      body: {
        tableId: table.$id,
        name: table.name,
        permissions: table.$permissions,
        rowSecurity: table.rowSecurity,
        enabled: table.enabled,
      },
      expected: table,
      shape: tableShape,
    });
    const currentColumns = new Map(
      (tableResult.value?.columns ?? []).map((column) => [column.key, column]),
    );

    for (const column of table.columns) {
      const label = `column ${table.databaseId}/${table.$id}/${column.key}`;
      const columnPath = `${tablePath}/columns/${encoded(column.key)}`;
      let actual = currentColumns.get(column.key) ?? null;
      if (actual) {
        actual = await waitForAvailable({
          client,
          path: columnPath,
          initial: actual,
          label,
          sleep,
          options,
        });
        assertExact(label, columnShape(actual), columnShape(column));
        summary.verified += 1;
        note('verified', label);
        continue;
      }
      if (!tableResult.created && column.required && column.default == null) {
        throw new Error(
          `${label} is a missing required column without a default; an explicit data migration is required`,
        );
      }
      if (dryRun) {
        summary.planned += 1;
        note('would create', label);
        continue;
      }
      const creation = await client.createAndRead({
        path: `${tablePath}/columns/${encoded(column.type)}`,
        body: columnPayload(column),
        readPath: columnPath,
        label,
      });
      actual = creation.value;
      actual = await waitForAvailable({
        client,
        path: columnPath,
        initial: actual,
        label,
        sleep,
        options,
      });
      assertExact(label, columnShape(actual), columnShape(column));
      summary[creation.acceptedByThisRun ? 'created' : 'verified'] += 1;
      note(creation.acceptedByThisRun ? 'created' : 'verified after concurrent creation', label);
    }

    const currentIndexes = new Map(
      (tableResult.value?.indexes ?? []).map((index) => [index.key, index]),
    );
    for (const index of table.indexes) {
      const label = `index ${table.databaseId}/${table.$id}/${index.key}`;
      const indexPath = `${tablePath}/indexes/${encoded(index.key)}`;
      let actual = currentIndexes.get(index.key) ?? null;
      if (actual) {
        actual = await waitForAvailable({
          client,
          path: indexPath,
          initial: actual,
          label,
          sleep,
          options,
        });
        assertExact(label, indexShape(actual), indexShape(index));
        summary.verified += 1;
        note('verified', label);
        continue;
      }
      if (dryRun) {
        summary.planned += 1;
        note('would create', label);
        continue;
      }
      const creation = await client.createAndRead({
        path: `${tablePath}/indexes`,
        body: {
          key: index.key,
          type: index.type,
          columns: index.columns,
          orders: index.orders ?? [],
        },
        readPath: indexPath,
        label,
      });
      actual = creation.value;
      actual = await waitForAvailable({
        client,
        path: indexPath,
        initial: actual,
        label,
        sleep,
        options,
      });
      assertExact(label, indexShape(actual), indexShape(index));
      summary[creation.acceptedByThisRun ? 'created' : 'verified'] += 1;
      note(creation.acceptedByThisRun ? 'created' : 'verified after concurrent creation', label);
    }
  }

  logger.info(
    `Appwrite schema reconcile complete: ${summary.created} created, ${summary.verified} verified, ${summary.planned} planned`,
  );
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const environment = args.find((argument) => !argument.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const unknownFlags = args.filter(
    (argument) => argument.startsWith('--') && argument !== '--dry-run',
  );
  if (!SUPPORTED_ENVIRONMENTS.has(environment) || unknownFlags.length > 0) {
    throw new Error('usage: reconcile-appwrite-schema.mjs <staging|production> [--dry-run]');
  }
  const projectId = requiredString(process.env.APPWRITE_PROJECT_ID, 'APPWRITE_PROJECT_ID');
  const apiKey = requiredString(process.env.APPWRITE_DEPLOY_API_KEY, 'APPWRITE_DEPLOY_API_KEY');
  const endpoint = requiredString(process.env.APPWRITE_ENDPOINT, 'APPWRITE_ENDPOINT');
  const configPath = resolve(
    import.meta.dirname,
    `../../infrastructure/appwrite/${environment}/appwrite.config.json`,
  );
  const config = parseJson(await readFile(configPath, 'utf8'));
  await reconcileAppwriteSchema({ config, endpoint, projectId, apiKey, dryRun });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(
      `Appwrite schema reconcile failed: ${cleanErrorMessage(error, process.env.APPWRITE_DEPLOY_API_KEY)}\n`,
    );
    process.exitCode = 1;
  });
}

export { AppwriteHttpError, parseJson, validateConfig };
