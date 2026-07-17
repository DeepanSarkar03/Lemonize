# Appwrite TablesDB backup and restore runbook

Lemonize uses Appwrite CLI 22.6.1's native backup API. The `lemonize-12h` policy runs at `17 */12 * * *` UTC, backs up Appwrite `tablesdb`, `functions`, and `storage`, and retains archives for seven days. Appwrite executes the schedule; GitHub Actions is only the protected control plane for reconciling and inspecting it. No current runtime data is backed up from D1 because D1 is not a runtime store.

Provider plans and backup availability change. The workflow fails visibly if the selected Appwrite project cannot use native backups; it never reports an export that did not happen. Confirm backup availability and storage charges before production use. If the provider rejects the policy on the current plan, treat production backup readiness as blocked rather than silently upgrading or relying only on checked-in resource definitions.

## Configure and verify

1. Run `.github/workflows/appwrite-backup.yml` for `staging` with operation `reconcile`.
2. After the first scheduled run, run `verify` and confirm the newest archive is `completed`, covers all three services, has a nonzero size where applicable, and is newer than 13 hours.
3. Repeat for `production` after approval.
4. Alert operationally if no completed production archive exists within 13 hours. The workflow does not create paid resources or change plans.

`create` requests an additional on-demand archive before a risky maintenance window. Archive creation is asynchronous; run `verify` until its status becomes `completed`. `pending`, `processing`, and `uploading` are not restorable completion signals; investigate `failed` or `skipped`.

For local administration, install the pinned CLI, export `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, and the dedicated `APPWRITE_BACKUP_API_KEY` without echoing them, and run:

```sh
npm install --global appwrite-cli@22.6.1
bash scripts/ops/appwrite-backup.sh reconcile
bash scripts/ops/appwrite-backup.sh verify
```

## Restore

1. Declare an incident and set the affected registry to `REGISTRY_MODE=read_only` with `ALLOW_PUBLIC_PUBLISH=false`; verify every package mutation, including unpublish, is rejected. Also block auth/device/token writes at the edge or take the Worker offline for a transactionally quiet full-database restore.
2. Select a `completed` archive created before the incident. Record its ID, creation time, services, resources, and size.
3. Confirm the Appwrite CLI is linked to the intended project. The production and staging project IDs must never match.
4. Prefer a new resource ID/name for a resource-scoped database or bucket archive when Appwrite supports it. Validate the restored resource before changing bindings. For a project-wide in-place restore, require a second operator and accept the provider confirmation only after checking the archive again.
5. Start the restoration:

```sh
appwrite backups create-restoration \
  --archive-id <archive-id> \
  --services tablesdb functions storage
```

6. Capture the returned restoration ID and poll without exposing credentials:

```sh
appwrite backups get-restoration --restoration-id <restoration-id>
```

7. Do not resume write traffic until restoration is complete and counts, user-to-Clerk bindings, token revocation/expiry, ownership, representative records, file hashes, scanner version/scopes, authorization rules, and application smoke tests pass. Public reads may resume earlier only if incident command confirms they are safe.

Test restoration quarterly in staging with non-production resources and synthetic data. A policy that has never produced and restored a completed archive is not a verified backup.

## Scope boundary

Appwrite archives do not cover Cloudflare KV, R2, Cache API, or Durable Objects. Published versions retain their antivirus-accepted Appwrite Storage copy, and Appwrite backups cover that copy, but preserve immutable R2 artifacts separately before destructive maintenance, including object keys, sizes, custom digest metadata, and a sample/full digest verification appropriate to the incident. Treat KV revocation/metadata cache, npm edge cache, expired device approvals, and fixed-window rate/admission ledgers as reconstructable ephemeral state. Do not claim the Appwrite policy as direct recovery coverage for Cloudflare bindings.

After a restore, verify every published version's `archiveFileId` resolves to the retained clean Appwrite Storage object and that its size/digests agree with TablesDB and R2. Missing recovery copies are an incident to reconcile; do not silently delete the field or label a rejected/expired object as clean.

Publisher/global quota locks in R2 are short-lived coordination objects, not accounting records. Recompute published and live-reserved bytes from the restored TablesDB, confirm the result is below `MAX_GLOBAL_ARTIFACT_BYTES`, and clear only a verified stale lock before write traffic resumes. Never restore an old lock object as application data.

Restore only into the matching environment. A staging restore test must use staging or isolated restore resources and synthetic data; it must never consume the production runtime key or production Clerk configuration.
