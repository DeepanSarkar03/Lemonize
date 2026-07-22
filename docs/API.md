# Lemonize Registry API

Development base URL: `http://127.0.0.1:8787`  
Production base URL: `https://registry.lemonize.cyou`

Application endpoints are under `/v1`. Production currently uses `REGISTRY_MODE=read_only` and `ALLOW_PUBLIC_PUBLISH=false`: package creation, publication, dist-tag changes, deprecation, and soft-yank are disabled for every caller, including administrators.

## Conventions

- Public package metadata and downloads do not require authentication.
- A Clerk browser session JWT or Lemonize `lem_live_...` API token uses `Authorization: Bearer <credential>`.
- Publish and management routes additionally enforce `publish`, `manage:packages`, or `manage:tokens` as applicable. `read` is currently descriptive/reserved; public reads and `/auth/me` do not require it.
- Uploads use the short-lived, reservation-bound `X-Lemonize-Upload-Token` capability returned by the publish intent; it is deliberately excluded from the URL.
- Scoped names in paths are URL-encoded: `@demo/utils` becomes `@demo%2Futils`.
- Errors use a request ID that is also returned in `X-Request-Id`:

```json
{
  "error": {
    "code": "PACKAGE_NOT_FOUND",
    "message": "Package @demo/utils was not found",
    "requestId": "01J..."
  }
}
```

- Public metadata can return `X-Lemonize-Cache: HIT | MISS | BYPASS`.
- Authentication and token responses are `private, no-store`.

## Health and public metadata

| Method | Path                                   | Description                                                          |
| ------ | -------------------------------------- | -------------------------------------------------------------------- |
| `GET`  | `/health`                              | Process liveness; does not check providers                           |
| `GET`  | `/ready`                               | Appwrite TablesDB, KV, and R2 readiness; returns `503` when degraded |
| `GET`  | `/v1/limits`                           | Effective feature flags and archive/rate limits                      |
| `GET`  | `/v1/search?q=`                        | Search public packages                                               |
| `GET`  | `/v1/packages/:name`                   | Public package metadata, versions, tags, and maintainers             |
| `GET`  | `/v1/packages/:name/versions/:version` | Exact version, semver range, or dist-tag resolution                  |
| `GET`  | `/v1/packages/:name/readme`            | README Markdown                                                      |
| `GET`  | `/v1/packages/:name/downloads`         | Daily and total download counts                                      |

The native Lemonize API is intentionally not npm-compatible. Public npm clients use the separate, route-limited endpoint documented in [npm CDN proxy](NPM_PROXY.md).

## Artifact downloads

| Method | Path                                                     | Description                                                                                                                    |
| ------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/v1/packages/:name/versions/:version/tarball`           | Streams the private R2 `.tgz` through the Worker with immutable headers, `ETag`, Range support, integrity, and version headers |
| `GET`  | `/v1/packages/:name/versions/:version/tarball/:filename` | Same bytes with an explicit safe download filename                                                                             |

Full responses can use the Worker cache. Range responses stream from R2 and return `206`; they are not placed in the full-object cache.

## Authentication and API tokens

| Method   | Path                      | Auth                 | Description                                                                                                                                 |
| -------- | ------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/v1/auth/device/start`   | Public               | Creates a timestamped, HMAC-authenticated device secret/display code with a server-enforced 10-minute lifetime and returns `/login`         |
| `POST`   | `/v1/auth/device/approve` | Valid Clerk session  | The signed-in user manually submits the display code; the Worker verifies the unexpired Clerk JWT and active account before issuing a token |
| `POST`   | `/v1/auth/device/poll`    | Signed device secret | Verifies signature/expiry and returns `pending`, or atomically consumes the 120-second Durable Object approval and returns its token        |
| `GET`    | `/v1/auth/me`             | Clerk or API token   | Returns the current Lemonize user                                                                                                           |
| `POST`   | `/v1/auth/logout`         | Clerk or API token   | Revokes the presenting API token and its direct children when it is a root; a Clerk-session request does not terminate Clerk itself        |
| `POST`   | `/v1/tokens`              | `manage:tokens`      | Creates a 1-90 day token and returns the raw value once; API-created children cannot receive `manage:tokens`, exceed the root's scopes, or outlive it |
| `GET`    | `/v1/tokens`              | `manage:tokens`      | Lists active metadata/prefixes; an API root sees only itself and its children, while a Clerk session sees every account token               |
| `DELETE` | `/v1/tokens/:id`          | `manage:tokens`      | Revokes a token; an API root is confined to itself and its direct children, while a Clerk session can revoke any account token              |
| `DELETE` | `/v1/tokens`              | Valid Clerk session  | Revokes all active tokens owned by the account                                                                                              |
| `POST`   | `/v1/tokens/revoke-all`   | Valid Clerk session  | Compatibility form of revoke-all                                                                                                            |

