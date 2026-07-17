# Key rotation runbook

Rotate production deployment credentials at least every 90 days and immediately after suspected disclosure, maintainer departure, accidental log output, or an unexpected provider action.

## Safe sequence

1. Inventory the credential's provider, owner, scopes, GitHub environment, creation time, and last use. Never copy its value into the inventory.
2. Create a replacement with the minimum scopes and an expiry where supported. Keep staging and production credentials separate.
3. Update only the matching protected GitHub environment secret.
4. Run a non-destructive check: Wrangler dry-run for Cloudflare, Vercel project pull/build for Vercel, or Appwrite backup `verify`/config validation for Appwrite.
5. Complete one protected staging deployment. For a production-only key, obtain approval and run the smallest read-only production verification available.
6. Revoke the old credential, then confirm it can no longer authenticate.
7. Record actor, UTC time, credential identifier/fingerprint, scopes, verification run, and revocation. Do not record the secret.

## Provider notes

- Cloudflare: scope the token to the single account and required Worker/R2/KV/zone resources. Provider-side npm-hostname WAF/rate rules and Durable Object migrations are configuration, not secrets; record and re-verify them after changing deployment credentials. Rotate the account identifier only if account ownership changes.
- CLI releases: rotate `CLI_R2_API_TOKEN` independently from the deployment token. It belongs only to the protected production release job and may write only the CLI release object prefix/bucket. It must never enter the Worker, scanner, or general deploy job.
- Vercel: scope the token to the intended account/team, and keep `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` as non-secret environment variables. Remove stale project members separately.
- Appwrite: rotate `APPWRITE_DEPLOY_API_KEY`, `APPWRITE_RUNTIME_API_KEY`, and `APPWRITE_BACKUP_API_KEY` independently. The deploy key may administer checked-in schemas/functions but must never enter the Worker; the runtime key is limited to required rows, files, and execution calls; the backup key is limited to backup operations. Validate project ID matching before revoking a prior key.
- Clerk: rotate `CLERK_SECRET_KEY` in only the matching Worker environment, then verify issuer/JWKS validation, exact authorized-party origins, active-user lookup, GitHub external-ID mapping, legal consent, manual device approval, and locked-user rejection. A GitHub unlink or `ADMIN_CLERK_IDS` change is reconciled on the user's next authentication; for an incident, revoke tokens and explicitly demote or suspend the TablesDB user. Never replace Clerk verification with an email or username allowlist during rotation.
- Scanner/device signing: rotate `SCANNER_SHARED_SECRET` as a coordinated Worker/function change while publishing is read-only. Rotation invalidates outstanding signed device codes, so users must restart `lem login`; already stored approvals remain unreachable and their Durable Object alarms remove or revoke the undelivered token rows. Verify old scanner signatures fail, new clean/rejected callbacks succeed, and new device codes validate before enabling staging writes.
- Lemonize API tokens: users should create a replacement with only the required scopes, update the consumer, then revoke the old token. `read` is currently reserved/descriptive; `publish`, `manage:packages`, and `manage:tokens` are enforced capabilities. Creation responses expose the raw token once, and Durable Object device delivery is atomic at-most-once; never copy either into audit records.
- npm publishing: `@lemonize/cli` uses GitHub OIDC trusted publishing and has no long-lived npm token to rotate. Review or replace the npm trusted-publisher binding itself, and verify it still names the exact repository and release workflow.
- GitHub: environment reviewers should rotate/revoke secrets; ordinary workflow logs must never print them. Re-run the full-history secret scan after cleaning any committed secret, and rotate the secret even if history is rewritten.

If a workflow reports a missing credential, fix the protected environment configuration. Do not add conditional secret checks that turn a missing secret into a successful skipped deployment.
