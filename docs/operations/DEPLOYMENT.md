# Protected deployment and cutover runbook

Deployments are manual, immutable, and serialized per environment. Run `.github/workflows/deploy.yml` with `staging` or `production` and the full 40-character commit SHA that passed CI. The workflow repeats the frozen install, quality checks, build, tests, audits, Appwrite reconciliation, scanner deployment, Worker deployment, web deployment, and smoke tests.

When Appwrite schema additions must exist before a Worker release and the Cloudflare or Vercel deploy credentials are intentionally unavailable, dispatch `.github/workflows/sync-appwrite-schema.yml` first with the protected environment and the same full commit SHA. It accepts only a commit reachable from `main` with all six exact-SHA CI checks successful, validates the environment-scoped Appwrite project ID against the selected checked-in definition, and uses only `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, and `APPWRITE_DEPLOY_API_KEY`. This schema-only workflow does not deploy scanner code, either Worker, or the web app; continue with the normal protected deployment after it succeeds.

Deploying code does not authorize writes. Production remains `REGISTRY_MODE=read_only` and `ALLOW_PUBLIC_PUBLISH=false` until the separate cutover gate at the end of this runbook is approved.

## Repository and environment protection

Protect `main` and require these CI checks:

- `Frozen install, lint, typecheck, build, test`
- both `Audit ... dependencies (high/critical)` matrix checks
- `Secret scan (full history)`
- `Worker dry-run and web build`
- `Artifact integrity, extraction, and CLI security tests`

Create GitHub environments named `staging` and `production`. Require at least one reviewer for production, prevent self-review, restrict routine production releases to `main`, and do not allow administrators to bypass protection.

Dev, staging, and production must use different:

- Cloudflare registry/npm-proxy Worker names/routes, KV namespaces, R2 buckets, and Durable Object namespaces;
- Appwrite projects, TablesDB databases, quarantine buckets, scanner functions, and API keys;
- Clerk instances/issuers, backend keys, authorized parties, and OAuth callbacks;
- Vercel projects/domains and credentials.

No D1 resource belongs in this matrix. D1 is a frozen migration source only.

## Protected configuration

Configure the following independently on the staging and production GitHub environments. A missing required value is a hard failure; `ADMIN_CLERK_IDS` may be intentionally empty.

| Kind     | Name                                                                     | Purpose                                                                                              |
| -------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Secret   | `CLOUDFLARE_API_TOKEN`                                                   | Least-privilege deployment token for the matching Worker, secrets, bindings, and route               |
| Secret   | `CLOUDFLARE_ACCOUNT_ID`                                                  | Cloudflare account selected by Wrangler                                                              |
| Secret   | `VERCEL_TOKEN`                                                           | Token scoped to the matching Vercel project/team                                                     |
| Secret   | `APPWRITE_DEPLOY_API_KEY`                                                | CI-only TablesDB/schema, bucket, and function administration                                         |
| Secret   | `APPWRITE_RUNTIME_API_KEY`                                               | Worker-only rows, scanner execution, rejected/expired file cleanup, and expired device-token cleanup |
| Secret   | `APPWRITE_BACKUP_API_KEY`                                                | Backup policy, archive, and restoration operations only                                              |
| Secret   | `CLERK_SECRET_KEY`                                                       | Worker-only active-user/profile lookup in the matching Clerk instance                                |
| Secret   | `SCANNER_SHARED_SECRET`                                                  | Worker/scanner request HMAC and domain-separated stateless device-code signing                       |
| Variable | `WORKER_NAME`                                                            | Environment-specific Worker name                                                                     |
| Variable | `CF_KV_NAMESPACE_ID`                                                     | Environment-specific KV binding                                                                      |
| Variable | `CF_R2_BUCKET`                                                           | Environment-specific private R2 bucket                                                               |
| Variable | `CLOUDFLARE_ROUTE_PATTERN`                                               | Environment-specific custom hostname                                                                 |
| Variable | `REGISTRY_BASE_URL`, `WEB_BASE_URL`                                      | Exact HTTPS public origins                                                                           |
| Variable | `CORS_ALLOWED_ORIGINS`                                                   | Exact comma-separated origins; never `*` in production                                               |
| Variable | `ALLOW_PUBLIC_PUBLISH`, `ALLOW_PRIVATE_PACKAGES`                         | Explicit feature booleans                                                                            |
| Variable | `MAX_TARBALL_SIZE_BYTES`, `MAX_UNPACKED_SIZE_BYTES`, `MAX_PACKAGE_FILES` | Positive integer archive limits                                                                      |
| Variable | `MAX_GLOBAL_ARTIFACT_BYTES`                                              | Serialized total published-and-reserved ceiling; <=70% of lower storage entitlement and <=7 GiB      |
| Variable | `RATE_LIMIT_READS_PER_MINUTE`, `RATE_LIMIT_WRITES_PER_MINUTE`            | Positive integer rate limits                                                                         |
| Variable | `ADMIN_CLERK_IDS`, `REGISTRY_MODE`                                       | Immutable Clerk-subject administrators and public/read-only policy                                   |
| Variable | `NPM_PROXY_BASE_URL`                                                     | Exact environment npm-proxy origin used by deployment smoke tests                                    |
| Variable | `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`                                     | Exact Vercel project linkage                                                                         |
| Variable | `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, `APPWRITE_DATABASE_ID`       | Exact Appwrite endpoint/project/TablesDB linkage                                                     |
| Variable | `APPWRITE_QUARANTINE_BUCKET_ID`, `APPWRITE_SCANNER_FUNCTION_ID`          | Private quarantine and scanner linkage                                                               |
| Variable | `CLERK_ISSUER`, `CLERK_AUTHORIZED_PARTIES`                               | Exact Clerk issuer and accepted web origins                                                          |

