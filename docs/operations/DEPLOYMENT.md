# Protected deployment and cutover runbook

Deployments are manual, immutable, and serialized per environment. Run `.github/workflows/deploy.yml` with `staging` or `production` and the full 40-character commit SHA that passed CI. The workflow repeats the frozen install, quality checks, build, tests, audits, Appwrite reconciliation, scanner deployment, Worker deployment, web deployment, and smoke tests.

When Appwrite schema additions must exist before a Worker release and the Cloudflare or Vercel deploy credentials are intentionally unavailable, dispatch `.github/workflows/sync-appwrite-schema.yml` first with the protected environment and the same full commit SHA. It accepts only a commit reachable from `main` with all six exact-SHA CI checks successful, validates the environment-scoped Appwrite project ID against the selected checked-in definition, and uses only `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, and `APPWRITE_DEPLOY_API_KEY`. The dependency-free reconciler calls the modern TablesDB and Storage APIs directly. It creates absent resources, waits for asynchronous column and index builds, and fails on drift; it never updates or deletes an existing resource. This schema-only workflow does not deploy scanner code, either Worker, or the web app; continue with the normal protected deployment after it succeeds.

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

Configure the following independently on the staging and production GitHub environments unless a value is explicitly marked staging-only. A missing required value is a hard failure. Keep `ADMIN_CLERK_IDS` empty only during initial provisioning; every deployable environment must have at least one verified, immutable Clerk `user_...` subject before it is considered operationally ready.

| Kind     | Name                                                                     | Purpose                                                                                              |
| -------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Secret   | `CLOUDFLARE_API_TOKEN`                                                   | Least-privilege deployment token for the matching Worker, secrets, bindings, and route               |
| Secret   | `CLOUDFLARE_ACCOUNT_ID`                                                  | Cloudflare account selected by Wrangler                                                              |
| Secret   | `VERCEL_TOKEN`                                                           | Token scoped to the matching Vercel project/team                                                     |
| Secret   | `VERCEL_AUTOMATION_BYPASS_SECRET`                                        | Per-project credential used only to verify the exact protected deployment before promotion           |
| Secret   | `APPWRITE_DEPLOY_API_KEY`                                                | CI-only TablesDB/schema, bucket, and function administration                                         |
| Secret   | `APPWRITE_RUNTIME_API_KEY`                                               | Worker-only rows, scanner execution, rejected/expired file cleanup, and expired device-token cleanup |
| Secret   | `APPWRITE_SCANNER_API_KEY`                                               | Temporary scanner-only key with only `files.read` and `files.write`                                  |
| Secret   | `APPWRITE_RESTORE_DATA_API_KEY`                                          | Staging restore-drill CI only; row read/write for generated synthetic resources                      |
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
| Variable | `CLERK_PRIVATE_PACKAGES_FEATURE`                                         | Clerk Billing feature slug required by a non-free active user plan                                   |
| Variable | `MAX_TARBALL_SIZE_BYTES`, `MAX_UNPACKED_SIZE_BYTES`, `MAX_PACKAGE_FILES` | Positive integer archive limits                                                                      |
| Variable | `MAX_GLOBAL_ARTIFACT_BYTES`                                              | Serialized total published-and-reserved ceiling; <=70% of lower storage entitlement and <=7 GiB      |
| Variable | `RATE_LIMIT_READS_PER_MINUTE`, `RATE_LIMIT_WRITES_PER_MINUTE`            | Positive integer rate limits                                                                         |
| Variable | `ADMIN_CLERK_IDS`, `REGISTRY_MODE`                                       | Immutable Clerk-subject administrators and public/read-only policy                                   |
| Variable | `PACKAGE_SCOPE_GRANTS_JSON`                                              | Required strict package-scope grant array keyed to immutable GitHub external IDs; use explicit `[]`  |
| Variable | `NPM_PROXY_BASE_URL`                                                     | Exact environment npm-proxy origin used by deployment smoke tests                                    |
| Variable | `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`                                     | Exact Vercel project linkage                                                                         |
| Variable | `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, `APPWRITE_DATABASE_ID`       | Exact Appwrite endpoint/project/TablesDB linkage                                                     |
| Variable | `APPWRITE_QUARANTINE_BUCKET_ID`, `APPWRITE_SCANNER_FUNCTION_ID`          | Private quarantine and scanner linkage                                                               |
| Variable | `APPWRITE_SCANNER_FALLBACK_DEPLOYMENT_ID`                                | Optional active, ready deployment pin for byte-identical artifact-handoff recovery                   |
| Variable | `APPWRITE_SCANNER_API_KEY_ID`                                            | Provider ID of the temporary, environment-unique scanner key                                         |
| Variable | `APPWRITE_SCANNER_API_KEY_ATTESTATION_JSON`                              | Protected non-secret reviewer record for the scanner key                                             |
| Variable | `CLERK_ISSUER`, `CLERK_AUTHORIZED_PARTIES`                               | Exact Clerk issuer and accepted web origins                                                          |

