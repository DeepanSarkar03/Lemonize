#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ENVIRONMENT_PINS = Object.freeze({
  staging: Object.freeze({
    registryBaseUrl: 'https://registry-staging.lemonize.cyou',
  }),
  production: Object.freeze({
    registryBaseUrl: 'https://registry.lemonize.cyou',
  }),
});

export async function verifyAppwriteConfig({ environment, projectId, registryBaseUrl }) {
  const pin = ENVIRONMENT_PINS[environment];
  if (!pin) throw new Error('environment must be staging or production');
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('APPWRITE_PROJECT_ID is required');
  }

  const path = resolve(
    import.meta.dirname,
    `../../infrastructure/appwrite/${environment}/appwrite.config.json`,
  );
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (config.projectId !== projectId) {
    throw new Error(
      `Refusing Appwrite push: ${environment} config targets ${config.projectId}, not APPWRITE_PROJECT_ID`,
    );
  }
  if (registryBaseUrl !== undefined && registryBaseUrl !== pin.registryBaseUrl) {
    throw new Error(`REGISTRY_BASE_URL does not match the protected ${environment} registry`);
  }
  return Object.freeze({
    environment,
    projectId,
    registryBaseUrl: registryBaseUrl ?? null,
  });
}

async function main() {
  const environment = process.argv[2];
  if (!environment) throw new Error('usage: verify-appwrite-config.mjs <staging|production>');
  const verified = await verifyAppwriteConfig({
    environment,
    projectId: process.env.APPWRITE_PROJECT_ID,
    registryBaseUrl: process.env.REGISTRY_BASE_URL,
  });
  console.log(`Verified Appwrite ${verified.environment} project ${verified.projectId}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Configuration check failed'}\n`,
    );
    process.exitCode = 1;
  });
}