There is no publisher email or username allowlist. In `public` mode, publisher role assignment requires the stable GitHub external ID returned by Clerk; accounts without GitHub remain consumers. Require the intended Clerk verification/legal-consent flow, and use only immutable Clerk subjects in `ADMIN_CLERK_IDS` for administrators.

The CLI release workflow publishes `@lemonize/cli` with npm OIDC provenance. The public npm package and exact GitHub trusted-publisher relationship must exist before tagging a release; no long-lived npm token or mutable R2 binary channel is accepted as a substitute.

## What the deployment reconciles

The workflow renders a temporary Wrangler configuration from protected variables and rejects an Appwrite project-ID mismatch with the selected checked-in definition. It does not compare every Cloudflare, Clerk, or Vercel identifier across GitHub environments, so the operator must verify those isolation checks. It pushes Appwrite TablesDB/Storage/function definitions before deploying the Worker.

The scanner is reconciled to:

- Appwrite Node 25 runtime;
- no public execute role;
- `files.read` and `files.write` execution scopes only;
- Appwrite's short-lived injected execution key, with legacy static Appwrite variables removed;
- a private antivirus-enabled quarantine bucket;
- a locally built dependency-free `dist` created under the frozen pnpm lock, validated in Appwrite with `node --check` and no remote npm resolution;
- a fresh deployment with bounded retention and a matching HMAC secret.

Before the first scanner deploy in each project, run `appwrite functions list-runtimes` and confirm `node-25` is available. The workflow fails closed if it is not; do not silently change runtimes or bypass the scanner.

The registry Worker receives only the runtime Appwrite key plus Clerk and scanner secrets. It has KV, private R2, and `DEVICE_APPROVALS`/`RATE_LIMITS` Durable Object bindings, not D1. Wrangler applies the checked Durable Object migrations. The npm-proxy Worker has only Cache API access and its `NPM_ADMISSION_CONTROLLER` Durable Object; it has no registry R2, KV, Appwrite, or Clerk binding. The web app receives only public Clerk/browser configuration and the registry URL.

The npm proxy is deployed from its checked environment configuration with `NPM_PROXY_PACKUMENT_MODE=free`. Before making its production hostname public, use a separately approved narrow credential to configure Cloudflare DNS and WAF/rate-limiting rules outside Wrangler for the supported route/method surface, record the rule IDs, and verify npm, pnpm, Yarn, audit, HEAD, Range, denial, and admission-exhaustion behavior. The current Wrangler OAuth session lacks DNS/WAF scopes; Worker-deploy authority alone is insufficient. Production DNS/custom-domain and WAF evidence are cutover gates.

## Staging release procedure

