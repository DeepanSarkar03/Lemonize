import { AppwriteQuery } from './appwrite.js';
import type { Env } from './env.js';
import { registryRepository } from './registry.js';

/** Bounded scheduled retention keeps Appwrite's free row quota predictable. */
export async function cleanupRegistryRetention(env: Env): Promise<void> {
  const repo = registryRepository(env);
  const now = new Date().toISOString();
  const auditCutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  const [expiredTokens, oldAudit] = await Promise.all([
    repo.tokens.list({
      queries: [AppwriteQuery.lessThanEqual('expiresAt', now), AppwriteQuery.limit(5)],
      total: false,
    }),
    repo.audit.list({
      queries: [AppwriteQuery.lessThanEqual('$createdAt', auditCutoff), AppwriteQuery.limit(5)],
      total: false,
    }),
  ]);
  await Promise.all([
    ...expiredTokens.rows.map((row) => repo.tokens.delete(row.$id)),
    ...oldAudit.rows.map((row) => repo.audit.delete(row.$id)),
  ]);
}
