#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const output = resolve(process.argv[2] ?? 'wrangler.generated.json');
const root = resolve(import.meta.dirname, '../..');

const required = [
  'DEPLOY_ENV',
  'WORKER_NAME',
  'CF_KV_NAMESPACE_ID',
  'CF_R2_BUCKET',
  'CLOUDFLARE_ROUTE_PATTERN',
  'ALLOW_PUBLIC_PUBLISH',
  'ALLOW_PRIVATE_PACKAGES',
  'MAX_TARBALL_SIZE_BYTES',
  'MAX_UNPACKED_SIZE_BYTES',
  'MAX_PACKAGE_FILES',
  'MAX_GLOBAL_ARTIFACT_BYTES',
  'RATE_LIMIT_READS_PER_MINUTE',
  'RATE_LIMIT_WRITES_PER_MINUTE',
  'REGISTRY_BASE_URL',
  'WEB_BASE_URL',
  'CORS_ALLOWED_ORIGINS',
  'REGISTRY_MODE',
  'APPWRITE_ENDPOINT',
  'APPWRITE_PROJECT_ID',
  'APPWRITE_DATABASE_ID',
  'APPWRITE_QUARANTINE_BUCKET_ID',
  'APPWRITE_SCANNER_FUNCTION_ID',
  'CLERK_ISSUER',
  'CLERK_AUTHORIZED_PARTIES',
];

const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(`Required deployment configuration is missing: ${missing.join(', ')}`);
}
if (!['staging', 'production'].includes(process.env.DEPLOY_ENV)) {
  throw new Error('DEPLOY_ENV must be staging or production');
}
if (
  process.env.DEPLOY_ENV === 'production' &&
  process.env.ALLOW_PUBLIC_PUBLISH === 'true' &&
  process.env.REGISTRY_MODE !== 'read_only' &&
  process.env.PRODUCTION_WRITE_APPROVED !== 'ENABLE_PUBLIC_WRITES'
) {
  throw new Error(
    'Mutable production deployment requires PRODUCTION_WRITE_APPROVED=ENABLE_PUBLIC_WRITES',
  );
}
if (process.env.ALLOW_PUBLIC_PUBLISH === 'true' && process.env.REGISTRY_MODE === 'read_only') {
  throw new Error('ALLOW_PUBLIC_PUBLISH=true is invalid while REGISTRY_MODE=read_only');
}
if (!['public', 'invite_only', 'read_only'].includes(process.env.REGISTRY_MODE)) {
  throw new Error('REGISTRY_MODE must be public, invite_only, or read_only');
}

for (const name of ['ALLOW_PUBLIC_PUBLISH', 'ALLOW_PRIVATE_PACKAGES']) {
  if (!['true', 'false'].includes(process.env[name])) {
    throw new Error(`${name} must be the string true or false`);
  }
}
for (const name of [
  'MAX_TARBALL_SIZE_BYTES',
  'MAX_UNPACKED_SIZE_BYTES',
  'MAX_PACKAGE_FILES',
  'MAX_GLOBAL_ARTIFACT_BYTES',
  'RATE_LIMIT_READS_PER_MINUTE',
  'RATE_LIMIT_WRITES_PER_MINUTE',
]) {
  if (!/^[1-9][0-9]*$/.test(process.env[name])) {
    throw new Error(`${name} must be a positive integer`);
  }
}
for (const name of ['REGISTRY_BASE_URL', 'WEB_BASE_URL']) {
  const url = new URL(process.env[name]);
  if (url.protocol !== 'https:') throw new Error(`${name} must use HTTPS`);
  if (url.origin !== process.env[name] || url.username || url.password) {
    throw new Error(
      `${name} must be an HTTPS origin without credentials, path, query, or fragment`,
    );
  }
}
for (const origin of [
  ...process.env.CORS_ALLOWED_ORIGINS.split(','),
  ...process.env.CLERK_AUTHORIZED_PARTIES.split(','),
]) {
  if (!origin || origin === '*')
    throw new Error('CORS_ALLOWED_ORIGINS must contain exact HTTPS origins');
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) {
    throw new Error(`Invalid CORS origin: ${origin}`);
  }
}
if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(process.env.WORKER_NAME)) {
  throw new Error('WORKER_NAME must contain only lowercase letters, digits, and internal hyphens');
}
if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(process.env.CF_R2_BUCKET)) {
  throw new Error('CF_R2_BUCKET must be a valid lowercase bucket name');
}
if (!/^[0-9a-f]{32}$/.test(process.env.CF_KV_NAMESPACE_ID)) {
  throw new Error('CF_KV_NAMESPACE_ID must be a 32-character lowercase hexadecimal ID');
}
if (
  !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
    process.env.CLOUDFLARE_ROUTE_PATTERN,
  )
) {
  throw new Error('CLOUDFLARE_ROUTE_PATTERN must be an exact lowercase hostname');
}
const appwriteEndpoint = new URL(process.env.APPWRITE_ENDPOINT);
if (
  appwriteEndpoint.protocol !== 'https:' ||
  appwriteEndpoint.username ||
  appwriteEndpoint.password ||
  appwriteEndpoint.search ||
  appwriteEndpoint.hash
) {
  throw new Error('APPWRITE_ENDPOINT must be an HTTPS URL without credentials, query, or fragment');
}
const clerkIssuer = new URL(process.env.CLERK_ISSUER);
if (clerkIssuer.protocol !== 'https:' || clerkIssuer.origin !== process.env.CLERK_ISSUER) {
  throw new Error('CLERK_ISSUER must be an exact HTTPS origin');
}
for (const name of [
  'APPWRITE_PROJECT_ID',
  'APPWRITE_DATABASE_ID',
  'APPWRITE_QUARANTINE_BUCKET_ID',
  'APPWRITE_SCANNER_FUNCTION_ID',
]) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(process.env[name])) {
    throw new Error(`${name} is not a valid Appwrite resource ID`);
  }
}
for (const clerkId of (process.env.ADMIN_CLERK_IDS ?? '').split(',').filter(Boolean)) {
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(clerkId)) {
    throw new Error(`Invalid ADMIN_CLERK_IDS entry: ${clerkId}`);
  }
}

