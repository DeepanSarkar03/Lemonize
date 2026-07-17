#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const environment = process.argv[2];
if (!['staging', 'production'].includes(environment)) {
  throw new Error('usage: verify-appwrite-config.mjs <staging|production>');
}
if (!process.env.APPWRITE_PROJECT_ID) {
  throw new Error('APPWRITE_PROJECT_ID is required');
}

const path = resolve(
  import.meta.dirname,
  `../../infrastructure/appwrite/${environment}/appwrite.config.json`,
);
const config = JSON.parse(await readFile(path, 'utf8'));
if (config.projectId !== process.env.APPWRITE_PROJECT_ID) {
  throw new Error(
    `Refusing Appwrite push: ${environment} config targets ${config.projectId}, not APPWRITE_PROJECT_ID`,
  );
}
console.log(`Verified Appwrite ${environment} project ${config.projectId}`);