Supported API-token scopes are `read`, `publish`, `manage:packages`, and `manage:tokens`. A device token lasts 30 days. Consumers receive `read` and `manage:tokens`; GitHub-linked publishers/admins receive all four scopes. These Clerk/device-issued credentials are roots. An API-created child never receives `manage:tokens`, and every request made with it revalidates the active root, so revoking or expiring the root invalidates the child. `read` is reserved/descriptive today; token authentication validates the stored scope set, while only publish/manage routes enforce a capability scope.

In public mode, publisher eligibility comes from a stable GitHub external ID returned by Clerk, not an email, username supplied by a client, or mutable GitHub username. `ADMIN_CLERK_IDS` grants administrator role by immutable Clerk subject. New accounts enter the current Clerk legal-consent flow; existing accounts must accept the exact current terms version through a Clerk browser session before publishing.

## Account and dashboard

All responses below are authenticated and `private, no-store`:

| Method | Path                                          | Description                                                                      |
| ------ | --------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET`  | `/v1/account`                                 | Account, namespace, GitHub-link, terms, role, and publishing-eligibility summary |
| `POST` | `/v1/account/terms`                           | Accept the exact current terms version with a Clerk browser session              |
| `GET`  | `/v1/account/packages`                        | Owned packages and bounded version summaries                                     |
| `GET`  | `/v1/account/usage`                           | Package, version, storage, and active-publish usage with beta limits             |
| `GET`  | `/v1/account/audit?limit=`                    | The caller's bounded audit-event list                                            |
| `GET`  | `/v1/packages/:name/versions/:version/status` | Owner/admin publish and scan status                                              |
| `GET`  | `/v1/publish/status/:versionId`               | Owner/admin status lookup by version row ID                                      |
| `POST` | `/v1/reports`                                 | File an authenticated package/version abuse report                               |

## Publishing

| Method | Path                                            | Auth                                      | Description                                                                                      |
| ------ | ----------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST` | `/v1/packages`                                  | Publisher + `publish`                     | Creates a public namespace-scoped package                                                        |
| `POST` | `/v1/packages/:name/versions`                   | Publisher + `publish`                     | Reserves an immutable version and returns a 10-minute upload URL/capability                      |
| `PUT`  | `/v1/uploads/:reservationId`                    | Upload capability                         | Streams the exact declared byte count into a random private R2 staging key                       |
| `POST` | `/v1/packages/:name/versions/:version/finalize` | Publisher + `publish` + upload capability | Verifies the staged object and queues scanning; normally returns `202` with `status: "scanning"` |

Publishing also requires `REGISTRY_MODE=public`, `ALLOW_PUBLIC_PUBLISH=true`, current terms, an active publisher/admin role, ownership, and an `@namespace/name` matching the caller's immutable Lemonize namespace. Public publishers must have a linked GitHub identity. Private package publication is disabled.

The public-beta account limits are five packages, twenty versions per package, two concurrent reservations, 10 MiB per artifact, and 100 MiB published plus reserved bytes. A serialized global gate also rejects a reservation that would exceed `MAX_GLOBAL_ARTIFACT_BYTES`; its checked-in value is 1 GiB until verified storage entitlements justify a value no greater than 70% of the lower R2/Appwrite allowance and never above 7 GiB.

### Publish state flow

