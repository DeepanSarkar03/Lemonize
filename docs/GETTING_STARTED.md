# Getting started with Lemonize

The current Lemonize stack uses Cloudflare Workers/Cache API/Durable Objects/KV/R2, Appwrite TablesDB/Functions/Storage, Clerk, and Vercel. Production is read-only during cutover; use a dedicated dev or staging environment for login and publish tests.

## 1. Install the workspace

Requirements:

- Node 24.x
- Corepack with pnpm 11.13.1
- provider accounts only if you need live integration testing

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

Do not create a D1 database or run D1 migrations for a new environment. Appwrite TablesDB is the only current authoritative database.

## 2. Keep environments isolated

Provision a different resource set for each environment:

| Resource          | Dev                                       | Staging                                       | Production                                       |
| ----------------- | ----------------------------------------- | --------------------------------------------- | ------------------------------------------------ |
| Cloudflare Worker | dev/local registry and npm proxy          | staging registry/npm names and hostnames      | production registry/npm names and hostnames      |
| Durable Objects   | dev registry/device/rate namespaces       | staging device/rate/admission namespaces      | production device/rate/admission namespaces      |
| Workers KV        | dev namespace                             | staging namespace                             | production namespace                             |
| R2                | `lemonize-artifacts-dev`                  | `lemonize-artifacts-staging`                  | `lemonize-artifacts-prod`                        |
| Appwrite          | dev project/database/bucket/function/keys | staging project/database/bucket/function/keys | production project/database/bucket/function/keys |
| Clerk             | development instance and origins          | staging instance and origins                  | production instance, custom domain, and origins  |
| Vercel            | local/dev project                         | staging project/alias                         | production project/domain                        |

Never use a production key in another environment. Do not let local integration writes fall through to staging: the checked-in default Worker configuration currently contains both staging Appwrite metadata and the staging Clerk issuer, so override both with dedicated dev resources before starting a write-capable Worker.

## 3. Create Cloudflare KV and R2 resources

The bootstrap script prints its plan by default. Review it, authenticate Wrangler to the intended account, then explicitly apply it:

```bash
bash scripts/bootstrap-cloudflare.sh
bash scripts/bootstrap-cloudflare.sh --apply
```

It creates separate KV namespaces and R2 buckets for dev, staging, and production. Record the returned KV IDs and bucket names in the matching local or protected environment configuration. Durable Object classes/migrations are created by the registry and npm-proxy Wrangler deployments. The bootstrap does not create D1 or edit `wrangler.jsonc` for you.

## 4. Provision Appwrite TablesDB and the scanner

Create three Appwrite projects. The checked-in definitions under `infrastructure/appwrite/staging` and `infrastructure/appwrite/production` describe the two protected remote environments. For a live dev environment, make an untracked copy of one definition, change its project metadata to the dedicated dev project, review it, and push it with Appwrite CLI 22.6.1. Never relink the checked-in staging or production file to another project.

The protected deployment performs the equivalent of:

```bash
appwrite client --endpoint "$APPWRITE_ENDPOINT" --project-id "$APPWRITE_PROJECT_ID" --key "$APPWRITE_DEPLOY_API_KEY"
appwrite --force push all --no-logs
bash scripts/ops/deploy-appwrite-scanner.sh
```

Use separate keys with the narrowest provider scopes:

- deploy key: TablesDB/schema, bucket, and function administration; CI/operator only;
- runtime key: required row reads/writes, function execution creation, rejected/expired quarantine cleanup, and expired device-token cleanup; Worker only;
- backup key: policy/archive/restoration operations; backup workflow only;
- scanner: Appwrite's short-lived execution key with `files.read` and `files.write`, not a static API key.

The `quarantine` Storage bucket must remain private with antivirus enabled. The `artifact-scanner` function must use the Appwrite Node 25 runtime, have no public execute role, and share a unique 32-byte-or-longer `SCANNER_SHARED_SECRET` with only its matching Worker. Deployment builds the scanner under the committed pnpm lock, uploads only dependency-free `dist`, and lets Appwrite run `node --check`; Appwrite must not resolve npm dependencies remotely.

## 5. Configure Clerk

For each environment:

1. Create or select the matching Clerk instance.
2. Require the intended account verification and legal-consent flow, then configure the web origin and redirect/callback URLs for that environment only.
3. Set `CLERK_ISSUER` to the exact token issuer and `CLERK_AUTHORIZED_PARTIES` to exact web origins with no paths.
4. Store `CLERK_SECRET_KEY` only as a Worker secret.
5. Configure and test GitHub OAuth. Public publisher eligibility requires Clerk to return a stable GitHub external ID; an account without GitHub remains a consumer.
6. If administrators are needed, set `ADMIN_CLERK_IDS` to exact immutable Clerk subject IDs. Email addresses and GitHub usernames are not administrator identifiers.