1. Confirm all required CI checks pass on the exact SHA.
2. Verify the staging GitHub environment points only to staging Cloudflare, Appwrite, Clerk, and Vercel resources.
3. Dispatch that SHA to `staging`.
4. Confirm `/ready` reports Appwrite, KV, and R2 healthy, and check `/v1/limits`.
5. Run `lem login`. Sign in through staging Clerk, manually enter the terminal code, and confirm the returned token has only the expected scopes.
6. Verify an account without GitHub receives consumer scopes and cannot publish. Verify a GitHub-linked account receives public-publisher capability only after accepting the current terms and while staging is `public` with publishing enabled. Check deterministic collision suffixing and namespace freeze after first ownership.
7. Publish a namespace-scoped fixture and observe reservation, private staging upload, scan job, Appwrite scanner execution/quarantine, signed clean callback, immutable R2 promotion, retained clean Appwrite copy, metadata, download, and CLI SHA-512/SHA-256 verification.
8. Exercise malformed archive, hash mismatch, timeout, revoked token, locked Clerk account, wrong namespace, reused version, per-account/global quota rejection, new-version rejection for a legacy unscoped package, and non-admin unscoped maintenance rejection. Test soft-yank in mutable staging, then confirm `read_only` rejects it too.
9. Exercise the npm proxy supported routes, unsupported read `404`, mutation `405`, free-mode large-packument passthrough, 16 MiB cap, full-cache and Range behavior, origin-budget `429`, admission failure `503`, and hostname-scoped WAF policy.
10. Verify a recent Appwrite archive is `completed` and perform the scheduled restore test when due.
11. Record the workflow URL, provider deployment IDs, Durable Object migration tags, and WAF rule IDs without recording credentials.

## Production read-only release

1. Confirm the same SHA passed staging.
2. Confirm production variables still contain `REGISTRY_MODE=read_only` and `ALLOW_PUBLIC_PUBLISH=false`.
3. Verify production resource IDs and hostnames do not equal staging or dev.
4. Obtain production environment approval and deploy the same SHA.
5. Confirm `/ready`, `/v1/limits`, the stable web origin, public metadata, a known legacy/package download, immutable headers, the npm-proxy packument/tarball smoke checks, and provider error/quota dashboards.
6. Verify package creation, publish/finalize, dist-tag, deprecation, and unpublish routes remain rejected for both publisher and administrator credentials. Do not change production mode to perform this check; the regression behavior must already be covered in CI and staging.
7. Record registry Worker, npm-proxy Worker, Durable Object migration, Appwrite scanner, and Vercel deployment IDs for rollback.

Appwrite, Cloudflare, and Vercel do not share a transaction. If a later phase fails, stop retries, identify which providers changed, and follow [Rollback](ROLLBACK.md).

## Write cutover gate

Write enablement is a separate change with a separate approval. Complete the steps in this order:

1. Exercise the provisioned production Clerk environment end-to-end: verify email delivery, first-user GitHub sign-in and callback handling, lockout, linking, legal consent, active-user lookup, and manual device approval against the live custom issuer/JWKS.
2. Put the legacy registry into an enforced read-only or firewall-denied write state. Prove token issuance and every legacy write route are rejected before exporting.
3. Take the final legacy database export and source R2 inventory only after the freeze. Record source resource IDs, timestamps, object counts, sizes, and digests.
4. Import into production Appwrite TablesDB and the intended production R2 bucket. Reconcile users, real Clerk bindings, ownership, packages, versions, tags, counters, visibility, audit rows, object keys, sizes, and digests immediately before cutover.
5. Explicitly classify migrated unscoped packages as read-only compatibility records. Verify non-admin dist-tag, deprecation, and soft-yank attempts are rejected. Do not rename packages silently or allow new versions. Administrator remediation requires an explicitly reviewed mutable-mode window or direct controlled provider operation.
6. Verify the scanner's clean, rejection, retry, HMAC replay/expiry, quarantine, retained-clean-copy, and immutable-promotion paths in the production resource set without exposing a public publish route.
7. Verify a completed Appwrite backup, a successful non-production restore, and separate R2 preservation evidence.
8. Confirm rollback owners, commands, last-known-good versions, monitoring, and budget thresholds. Verify `MAX_GLOBAL_ARTIFACT_BYTES` is no more than 70% of the lower current R2/Appwrite entitlement, never more than 7 GiB, and remains at the conservative 1 GiB default if entitlement evidence is incomplete.
9. Obtain narrow Cloudflare DNS/WAF authority, resolve and smoke-test `npm.lemonize.cyou`, verify its WAF rule IDs and Durable Object origin admission, and confirm the proxy can be disabled without affecting native registry reads.
10. Authenticate an npm owner and confirm the npm organization/trusted-publisher relationship without adding a long-lived npm credential.
11. Obtain explicit production write approval. Change `REGISTRY_MODE` to `public` and `ALLOW_PUBLIC_PUBLISH` to `true` in one reviewed protected-environment change, deploy, and immediately run a GitHub-linked namespace-scoped canary publish.

If any count, identity, digest, provider setting, or blocker is unresolved, keep the new registry read-only. A zero active-token count observed before the freeze is not proof of a freeze; enforcement must precede the final snapshot.