1. The CLI packs the project and computes SHA-512 SRI, SHA-256, compressed size, unpacked size, and file count.
2. The publish-intent endpoint validates the manifest, namespace, role/token scope, ownership, quotas, limits, semver, and version uniqueness. It writes package/reservation/version state to Appwrite TablesDB before returning a short-lived upload capability bound to that reservation.
3. The upload endpoint hashes the capability, resolves the reservation in TablesDB, and streams into a conditional private R2 staging write. A conflicting or wrong-sized object fails closed.
4. Finalize verifies ownership, capability, reservation, package/version identity, and staged object size. It creates or resumes a TablesDB scan job and asynchronously invokes the private Appwrite `artifact-scanner` function.
5. The scanner downloads through an HMAC-authenticated internal endpoint, recomputes hashes, validates gzip/tar structure and manifest identity, and uploads to the antivirus-enabled Appwrite quarantine bucket.
6. A signed, matching `clean` callback lets the Worker conditionally copy to an immutable content-addressed R2 key and mark the version published in TablesDB. Its antivirus-accepted Appwrite Storage copy is retained for recovery. Rejected, inconsistent, or exhausted jobs remain non-public and their quarantine copies are removed during bounded cleanup.

TablesDB state transitions are retryable and reconciled by a scheduled Worker; they are not a D1 transaction. Workers KV contains only ephemeral metadata/revocation cache. Durable Objects serialize single-use device approvals and fixed-window rate counters.

## Package maintenance

All routes below require an active publisher/admin, `manage:packages`, and package ownership (or admin):

| Method   | Path                                | Read-only behavior | Description                                                                                                                  |
| -------- | ----------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/v1/packages/:name/dist-tags`      | Rejected           | Sets `{ tag, version }` for a published, non-yanked version                                                                  |
| `DELETE` | `/v1/packages/:name/dist-tags/:tag` | Rejected           | Removes a tag other than `latest`                                                                                            |
| `POST`   | `/v1/packages/:name/deprecate`      | Rejected           | Sets or clears `{ version, message }`                                                                                        |
| `POST`   | `/v1/packages/:name/unpublish`      | Rejected           | When mutable, soft-yanks `{ version, force }`, removes matching tags, recomputes latest metadata, and retains artifact bytes |

A normal soft-yank removes the version from new range/tag resolution but preserves an exact, previously locked tarball download. A separate security-blocked version is not downloadable, including by an exact lock. Artifact bytes are never overwritten in either case.

Legacy unscoped packages are publisher-read-only. New unscoped versions are rejected, and non-admin maintenance requires a non-empty package scope matching the caller's namespace. An administrator can remediate imported data only after an explicitly reviewed switch to a mutable mode or through controlled provider operations; `read_only` rejects the HTTP route before the admin override is considered.

## Internal scanner protocol

`GET /internal/v1/scan-jobs/:jobId/artifact` and `POST /internal/v1/scan-jobs/:jobId/result` are not public API. They require a timestamped HMAC-SHA256 signature bound to method, path/query, and exact body. Do not expose `SCANNER_SHARED_SECRET` to clients or call these endpoints as an operator shortcut.

## Worker configuration

Important non-secret variables:

- policy: `REGISTRY_MODE`, `ALLOW_PUBLIC_PUBLISH`, `ALLOW_PRIVATE_PACKAGES`, `ADMIN_CLERK_IDS`;
- limits: `MAX_TARBALL_SIZE_BYTES`, `MAX_UNPACKED_SIZE_BYTES`, `MAX_PACKAGE_FILES`, serialized `MAX_GLOBAL_ARTIFACT_BYTES`, and read/write rate limits;
- public origins: `REGISTRY_BASE_URL`, `WEB_BASE_URL`, `CORS_ALLOWED_ORIGINS`;
- Appwrite: endpoint, project, TablesDB ID, quarantine bucket, scanner function;
- Clerk: issuer and exact authorized parties.

Worker secrets are `APPWRITE_API_KEY`, `CLERK_SECRET_KEY`, and `SCANNER_SHARED_SECRET`. `DEVICE_APPROVALS` and `RATE_LIMITS` are Durable Object bindings; `KV` is not used for their authoritative state. There is no publisher email/username allowlist and no D1 runtime binding.
