# Lemonize security model

Lemonize treats clients, package archives, browser input, provider callbacks, and migrated data as untrusted. Authorization is enforced by the registry Worker; neither the CLI nor the web app is a security boundary.

## Trust boundaries

- Clerk proves browser identity. Lemonize accepts only a verified Clerk session JWT or a Lemonize API token.
- Appwrite TablesDB is the authoritative application data store. Workers KV is an ephemeral metadata/revocation cache. Durable Objects serialize device approvals and per-principal rate counters.
- R2 and the Appwrite quarantine bucket are private. Artifacts are downloaded through the Worker; bucket listing is not public.
- The Appwrite scanner is a separate execution boundary. It communicates with the Worker through a timestamped, body-bound HMAC protocol.
- The CLI performs a final integrity and extraction check on the consumer's machine.

The current runtime has no D1 binding or D1 query path. Legacy D1 files are migration inputs only and must not be treated as a second live source of truth.

## Clerk identity and manual device approval

`lem login` does not authenticate a username supplied by the CLI. The optional legacy username field is parsed only for backward compatibility and ignored for identity.

The flow is:

1. `/v1/auth/device/start` creates a timestamped random device secret with a domain-separated HMAC derived from `SCANNER_SHARED_SECRET` and then derives the display code. The verification URL does not carry the code; the domain separation is distinct from scanner request signatures.
2. The user signs in on the web app with Clerk, compares the terminal, and manually enters the code. Users must approve only a code they started on their own device.
3. `/v1/auth/device/approve` requires a Clerk browser session. The Worker verifies an RS256 JWT with the configured HTTPS issuer's remote JWKS, exact `iss`, required `sub`/`exp`/`azp` claims, expiry, and an exact `CLERK_AUTHORIZED_PARTIES` origin.
4. The Worker uses `CLERK_SECRET_KEY` server-side to fetch the Clerk user, reject missing, banned, or locked accounts, and obtain profile email plus the stable GitHub external ID required for public publisher eligibility.
5. Poll verifies the device secret's HMAC and server-enforced 10-minute age. The approval is kept in a per-code Durable Object for 120 seconds and consumed in a storage transaction, so a successful poll returns the scoped token at most once across regions. Expired undelivered approvals remove or revoke their token row.

The manual code entry is deliberate: putting the code in a first-party approval URL would let an attacker send a publisher a login-CSRF approval link.

The production Clerk instance does not yet exist. Production setup is not complete until that instance, custom issuer DNS, and GitHub OAuth client are configured and exercised end-to-end. Production publishing remains read-only until all are complete.

## Roles, namespaces, and scopes

In `public` mode, an active Clerk account with a linked GitHub external ID is provisioned as a publisher; an account without GitHub remains a consumer. Email and mutable GitHub username are profile attributes, not authority. `ADMIN_CLERK_IDS` grants administrator role only by immutable Clerk subject. Configure every Clerk environment to enforce its intended email verification, legal consent, and GitHub OAuth path.

The preferred namespace is normalized from the GitHub username. A collision receives a deterministic suffix derived from the stable GitHub external ID. An existing account may adopt that namespace only before it owns a package; after ownership begins, namespace and package coordinates remain frozen across profile changes.

Publishing additionally requires:

- `REGISTRY_MODE=public` and `ALLOW_PUBLIC_PUBLISH=true`;
- an active `publisher` or `admin` role;
- a token with the `publish` scope;
- acceptance of the exact current terms version through the Clerk web session;
- an `@namespace/name` package whose scope matches the authenticated user's immutable Lemonize namespace;
- package ownership for subsequent version or maintenance writes.

Supported API-token scopes are:

| Scope             | Capability                                                                           |
| ----------------- | ------------------------------------------------------------------------------------ |
| `read`            | Reserved/descriptive today; public reads and `/auth/me` do not currently gate on it  |
| `publish`         | Start and complete publishes, subject to role, mode, namespace, and ownership checks |
| `manage:packages` | Package maintenance operations                                                       |
| `manage:tokens`   | List and revoke the account's API tokens                                             |

