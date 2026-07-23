# Rollback runbook

Rollback when smoke tests fail, error/latency rates materially regress, authentication or publishing breaks, or an unexpected data mutation is observed. Do not repeatedly redeploy a failing SHA.

## First response

1. Note the failing workflow, SHA, UTC time, symptoms, and provider version/deployment IDs.
2. When the incident risks identity, ownership, or package integrity, use the protected deployment path to set `REGISTRY_MODE=read_only` and `ALLOW_PUBLIC_PUBLISH=false` before attempting a code rollback. Confirm creation, publishing, dist-tag, deprecation, and unpublish are rejected. If identity/token writes are unsafe too, deny those routes at the edge or take the Worker offline.
3. Let the active environment deployment finish or fail; deployment concurrency prevents another run from racing it.
4. Preserve logs without copying tokens, request authorization headers, CLI preference files, or user data.

## Web rollback

Use the Vercel deployment ID or URL from the last known-good workflow:

```sh
vercel rollback <deployment-id-or-url> --yes --token "$VERCEL_TOKEN"
```

Smoke test the stable web domain after alias propagation. A preview deployment rollback does not change the production alias.

## Worker rollback

List Cloudflare deployments, identify the last known-good version, and roll back explicitly:

```sh
pnpm --filter @lemonize/registry-worker exec wrangler deployments list \
  --name "$WORKER_NAME"
pnpm --filter @lemonize/registry-worker exec wrangler rollback <version-id> \
  --name "$WORKER_NAME" --message "rollback incident <id>" --yes
```

Use the protected environment credentials and exact environment Worker name. Never target another environment's Worker, KV, R2 bucket, Appwrite project, or Clerk instance. Then run `REGISTRY_SMOKE_URL=https://... WEB_SMOKE_URL=https://... NPM_PROXY_SMOKE_URL=https://... make smoke`.

The npm proxy is a separate Worker and must be rolled back by its own environment deployment history, never by substituting the registry Worker name:

```sh
pnpm --filter @lemonize/npm-proxy-worker exec wrangler deployments list --env production
pnpm --filter @lemonize/npm-proxy-worker exec wrangler rollback <version-id> \
  --env production --message "rollback incident <id>" --yes
```

If npm traffic is threatening free-tier capacity or npmjs, prefer fail-closed degradation by setting `NPM_PROXY_ENABLED=false` or withdrawing only the npm hostname. Verify native Lemonize metadata/downloads remain available. A code rollback does not remove already-applied Durable Object migration classes; the selected Worker revision must remain compatible with their storage.

Keep publishing read-only when rolling the registry back to a revision that predates `MAX_GLOBAL_ARTIFACT_BYTES` or its conditional quota lock. Re-enable writes only on a revision that enforces the configured aggregate ceiling and after stale quota-lock verification.

## Appwrite TablesDB, scanner, and data

The protected Appwrite schema reconciler is additive-only: it never removes or rewrites an existing database, table, column, index, or bucket. Reverting a checked-in definition therefore does not revert the deployed TablesDB schema. Roll application code only to a revision compatible with the forward schema, and use a separately reviewed migration or backup restore when data repair is required. Do not point the Worker at the legacy D1 database or another environment as a rollback mechanism.

If only the artifact scanner regressed, list its ready deployments and reactivate the last known-good ID before rolling back unrelated schemas:

```sh
appwrite functions list-deployments --function-id artifact-scanner --sort-desc '$createdAt' --limit 10
appwrite functions update-function-deployment \
  --function-id artifact-scanner --deployment-id <deployment-id>
```

For deleted or corrupt data, do not push older definitions and hope they recreate records. Follow `BACKUP_RESTORE.md`, verify archive status, and restore only after recording the recovery point. Prefer restoration to a new resource when the archive/resource type supports it, validate it, then cut over.

TablesDB schema migrations are forward-only unless a tested reverse migration exists. Application rollback must remain compatible with the deployed schema. Never delete R2 objects as part of a code rollback; published artifact bytes, including artifacts for legacy unscoped compatibility packages, remain immutable.

If Clerk verification caused the incident, keep production read-only while validating the exact issuer, JWKS, authorized-party origins, DNS, OAuth callback, GitHub external-ID mapping, and active-user lookup. Do not fall back to email- or username-based publisher approval.

## Closeout

Re-run both smoke tests and one read-only package download, inspect provider metrics for at least 15 minutes, document the final live versions, and create follow-up work. Re-enabling publishing is a separate approved cutover; rollback completion alone is insufficient.