The production Clerk instance is not yet provisioned. Its future custom issuer `https://clerk.lemonize.cyou` must not be considered ready until the instance exists, Clerk's DNS setup is complete, and the issuer/JWKS resolve and verify from outside the operator's network.

## 6. Configure local secrets

Copy the examples, keep the resulting files untracked, and replace placeholders with dev-only values:

```bash
cp .env.example .env.local
cp apps/registry-worker/.dev.vars.example apps/registry-worker/.dev.vars
```

At minimum the live Worker needs `APPWRITE_API_KEY`, `CLERK_SECRET_KEY`, and `SCANNER_SHARED_SECRET` as secrets. Its non-secret configuration must point to the dedicated dev Appwrite project, dev KV/R2 resources, dev Clerk issuer/origins, and local web/registry URLs. The web app needs its dev Clerk public configuration and `NEXT_PUBLIC_REGISTRY_URL=http://127.0.0.1:8787`.

Do not commit `.env.local`, `.dev.vars`, Clerk keys, Appwrite keys, Cloudflare tokens, or a provider CLI preference directory.

## 7. Run locally

```bash
pnpm dev:worker # http://127.0.0.1:8787
pnpm dev:npm-proxy
pnpm dev:web    # http://127.0.0.1:3000
pnpm cli:link
```

Check readiness before testing auth:

```bash
curl http://127.0.0.1:8787/ready
curl http://127.0.0.1:8787/v1/limits
```

`lem login` starts a manual device flow. Sign in through Clerk at `/login`, compare the code with your own terminal, and type it manually. The Worker verifies the Clerk session and issues a scope-limited API token; a CLI-supplied username is ignored.

```bash
lem config set registry http://127.0.0.1:8787
lem login
lem info @your-namespace/example
```

For a GitHub-linked public publisher that has accepted the current terms:

```bash
cd path/to/package
# package.json name must be @your-namespace/name
lem publish
```

The publish remains non-public until the Appwrite scanner returns a signed clean result and the Worker promotes the staged bytes to immutable R2 storage. A legacy unscoped package can be installed, but a publisher cannot add a version or change its metadata. Administrator remediation requires an explicitly mutable registry or direct controlled operations.

## 8. Deploy staging and production

Use the protected manual workflow documented in [Operations](operations/DEPLOYMENT.md). Deploy the exact 40-character SHA that passed CI to staging first. Staging should exercise `REGISTRY_MODE=public`; production must remain:

```text
REGISTRY_MODE=read_only
ALLOW_PUBLIC_PUBLISH=false
```

until the explicit cutover approval.

## 9. Publish standalone CLI binaries

Tags named `cli-vX.Y.Z` run the protected release workflow, build Linux/macOS x64 and arm64 plus Windows x64 binaries, publish `@lemonize/cli` through npm trusted publishing, and upload versioned binaries, checksums, and a final `latest.json` pointer to production R2. That workflow requires `CLI_R2_API_TOKEN`, a release-only Cloudflare token with the minimum provider-supported write access to the production CLI release bucket, plus `CLOUDFLARE_ACCOUNT_ID`. The exact GitHub repository/workflow must also be registered as the trusted publisher for the public npm package.

Do not substitute the general Worker deployment token. The release credential is a current external blocker and must be provisioned before the install scripts can be advertised as a completed release path. npm owner authentication, the `@lemonize` organization/package, and the trusted-publisher binding are also absent; the currently signed-out npm CLI is not release evidence.

## 10. Production cutover

Before enabling writes:

1. put the legacy registry into an enforced full-write freeze and verify token issuance and writes are rejected;
2. take the final legacy export and R2 inventory after that freeze;
3. import to TablesDB and reconcile users, ownership, packages, versions, tags, counts, and artifact digests;
4. confirm legacy unscoped packages are readable while new versions and non-admin maintenance are rejected;
5. test Clerk login/device approval, token scopes/revocation, scanner clean/reject/error behavior, and immutable downloads in staging;
6. verify a completed Appwrite backup and a tested restore, plus the separate R2 preservation evidence;
7. complete production Clerk DNS/GitHub OAuth, deploy and resolve the npm proxy, verify its WAF/origin-admission controls, configure npm trusted publishing, and provision the release-only R2 credential;
8. obtain a separate production approval before changing the two read-only controls.

If any check is unresolved, keep serving reads and leave publishing disabled.
