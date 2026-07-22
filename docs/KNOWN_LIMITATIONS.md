# Known limitations

Production is deliberately in read-only cutover mode. These limitations are operational constraints, not permission to weaken authentication, scanning, or environment isolation.

## Current external blockers

| Blocker                                                        | Impact                                                                                                                                                                    | Exit condition                                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Production Clerk interactive launch drills are incomplete      | Custom domains, TLS/JWKS, mail DNS, and public GitHub OAuth configuration are present, but delivery, callback handling, and the full publisher path are not launch-proven | Test email delivery, first-user GitHub login and callback, lockout, linking, terms acceptance, active-user lookup, and device approval         |
| `ADMIN_CLERK_IDS` is empty                                     | Emergency HTTP security blocking has no authorized operator                                                                                                               | Complete the owner's first production sign-in, record the immutable Clerk subject, set the protected variable, and test an exact-version block |
| `npm.lemonize.cyou` lacks hostname-scoped WAF rules            | DNS, TLS, Cache API, installs, HEAD, and Range are live, but abusive requests still reach the Worker                                                                      | Use a narrow token with zone WAF/rulesets edit, apply the documented hostname rules, and record allow/deny tests                               |
| Long-lived Cloudflare and Vercel CI tokens are not provisioned | The protected deployment workflow cannot run unattended                                                                                                                   | Create least-privilege provider tokens; do not store the expiring interactive OAuth sessions as GitHub secrets                                 |
| npm trusted publishing is not configured                       | `@lemonize/cli@0.1.0` is public, but subsequent protected OIDC releases are blocked                                                                                       | Bind `DeepanSarkar03/Lemonize`, `release-cli.yml`, and secret-free environment `npm-release` as the package's trusted publisher                |
| End-to-end launch drills are incomplete                        | Publishing and recovery are implemented but not yet launch-proven                                                                                                         | Pass GitHub-linked staging auth/terms/device/publish/rejection/block tests, obtain a completed archive, and restore it in non-production       |

Production stays `REGISTRY_MODE=read_only` with `ALLOW_PUBLIC_PUBLISH=false` until these blockers and the migration/restore/scanner gates are closed.

## Legacy migration and ownership

The former D1 database is a one-time migration source, not a live runtime dependency. There is no dual-write or reverse synchronization between legacy D1 and Appwrite TablesDB.

Migrated accounts use legacy identity placeholders until an operator reconciles them to a real Clerk/GitHub identity. Before write cutover, reconcile every owned package to a stable Clerk subject and GitHub external ID, record exceptions, and leave unresolved owners frozen. Put the legacy registry into enforced read-only mode before the final export so a new token or write cannot race the snapshot.

Public publisher eligibility requires a GitHub external ID returned by Clerk. Email and GitHub username are profile data, not publisher authority; administrators are identified only by immutable Clerk subjects in `ADMIN_CLERK_IDS`. Each Clerk instance must enforce its configured verification and legal-consent path, and cutover must prove an unverified account cannot complete sign-in.

Unlinking GitHub or changing an administrator list is reconciled when the user next authenticates; it does not proactively rewrite every stored user row or revoke existing tokens. During an incident, keep the registry read-only, revoke affected tokens, explicitly demote or suspend the TablesDB user, and verify the result instead of waiting for another login.

A namespace derived from a GitHub username is frozen once the account owns a package. A later username change does not rename packages. If the preferred namespace is occupied, the Worker uses a deterministic suffix derived from the stable GitHub external ID; there is no manual vanity-namespace claim flow in this beta.

Legacy unscoped packages remain readable and downloadable for compatibility. The current publish path requires `@namespace/name`, so it cannot add new unscoped packages or versions. Non-admin maintenance requires a non-empty package scope matching the authenticated namespace, so publishers cannot change imported unscoped package metadata. Administrators retain a deliberate remediation override, but only after the registry is explicitly changed to a mutable mode or through direct controlled operations; production `read_only` blocks all HTTP package mutations first.

`REGISTRY_MODE=read_only` is a hard package-mutation freeze, not a full account-data freeze. Clerk login, device approval, token creation/revocation, and usage timestamps can still write identity/token data. Block those routes or take the Worker offline when a transactionally quiet full-database snapshot or restore is required.

## Dev environment isolation is not fully scaffolded

Checked-in Appwrite definitions exist for staging and production. The default dev Worker configuration currently reuses staging Appwrite project metadata and the staging Clerk issuer, even though its KV/R2 bindings are dev-specific. Local integrated development still needs its own Appwrite project, database, quarantine bucket, scanner function, API keys, Clerk instance, KV namespace, and R2 bucket. Override both Appwrite and Clerk dev values before making writes.

## Scanner coverage is bounded

The scanner verifies hashes, gzip/tar structure, path safety, manifest identity, counts, sizes, and acceptance by an Appwrite antivirus-enabled quarantine bucket. It does not prove package source provenance, analyze arbitrary JavaScript behavior, execute the package in a sandbox, or guarantee detection of every malicious payload.

The scanner validates the archive's `package.json` identity and safe paths. The signed scan protocol also compares a canonical SHA-256 digest of the complete archive manifest with the client-declared metadata stored in TablesDB. This revision is deployed in both Appwrite projects, but clean and rejected end-to-end staging executions remain launch gates before production publishing is enabled.

Next step: add signed provenance/attestations and, if risk warrants it, a separately isolated static-analysis or sandbox stage. Continue to keep lifecycle scripts disabled.

## Private packages are not production-ready

`ALLOW_PRIVATE_PACKAGES` is disabled. The data model contains visibility and organization groundwork, but end-to-end private-download authorization, organization membership, and scoped private caching have not completed production review.