const workerMain = relative(
  dirname(output),
  resolve(root, 'apps/registry-worker/src/index.ts'),
).replaceAll('\\', '/');
const config = {
  $schema: relative(
    dirname(output),
    resolve(root, 'apps/registry-worker/node_modules/wrangler/config-schema.json'),
  ).replaceAll('\\', '/'),
  name: process.env.WORKER_NAME,
  main: workerMain,
  workers_dev: false,
  compatibility_date: '2026-07-16',
  compatibility_flags: ['nodejs_compat'],
  observability: { enabled: true },
  triggers: { crons: ['*/15 * * * *'] },
  durable_objects: {
    bindings: [
      { name: 'DEVICE_APPROVALS', class_name: 'DeviceApprovalObject' },
      { name: 'RATE_LIMITS', class_name: 'RateLimitObject' },
    ],
  },
  migrations: [
    {
      tag: 'v1-auth-controls',
      new_sqlite_classes: ['DeviceApprovalObject', 'RateLimitObject'],
    },
  ],
  vars: {
    ALLOW_PUBLIC_PUBLISH: process.env.ALLOW_PUBLIC_PUBLISH,
    ALLOW_PRIVATE_PACKAGES: process.env.ALLOW_PRIVATE_PACKAGES,
    MAX_TARBALL_SIZE_BYTES: process.env.MAX_TARBALL_SIZE_BYTES,
    MAX_UNPACKED_SIZE_BYTES: process.env.MAX_UNPACKED_SIZE_BYTES,
    MAX_PACKAGE_FILES: process.env.MAX_PACKAGE_FILES,
    MAX_GLOBAL_ARTIFACT_BYTES: process.env.MAX_GLOBAL_ARTIFACT_BYTES,
    RATE_LIMIT_READS_PER_MINUTE: process.env.RATE_LIMIT_READS_PER_MINUTE,
    RATE_LIMIT_WRITES_PER_MINUTE: process.env.RATE_LIMIT_WRITES_PER_MINUTE,
    REGISTRY_BASE_URL: process.env.REGISTRY_BASE_URL,
    WEB_BASE_URL: process.env.WEB_BASE_URL,
    CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
    ADMIN_CLERK_IDS: process.env.ADMIN_CLERK_IDS ?? '',
    REGISTRY_MODE: process.env.REGISTRY_MODE,
    APPWRITE_ENDPOINT: process.env.APPWRITE_ENDPOINT,
    APPWRITE_PROJECT_ID: process.env.APPWRITE_PROJECT_ID,
    APPWRITE_DATABASE_ID: process.env.APPWRITE_DATABASE_ID,
    APPWRITE_QUARANTINE_BUCKET_ID: process.env.APPWRITE_QUARANTINE_BUCKET_ID,
    APPWRITE_SCANNER_FUNCTION_ID: process.env.APPWRITE_SCANNER_FUNCTION_ID,
    CLERK_ISSUER: process.env.CLERK_ISSUER,
    CLERK_AUTHORIZED_PARTIES: process.env.CLERK_AUTHORIZED_PARTIES,
  },
  kv_namespaces: [{ binding: 'KV', id: process.env.CF_KV_NAMESPACE_ID }],
  r2_buckets: [{ binding: 'BUCKET', bucket_name: process.env.CF_R2_BUCKET }],
  routes: [{ pattern: process.env.CLOUDFLARE_ROUTE_PATTERN, custom_domain: true }],
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`Rendered ${process.env.DEPLOY_ENV} Wrangler configuration at ${output}`);
