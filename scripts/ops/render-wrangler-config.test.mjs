import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const renderer = fileURLToPath(new URL('./render-wrangler-config.mjs', import.meta.url));

const baseEnvironment = {
  WORKER_NAME: 'lemonize-policy-test',
  CF_KV_NAMESPACE_ID: '0123456789abcdef0123456789abcdef',
  CF_R2_BUCKET: 'lemonize-policy-test',
  CLOUDFLARE_ROUTE_PATTERN: 'registry.test.example',
  ALLOW_PRIVATE_PACKAGES: 'false',
  MAX_TARBALL_SIZE_BYTES: '10485760',
  MAX_UNPACKED_SIZE_BYTES: '104857600',
  MAX_PACKAGE_FILES: '2000',
  MAX_GLOBAL_ARTIFACT_BYTES: '1073741824',
  RATE_LIMIT_READS_PER_MINUTE: '600',
  RATE_LIMIT_WRITES_PER_MINUTE: '60',
  REGISTRY_BASE_URL: 'https://registry.test.example',
  WEB_BASE_URL: 'https://web.test.example',
  CORS_ALLOWED_ORIGINS: 'https://web.test.example',
  ADMIN_CLERK_IDS: '',
  PACKAGE_SCOPE_GRANTS_JSON: '[]',
  APPWRITE_ENDPOINT: 'https://appwrite.test.example/v1',
  APPWRITE_PROJECT_ID: 'policy-test',
  APPWRITE_DATABASE_ID: 'registry',
  APPWRITE_QUARANTINE_BUCKET_ID: 'quarantine',
  APPWRITE_SCANNER_FUNCTION_ID: 'scanner',
  CLERK_ISSUER: 'https://clerk.test.example',
  CLERK_AUTHORIZED_PARTIES: 'https://web.test.example',
  CLERK_PRIVATE_PACKAGES_FEATURE: 'private-packages',
};

async function render(overrides) {
  const directory = await mkdtemp(join(tmpdir(), 'lemonize-render-policy-'));
  try {
    return spawnSync(process.execPath, [renderer, join(directory, 'wrangler.json')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...baseEnvironment,
        PRODUCTION_WRITE_APPROVED: '',
        ...overrides,
      },
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

const productionMatrix = [
  {
    name: 'read-only registry without approval',
    registryMode: 'read_only',
    allowPublicPublish: 'false',
    approved: false,
    allowed: true,
  },
  {
    name: 'read-only registry with approval',
    registryMode: 'read_only',
    allowPublicPublish: 'false',
    approved: true,
    allowed: true,
  },
  {
    name: 'public maintenance-only registry without approval',
    registryMode: 'public',
    allowPublicPublish: 'false',
    approved: false,
    allowed: false,
  },
  {
    name: 'public maintenance-only registry with approval',
    registryMode: 'public',
    allowPublicPublish: 'false',
    approved: true,
    allowed: true,
  },
  {
    name: 'invite-only maintenance-only registry without approval',
    registryMode: 'invite_only',
    allowPublicPublish: 'false',
    approved: false,
    allowed: false,
  },
  {
    name: 'invite-only maintenance-only registry with approval',
    registryMode: 'invite_only',
    allowPublicPublish: 'false',
    approved: true,
    allowed: true,
  },
  {
    name: 'public publishing registry without approval',
    registryMode: 'public',
    allowPublicPublish: 'true',
    approved: false,
    allowed: false,
  },
  {
    name: 'public publishing registry with approval',
    registryMode: 'public',
    allowPublicPublish: 'true',
    approved: true,
    allowed: true,
  },
  {
    name: 'invite-only publishing registry without approval',
    registryMode: 'invite_only',
    allowPublicPublish: 'true',
    approved: false,
    allowed: false,
  },
  {
    name: 'invite-only publishing registry with approval',
    registryMode: 'invite_only',
    allowPublicPublish: 'true',
    approved: true,
    allowed: true,
  },
];

for (const scenario of productionMatrix) {
  test(`production policy ${scenario.allowed ? 'permits' : 'rejects'} ${scenario.name}`, async () => {
    const result = await render({
      DEPLOY_ENV: 'production',
      REGISTRY_MODE: scenario.registryMode,
      ALLOW_PUBLIC_PUBLISH: scenario.allowPublicPublish,
      PRODUCTION_WRITE_APPROVED: scenario.approved ? 'ENABLE_PUBLIC_WRITES' : '',
    });

    assert.equal(result.status, scenario.allowed ? 0 : 1, result.stderr || result.stdout);
    if (!scenario.allowed) {
      assert.match(
        result.stderr,
        /Mutable production deployment requires PRODUCTION_WRITE_APPROVED/,
      );
    }
  });
}

test('staging mutable modes do not require production approval', async () => {
  for (const registryMode of ['public', 'invite_only']) {
    for (const allowPublicPublish of ['false', 'true']) {
      const result = await render({
        DEPLOY_ENV: 'staging',
        REGISTRY_MODE: registryMode,
        ALLOW_PUBLIC_PUBLISH: allowPublicPublish,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
  }
});
