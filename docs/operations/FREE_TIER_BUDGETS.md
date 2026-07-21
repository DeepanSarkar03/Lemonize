# Free-tier budget guardrails

The delivery path is designed to use Cloudflare and Vercel free tiers, but provider quotas and eligibility change. Review the current provider terms monthly and before a public launch; do not encode stale numeric limits as promises.

## Guardrails

| Provider           | Watch                                                                     | Guardrail                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers | requests, CPU time, errors, subrequests                                   | Alert at 50%, 75%, and 90% of the current free allowance; throttle publishing before reads                                    |
| npm proxy Worker   | requests, origin misses, packument bytes/mode, cache status, WAF actions  | Cache only at the edge, keep free packument mode, enforce admission/WAF budgets, and disable before it starves native traffic |
| KV                 | reads/writes/deletes                                                      | Keep KV off hot write paths and alert on sudden write amplification                                                           |
| Durable Objects    | requests, storage operations, alarms, object count                        | Use transactional per-principal counters/approvals, keep TTL cleanup bounded, and alert before the current free allowance     |
| R2                 | stored bytes and operation classes                                        | Keep buckets private, enforce artifact limits, and never upload duplicate release artifacts                                   |
| Vercel             | bandwidth, function usage, build minutes, deployments                     | Use one preview per approved staging release, cancel superseded CI, and avoid scheduled rebuilds                              |
| Appwrite           | TablesDB rows/operations, scanner executions, quarantine Storage, backups | Bound scan retries and retention; verify antivirus/native-backup availability and charges before enabling production          |
| GitHub Actions     | runner minutes and artifact storage                                       | Keep concurrency cancellation on CI, short artifact retention, and no periodic deployment builds                              |

Vercel Hobby eligibility may not cover commercial or organizational use. Confirm the current terms; if Lemonize is ineligible, stop before production and choose an approved plan/provider rather than disguising usage.

## Response thresholds

- At 50%: inspect growth and forecast the end of the billing period.
- At 75%: pause nonessential preview deployments and load tests; reduce retention only when recovery requirements remain satisfied.
- At 90%: disable public publishing if writes are the driver, preserve read/download availability, and require an owner decision.
- At provider limit or unexpected charge: do not automatically upgrade. Capture metrics, apply the safe degradation above, and obtain explicit budget approval.

Keep dev, staging, and production usage dashboards and alert destinations distinct so test traffic cannot hide production growth. There is no D1 quota in the current runtime budget; Appwrite TablesDB is the database budget to monitor.

Assign one owner to review dashboards weekly. Record only usage totals and resource identifiers, never Clerk JWTs, Lemonize tokens, provider keys, or customer data.

Public-beta publisher defaults are five packages, twenty versions per package, two concurrent publishes, 10 MiB per artifact, and 100 MiB total retained bytes; the Worker rejects a reservation that exceeds those account limits. A serialized global reservation gate enforces `MAX_GLOBAL_ARTIFACT_BYTES`. Keep the checked-in conservative 1 GiB value until both storage entitlements are verified, then set it to at most 70% of the lower R2/Appwrite entitlement and never above 7 GiB. Reaching either an account or global ceiling rejects new reservations while preserving metadata and downloads.

## npm proxy free-tier envelope

The npm proxy has no dedicated origin-storage bill because it uses only Cloudflare's Cache API; npmjs remains authoritative. That does not make it unbounded:

- free mode buffers and JSON-validates successful packuments through 256 KiB; larger packuments use bounded streaming replacement for exact official npm registry URL prefixes;
- 16 MiB packuments, 100 MiB tarballs, 4 MiB search responses, 1 MiB audit requests, and 8 MiB audit responses are hard limits;
- full tarballs can be cached; an origin Range miss is not stored as a partial object;
- the `NPM_ADMISSION_CONTROLLER` Durable Object admits only cache misses and applies hashed per-IP, global minute/day, and route-specific budgets;
- hostname-scoped Cloudflare WAF/rate rules must reject abusive traffic before Worker execution because Durable Object admission cannot save Worker request quota;
- if either Worker or Durable Object allowance approaches 90%, set `NPM_PROXY_ENABLED=false` or withdraw the npm hostname before reducing native registry availability.

Track `X-Lemonize-Cache` and `X-Lemonize-Packument-Mode` in synthetic samples without logging package-manager credentials or audit bodies. A high streaming-rewrite share is a reason to load-test the path, not permission to enable full-document buffering without a cost review.
