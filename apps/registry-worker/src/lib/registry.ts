import { AppwriteRestClient } from './appwrite.js';
import { RegistryAppwriteRepository } from './appwrite-repository.js';
import type { Env } from './env.js';

/** Build a request-scoped, server-key Appwrite repository. */
export function registryRepository(env: Env): RegistryAppwriteRepository {
  return new RegistryAppwriteRepository(
    new AppwriteRestClient({
      endpoint: env.APPWRITE_ENDPOINT,
      projectId: env.APPWRITE_PROJECT_ID,
      apiKey: env.APPWRITE_API_KEY,
      databaseId: env.APPWRITE_DATABASE_ID || 'registry',
    }),
  );
}