The expected Clerk issuer, stable web origin, authorized parties, checked definition, and development/production instance type are independently pinned in `infrastructure/clerk/environments.json`. The protected deploy rejects GitHub environment values that do not exactly match that reviewed map. It first checks the immutable Vercel deployment through its project-scoped automation-bypass credential, promotes or aliases only that verified deployment, and then repeats the check on the stable public origin with bounded propagation retries and no bypass credential.

Create a separate `APPWRITE_SCANNER_API_KEY` in each Appwrite project with
**only** `files.read` and `files.write`, a provider expiry no more than 90 days
after creation, and no reuse of the Worker runtime key, CI deploy key, or HMAC
secret. Store its provider ID in `APPWRITE_SCANNER_API_KEY_ID`. Retain reviewed
provider-console evidence of the ID, project, exact scope selection, creation
time, expiry, and reviewer, then set the protected non-secret
`APPWRITE_SCANNER_API_KEY_ATTESTATION_JSON` variable to this exact schema (the
scope order is mandatory):

Replace every sample value below with current provider-console evidence for the
selected protected environment; the example dates are not reusable defaults.

```json
{
  "createdAt": "2026-07-29T00:00:00.000Z",
  "environment": "staging",
  "expiresAt": "2026-08-28T00:00:00.000Z",
  "keyId": "scanner-key-id",
  "projectId": "lemonize-staging-2026",
  "reviewer": "github-reviewer",
  "scopes": ["files.read", "files.write"]
}
```

`createdAt` is the provider creation time of the current key, including a
replacement created during rotation. `expiresAt` must still be in the future,
must equal the enforced provider expiry, and may be at most 90 days after
`createdAt`. The protected workflow validates the exact fields, environment,
project and key IDs, ordered scopes, dates, and reviewer. It then uses the
secret to create, read, byte-check, delete, and confirm deletion of a tiny
random `.tgz` in the exact quarantine bucket. Appwrite key secrets are opaque:
these checks prove the supplied secret's functional read/write capability but
cannot cryptographically bind it to the recorded key ID or prove that the key
has no extra scope. The retained provider evidence, enforced expiry, and prompt
revocation after replacement remain mandatory.

The workflow passes the secret, ID, and attestation only to the scanner
deployment step, which writes the secret as function variable
`APPWRITE_API_KEY`; none is rendered into Wrangler configuration or exposed to
the Worker, web app, npm proxy, schema sync, or other deployment steps. Every
scanner deploy and rotation first requires the live `/v1/limits` response to
prove exact `read_only` mode with publishing disabled.

There is no publisher email or username allowlist. In `public` mode, every active Clerk account is publisher-eligible after accepting the current terms. Require the intended Clerk verification/legal-consent flow, and use only immutable Clerk subjects in `ADMIN_CLERK_IDS` for administrators. GitHub external IDs authorize only reviewed additional scope grants.