The automatic device token lasts 30 days. Consumers receive `read` and `manage:tokens`; publishers and admins receive all four scopes. Token creation accepts an explicit scope set and a 1-90 day lifetime. An API-token parent must have `manage:tokens`, cannot delegate a scope it lacks, and caps the child at its own expiry. The active-token limit is ten per account. The runtime validates that stored scopes are recognized, but only publish and management routes currently enforce a capability scope.

Legacy unscoped packages are compatibility data only. They remain readable and downloadable, while the publish path rejects an unscoped name and non-admin maintenance requires a non-empty package scope matching the authenticated namespace. Administrators retain an explicit remediation override only when the registry is mutable; production `read_only` rejects every HTTP package-mutation route before that override.

## API-token storage and revocation

- Tokens are high-entropy opaque values prefixed `lem_live_`; the raw credential is returned once.
- Appwrite TablesDB stores a SHA-256 digest, display prefix, scopes, expiry, and revocation state, never the raw token.
- Every API-token request checks the authoritative token row, expiry, recognized stored scope set, and current TablesDB user state, then runs the Clerk active-account check. Publish and management middleware enforce their specific capability scopes.
- KV accelerates known revocations and caches a positive Clerk active-account result for up to 15 minutes (a negative result for 60 seconds). It does not replace TablesDB or Clerk as the authority.
- `lem token list/create/revoke/revoke-all` exposes token lifecycle controls. Creation returns the raw token once; list responses expose only metadata/prefixes. The browser API also has a fresh-Clerk-session revoke-all route.
- Logging and audit records must never contain bearer tokens, Clerk JWTs, API keys, upload capabilities, or raw IP addresses.

## Appwrite data plane and provider credentials

TablesDB stores users, API tokens, packages, versions, tags, reservations, scan jobs, counters, and audit events. Appwrite's server API key is available only to the Worker; browsers and the CLI never receive it.

Provider credentials are split by responsibility and environment:

- `APPWRITE_DEPLOY_API_KEY`: protected CI only; schema and function administration.
- `APPWRITE_RUNTIME_API_KEY`: injected into the Worker as `APPWRITE_API_KEY`; only required row reads/writes, scanner execution creation, rejected/expired quarantine cleanup, and expired device-token cleanup from its Durable Object.
- `APPWRITE_BACKUP_API_KEY`: backup policy, archive, and restoration operations only.
- the scanner uses Appwrite's execution-scoped injected key with only `files.read` and `files.write`; it does not store a long-lived Appwrite key.

Dedicated dev, staging, and production Appwrite projects and keys are the required target. The checked-in default dev Worker configuration currently points at staging Appwrite and Clerk metadata, so local integration must override both before making writes. Protected staging/production deploys reject an Appwrite project ID that does not match the selected checked-in definition; operators must verify the remaining cross-provider isolation.

## Artifact quarantine and promotion

Every new version stays non-public until the scanner completes:

1. A short-lived upload capability is bound to one reservation and a random `staging/` R2 key; conditional R2 creation prevents it from overwriting an existing stage.
2. TablesDB records the reservation, expected hashes and sizes, version state, and scan job before dispatch.
3. Worker-to-scanner requests and scanner callbacks use HMAC-SHA256 over the timestamp, method, path/query, and SHA-256 of the exact body. Signatures expire after a short clock-skew window and are compared in constant time.
4. The scanner bounds request and archive sizes, recomputes SHA-256 and SHA-512, verifies gzip/tar checksums and termination, accepts only regular files/directories under `package/`, rejects links and unsafe or duplicate paths, validates `package.json` identity, and enforces declared file/unpacked-size limits.
5. A structurally valid archive is uploaded under a content-derived ID to a private Appwrite bucket with antivirus enabled. A rejected quarantine upload is not clean.
6. The Worker accepts only a signed result matching the pending job, version, hashes, counts, sizes, and canonical manifest digest. It then conditionally creates the content-addressed immutable R2 key, writes published metadata, deletes the staging copy, and retains the antivirus-accepted Appwrite copy as an independent recovery source. Rejected and expired copies are deleted.

