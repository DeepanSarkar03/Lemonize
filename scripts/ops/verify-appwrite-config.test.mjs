import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyAppwriteConfig } from './verify-appwrite-config.mjs';

const exact = {
  staging: {
    projectId: 'lemonize-staging-2026',
    registryBaseUrl: 'https://registry-staging.lemonize.cyou',
  },
  production: {
    projectId: 'lemonize-prod-2026',
    registryBaseUrl: 'https://registry.lemonize.cyou',
  },
};

test('pins each protected Appwrite project to its exact registry origin', async () => {
  for (const [environment, values] of Object.entries(exact)) {
    assert.deepEqual(await verifyAppwriteConfig({ environment, ...values }), {
      environment,
      ...values,
    });
  }
});

test('rejects cross-environment project and registry combinations', async () => {
  for (const environment of Object.keys(exact)) {
    const other = environment === 'staging' ? 'production' : 'staging';
    await assert.rejects(
      verifyAppwriteConfig({ environment, ...exact[other] }),
      /not APPWRITE_PROJECT_ID/,
    );
    await assert.rejects(
      verifyAppwriteConfig({
        environment,
        projectId: exact[environment].projectId,
        registryBaseUrl: exact[other].registryBaseUrl,
      }),
      /does not match the protected/,
    );
  }
});

test('schema-only workflows may omit the registry origin but not the project', async () => {
  assert.deepEqual(
    await verifyAppwriteConfig({
      environment: 'staging',
      projectId: exact.staging.projectId,
    }),
    {
      environment: 'staging',
      projectId: exact.staging.projectId,
      registryBaseUrl: null,
    },
  );
  await assert.rejects(
    verifyAppwriteConfig({ environment: 'staging', projectId: '' }),
    /APPWRITE_PROJECT_ID is required/,
  );
  await assert.rejects(
    verifyAppwriteConfig({ environment: 'development', projectId: 'dev' }),
    /environment must be staging or production/,
  );
});