`PACKAGE_SCOPE_GRANTS_JSON` is a required, nonblank, strict array of `{ "scope": "scope-without-at", "githubId": "stable-provider-id" }` entries. A scope may appear once, must use the canonical lowercase namespace grammar, and must not be reserved. Set it explicitly to `[]` unless the target has completed Clerk/GitHub sign-in and a reviewed read-only collision check confirms that neither another user's primary namespace nor another owner package already claims the scope. Missing, blank, malformed, ambiguous, or duplicate configuration stops deployment rendering and Worker configuration loading. Never substitute a username, email, wildcard, token capability, or administrator grant.

The CLI release workflow publishes `@lemonize/cli` with npm OIDC provenance. The public npm package and exact GitHub trusted-publisher relationship must exist before tagging a release; no long-lived npm token or mutable R2 binary channel is accepted as a substitute.

## What the deployment reconciles

The workflow renders a temporary Wrangler configuration from protected variables and rejects an Appwrite project-ID mismatch with the selected checked-in definition. Clerk's public security policy and pinned environment identity are checked automatically; the operator must still verify the remaining Cloudflare and Vercel isolation checks. It pushes Appwrite TablesDB and Storage definitions before deploying the Worker. A full deployment targeting read-only mode skips rebuilding the artifact scanner because the publish path is disabled; the dedicated scanner workflow remains available only while the live registry is read-only. Any deployment targeting writes must still observe the old live registry in exact read-only mode while it reconciles and proves the scanner, before the Worker cutover. A fresh build must activate and pass exact configuration, variable, deployment-identity, storage-key, and signed-secret checks.

