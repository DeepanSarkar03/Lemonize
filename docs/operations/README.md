# Operations

These runbooks cover the Clerk-authenticated, Appwrite TablesDB-backed production path. The current production posture rejects every package publication and maintenance mutation, including soft-yank: deploying a release does not authorize publishing. Auth/device/token routes still write identity data, so block them too or take the Worker offline when a full-database freeze is required.

- [Deployment](DEPLOYMENT.md): environment setup, required CI checks, and releases.
- [Rollback](ROLLBACK.md): provider rollback order and incident checks.
- [Appwrite backup and restore](BACKUP_RESTORE.md): free-tier daily policy, verification, and restoration.
- [Key rotation](KEY_ROTATION.md): rotate provider credentials without exposing or reusing keys.
- [Free-tier budgets](FREE_TIER_BUDGETS.md): capacity guardrails and escalation thresholds.
- [GitHub Actions pinning](GITHUB_ACTIONS_PINNING.md): current tag policy and SHA migration.

Dev, staging, and production must have dedicated Cloudflare registry/npm Workers, Durable Objects, KV/R2, Appwrite, Clerk, and Vercel resources and credentials. The runtime has no D1 binding; any D1 tooling is limited to the frozen legacy migration source.

Open cutover blockers are the pending production Clerk DNS/GitHub OAuth setup and empty administrator list; the unresolved production npm-proxy hostname plus missing Cloudflare DNS/WAF and long-lived deployment authority; a missing project-scoped Vercel CI token; a signed-out npm CLI with no `@lemonize` trusted-publisher setup; the release-only `CLI_R2_API_TOKEN`; and unfinished staging auth/publish/scan/block and backup-restore drills. Appwrite schemas, scanner deployments, daily backup policies, protected environments, branch checks, and isolated Vercel staging are configured. Keep `REGISTRY_MODE=read_only` and `ALLOW_PUBLIC_PUBLISH=false` until the deployment runbook's cutover gate is approved.

Never paste provider tokens, Clerk JWTs, Lemonize API tokens, upload capabilities, `.env` files, CLI preference files, or unredacted provider output into an issue or workflow summary.