Next step: implement and test authorization on metadata, tarball, cache, and token paths before enabling the flag.

## Device approval is intentionally manual

The code is not placed in the approval URL. A signed-in Clerk user must type the code displayed by `lem login`, which reduces approval-link login CSRF but adds a manual step and requires a browser.

Device starts are stateless but timestamped and HMAC-authenticated. Poll rejects a tampered secret or one older than ten minutes, and the approval exists in a per-code Durable Object for only 120 seconds. Durable Object serialization and a storage transaction make delivery at most once across isolates. If delivery expires, the object removes or revokes the unreachable token row. There is no unattended service-account device flow. Use explicitly scoped API tokens for automation and rotate them normally.

A Clerk credential-issuance route requires a valid, unexpired Clerk JWT but does not impose an additional maximum session age or step-up reauthentication. Configure Clerk session lifetimes appropriately; add an `iat`/authentication-age policy before calling this a fresh-session control.

## The `read` token scope is reserved

API tokens must contain recognized scopes, and publish/token/package-management routes enforce their capability scopes. Public reads require no credential, and `/auth/me` currently accepts any otherwise valid API token, so `read` is descriptive/reserved rather than an enforced gate.

## Clerk suspension checks use a bounded cache

For Lemonize API-token requests, a positive Clerk active-account result can remain in KV for up to 15 minutes; negative results are cached for 60 seconds. A newly locked or banned Clerk account may therefore retain an already-issued token until the positive cache expires unless an operator also revokes the Lemonize token or suspends the TablesDB user.

During an identity incident, set the registry read-only, revoke the Lemonize token/user immediately, and do not rely only on the Clerk change propagating through the cache.

## Audit coverage is incomplete

Publish, package-maintenance, and token create/revoke/revoke-all paths attempt audit entries, but several are best-effort. Logout and some failure/lifecycle edges do not create complete events. Provider logs and TablesDB token state remain necessary during an investigation.

Next step: make required security events durable without failing package safety actions when the audit sink is temporarily unavailable.

## Provider availability affects publishing

New versions depend on Cloudflare R2, Appwrite TablesDB, Appwrite Functions, Appwrite Storage antivirus, and Clerk account status. The publish state machine fails closed and retries bounded scanner failures, but a provider outage can leave a version in scanning/failed state until maintenance retries or an operator intervenes.

Published, cached downloads are the preferred degradation path. Do not bypass the scanner or write metadata manually to restore publishing during an outage.

## Public discovery is client-rendered

Cloudflare challenges Vercel's server-side egress to the public registry. Package detail and search data therefore load in the browser through the Worker's exact-origin CORS allowlist. The page shells and security headers are server-rendered, but crawlers and clients without JavaScript do not receive package data. If server rendering becomes necessary, add a separately authenticated origin path or provider-native service connection; do not re-enable a public `workers.dev` bypass.

## Backup scope is split

The Appwrite backup policy covers TablesDB, functions, and Storage only. It does not include Cloudflare R2, KV, Cache API, or Durable Objects. KV cache, device approvals, rate counters, and npm admission ledgers are reconstructable ephemeral state; immutable R2 artifacts require a separate preservation and digest-verification procedure. Native backup availability and pricing depend on the selected Appwrite plan.

No backup is considered ready until a completed archive has been restored and verified in non-production.

## Rate limiting is fixed-window, not a billing firewall

Registry authentication, read, write, and upload counters use one Durable Object per hashed principal and request class. Concurrent isolates therefore share a serialized fixed-window decision. The policy is still a simple one-minute window: it is not adaptive abuse detection, does not prevent distributed traffic across many principals, and every request reaches the Worker before the counter runs.

The npm proxy separately serializes cache-miss admission with global and route-specific minute/day budgets. Cloudflare WAF/rate rules and provider usage alerts are still required to protect the Worker request allowance and fail before execution.

## Native registry Range responses are not edge-cached

Full native Lemonize artifacts can use the Worker Cache API. Native Range requests stream directly from R2, so repeated partial reads may consume additional R2 operations. The npm proxy can satisfy a Range from an already cached complete npm tarball, but it does not store an origin partial response as a separate cache entry.

## npm compatibility is a separate, limited proxy

The native Lemonize registry uses its own API, lockfile, CLI, token format, and namespace policy. Standard npm clients cannot publish native Lemonize packages.

`npm.lemonize.cyou` is a separate public, download-only npmjs proxy. It supports package metadata, tarballs, search, ping, and two audit endpoints, but not login, users, tokens, teams, stars, download statistics, replication feeds, or mutations. In free mode, successful packuments larger than 256 KiB (up to the 16 MiB hard cap) use bounded streaming URL-prefix rewriting rather than full-document JSON buffering. Only exact official npm registry URLs are rewritten; origin Range misses are not stored as partial cache entries. See [npm CDN proxy](NPM_PROXY.md).

## Free tiers are not a capacity guarantee

Provider quotas, backup eligibility, antivirus behavior, Vercel plan eligibility, and pricing can change. The current limits target development and a small beta, not unlimited free hosting. Follow the [budget guardrails](operations/FREE_TIER_BUDGETS.md) and obtain approval before a paid upgrade.

Per-account package/version/storage/concurrency quotas and the serialized `MAX_GLOBAL_ARTIFACT_BYTES` reservation gate are enforced in the Worker. The checked-in global limit is a conservative 1 GiB until both storage entitlements are verified; an operator may raise it only to 70% of the lower R2/Appwrite entitlement and never above 7 GiB.