If Appwrite reports the exact terminal `Build produced no output artifact.` handoff failure, the workflow has already enforced read-only mode, validated the storage key, reconciled the function, and unconditionally upserted the current secret key. Reconciliation marks the function stale, so there is no live-preflight shortcut. The only fallback requires `live=false`, Appwrite `/health/version` exactly `1.9.5`, exact seven-variable metadata, byte-identical downloaded source, ready deployment metadata, and one of two checked-in project/deployment attestations: staging `6a6181a0da2eaed03005` from [run 29975397469](https://github.com/DeepanSarkar03/Lemonize/actions/runs/29975397469), or production `6a61824d9976c050eeee` from [run 29975504229](https://github.com/DeepanSarkar03/Lemonize/actions/runs/29975504229). Both runs built commit `3060c6e03a90c697eae4898a5384f8071677bdb1`; the scanner package and runtime source are unchanged. The workflow re-reads function, deployment, and variables after source comparison and performs the signed side-effect-free execution last. It never patches `live` or reactivates the old deployment. A gate, attestation, canary, provider-version, status, identity, configuration, source, variable, challenge, or error-message mismatch remains blocking.

The scanner is reconciled to:

- Appwrite Node 25 runtime;
- no public execute role;
- `files.read` and `files.write` execution scopes only;
- zero project-level variables and an exact seven-key function-variable allowlist; temporary `APPWRITE_API_KEY` and the HMAC value are secret, and unexpected values such as `NODE_OPTIONS`, proxy settings, or unrelated Appwrite credentials are deleted;
- a private antivirus-enabled quarantine bucket;
- a locally built dependency-free `dist` created under the frozen pnpm lock, validated in Appwrite with `node --check` and no remote npm resolution;
- a fresh deployment with bounded retention and a matching HMAC secret, or only the explicitly attested fallback path above.

Appwrite 1.9.5 supplies its documented execution key in the `x-appwrite-key`
header, but the pinned scanner artifact checks environment variables only. The
static key is a temporary, unsupported integration shim while Appwrite's
separate artifact-handoff outage blocks deploying the corrected scanner.
Although runtime code and the storage canary pin the exact quarantine bucket,
`files.read` and `files.write` still grant access to files project-wide. Once a
corrected scanner consumes the header and Appwrite reliably hands off that
artifact, remove the Appwrite key, protected secret, ID/attestation variables,
secret `APPWRITE_API_KEY` function variable, and deployment shim together;
restore the smaller variable allowlist and remove obsolete fallback attestations
only in that reviewed transition.

Before the first scanner deploy in each project, run `appwrite functions list-runtimes` and confirm `node-25` is available. The workflow fails closed if it is not; do not silently change runtimes or bypass the scanner.

The registry Worker receives only the runtime Appwrite key plus Clerk and scanner secrets. It has KV, private R2, and `DEVICE_APPROVALS`/`RATE_LIMITS` Durable Object bindings, not D1. Wrangler applies the checked Durable Object migrations. The npm-proxy Worker has only Cache API access and its `NPM_ADMISSION_CONTROLLER` Durable Object; it has no registry R2, KV, Appwrite, or Clerk binding. The web app receives only public Clerk/browser configuration and the registry URL.

The npm proxy is deployed from its checked environment configuration with `NPM_PROXY_PACKUMENT_MODE=free`. Before making its production hostname public, use a separately approved narrow credential to configure Cloudflare DNS and WAF/rate-limiting rules outside Wrangler for the supported route/method surface, record the rule IDs, and verify npm, pnpm, Yarn, audit, HEAD, Range, denial, and admission-exhaustion behavior. The current Wrangler OAuth session lacks DNS/WAF scopes; Worker-deploy authority alone is insufficient. Production DNS/custom-domain and WAF evidence are cutover gates.

## Staging release procedure

1. Confirm all required CI checks pass on the exact SHA.
2. Verify the staging GitHub environment points only to staging Cloudflare, Appwrite, Clerk, and Vercel resources.
3. Dispatch that SHA to `staging`.
4. Confirm `/ready` reports Appwrite, KV, and R2 healthy, and check `/v1/limits`.
5. Run `lem login`. Sign in through staging Clerk, manually enter the terminal code, and confirm the returned token has only the expected scopes.
6. Verify accounts with and without GitHub receive public-publisher capability only after accepting the current terms and while staging is `public` with publishing enabled. Check deterministic namespace collision suffixing and namespace freeze after first ownership.
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
6. While the live registry remains read-only, dispatch the dedicated protected scanner workflow for the approved SHA. Verify its exact environment/project/origin pins, storage-key canary, function reconciliation, fallback identity, and signed no-side-effect execution challenge. A real package publish is intentionally impossible in `read_only`; rely on the completed same-SHA staging fixture until the separately approved production write cutover below.
7. Verify a completed Appwrite backup, a successful non-production restore, and separate R2 preservation evidence.
8. Confirm rollback owners, commands, last-known-good versions, monitoring, and budget thresholds. Verify `MAX_GLOBAL_ARTIFACT_BYTES` is no more than 70% of the lower current R2/Appwrite entitlement, never more than 7 GiB, and remains at the conservative 1 GiB default if entitlement evidence is incomplete.
9. Obtain narrow Cloudflare DNS/WAF authority, resolve and smoke-test `npm.lemonize.cyou`, verify its WAF rule IDs and Durable Object origin admission, and confirm the proxy can be disabled without affecting native registry reads.
10. Authenticate an npm owner and confirm the npm organization/trusted-publisher relationship without adding a long-lived npm credential.
11. Obtain explicit production write approval. Change `REGISTRY_MODE` to `public` and `ALLOW_PUBLIC_PUBLISH` to `true` in one reviewed protected-environment change and deploy from the still-read-only live registry. Immediately run a real namespace-scoped clean publish for the approved canary account and verify reservation, upload, scanner execution, quarantine, signed callback, retained clean copy, immutable promotion, metadata, and verified download; then test an account without GitHub. If any check fails, immediately restore `REGISTRY_MODE=read_only` and `ALLOW_PUBLIC_PUBLISH=false`, redeploy the same approved SHA, and verify `/v1/limits` before investigating.

If any count, identity, digest, provider setting, or blocker is unresolved, keep the new registry read-only. A zero active-token count observed before the freeze is not proof of a freeze; enforcement must precede the final snapshot.