Scanner errors and timeouts retry in bounded scheduled batches and fail closed. Rejected or inconsistent results never become downloadable versions.

## Delivery and installer safety

- Published R2 keys contain package ID, version ID, and SHA-256. Existing keys cannot be overwritten with different content.
- A normal soft-yank removes a version from fresh tag/range resolution but preserves exact-version downloads for existing lockfiles. A security block uses authoritative version state plus a fast KV tombstone and denies every download, including an exact version.
- Full downloads use immutable cache headers. Range requests bypass the Worker cache and stream from private R2.
- The CLI verifies SHA-512 SRI before extraction.
- Extraction rejects absolute paths, traversal, Windows drive paths, backslashes, control characters, symlinks, hardlinks, special entries, duplicate paths, and entries outside `package/`.
- Lemonize never runs `preinstall`, `install`, `postinstall`, or another package lifecycle script.

## Network and application controls

- CORS uses exact configured origins and must never be `*` in production.
- Authenticated and private responses are `private, no-store`.
- Security headers include HSTS, `X-Content-Type-Options`, `X-Frame-Options`, and a restrictive referrer policy.
- Request bodies use schema validation and explicit byte limits.
- Per-IP and per-token authentication/read/write/upload limits use one Durable Object per hashed principal and class. Storage transactions serialize each one-minute fixed-window counter across Worker isolates. They remain an abuse guard, not a provider billing firewall or adaptive WAF.
- A conditional private-R2 lock serializes global reservation checks. The Worker recomputes published plus live-reserved bytes from TablesDB and rejects a reservation above `MAX_GLOBAL_ARTIFACT_BYTES`; production may configure no more than 70% of the lower verified R2/Appwrite entitlement and never more than 7 GiB.
- Package publish/maintenance and token create/revoke/revoke-all paths attempt bounded, non-secret audit records, generally as best-effort writes. Logout and some failure/lifecycle edges are not yet fully covered by the audit log.

## Public npm proxy boundary

`npm.lemonize.cyou` is a separate read-only Worker with an explicit route/method allowlist. It strips credentials and cookies, follows only safe npmjs redirects, preserves tarball bytes/integrity, and never persists npm content in R2, KV, or Appwrite. Cache misses require a transactionally serialized Durable Object admission decision with hashed client-IP, global, and route-specific origin budgets; unavailable admission fails closed.

Free mode rewrites tarball URLs only for successful packuments at or below 256 KiB. Larger packuments stream without rewriting up to a 16 MiB hard cap, so their tarballs can bypass Lemonize and go directly to npmjs. Complete tarballs are capped at 100 MiB. An origin Range miss is not cached as a partial object. Cloudflare WAF/rate rules must protect the hostname before Worker execution; those provider-side rules are a production gate, are not provisioned by the Worker configuration, and require DNS/WAF authority absent from the current OAuth session.

## Production cutover rule

Production must remain `REGISTRY_MODE=read_only` and `ALLOW_PUBLIC_PUBLISH=false` through migration and validation. This blocks every HTTP package publication and maintenance mutation, including soft-yank, for publishers and administrators. Auth/device/token routes still update identity data, so block those separately or take the Worker offline when a transactionally quiet full-database snapshot or restore is required. Place the legacy registry into an enforced full-write freeze before the final migration snapshot; reconcile record counts and artifact digests, exercise Clerk login and scanner rejection/clean paths, verify a restorable backup, and only then approve a separate write-enable change. A successful code deployment alone is not authorization to enable publishing.

See [Known limitations](KNOWN_LIMITATIONS.md) and the [deployment runbook](operations/DEPLOYMENT.md) for open blockers and operational gates.
