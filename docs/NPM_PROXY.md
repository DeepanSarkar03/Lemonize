# npm CDN proxy

Lemonize exposes a read-only pull-through proxy for the public npm registry at `https://npm.lemonize.cyou/`. npmjs remains authoritative. Lemonize uses Cloudflare's Cache API and does not store third-party npm packages in R2, KV, or Appwrite.

The hostname is still a production cutover gate and does not currently resolve. The active Cloudflare OAuth session can deploy Workers but lacks DNS/WAF authority. Do not advertise the endpoint until an appropriately narrow credential has created/verified DNS and WAF configuration and the Worker custom domain, synthetic checks, and origin budgets pass.

## Configure a client

```sh
npm config set registry https://npm.lemonize.cyou/
pnpm config set registry https://npm.lemonize.cyou/
yarn config set npmRegistryServer https://npm.lemonize.cyou/
```

Restore npm's default with:

```sh
npm config set registry https://registry.npmjs.org/
pnpm config set registry https://registry.npmjs.org/
yarn config set npmRegistryServer https://registry.npmjs.org/
```

Never put an npm access token in the Lemonize registry configuration. Incoming `Authorization`, proxy-authorization, and cookie headers are stripped and are never forwarded to npmjs.

## Supported surface

The proxy deliberately implements a small allowlist needed for public installs:

| Method        | Route                                | Behavior                                                             |
| ------------- | ------------------------------------ | -------------------------------------------------------------------- |
| `GET`, `HEAD` | `/:package`                          | Full or abbreviated public packument, including encoded scoped names |
| `GET`, `HEAD` | `/:package/-/:file.tgz`              | Public npm tarball, including a single byte Range                    |
| `GET`, `HEAD` | `/-/v1/search`                       | Bounded npm search query                                             |
| `GET`, `HEAD` | `/-/ping`                            | npm registry ping; `?write=true` is never cached                     |
| `POST`        | `/-/npm/v1/security/advisories/bulk` | Bounded, uncached audit request                                      |
| `POST`        | `/-/npm/v1/security/audits/quick`    | Bounded, uncached audit request                                      |

Login, logout, users, tokens, teams, stars, download statistics, replication/change feeds, package mutations, and every other npm endpoint are unsupported. Unknown read routes return `404`; mutations return `405`. This is a public download proxy, not an npm account or publishing service.

## Free-mode packument caveat

Production uses `NPM_PROXY_PACKUMENT_MODE=free` to stay within free-tier Worker CPU and memory budgets.

- Successful packuments with a declared size of at most 256 KiB are buffered, validated as JSON, and have official `registry.npmjs.org` tarball URLs rewritten to `npm.lemonize.cyou`.
- Successful packuments larger than 256 KiB are streamed without JSON rewriting and carry `X-Lemonize-Packument-Mode: free-tier-passthrough`. Their `dist.tarball` URLs can therefore point directly to npmjs. The install still works, but that tarball does not traverse Lemonize's CDN.
- Every packument has a hard 16 MiB limit. A declared oversize response fails with `502`; a stream that overruns its declaration is terminated.

Do not promise that every npm tarball is delivered by Lemonize while free mode is enabled. `full` mode can rewrite larger packuments, but it must not be enabled until its Worker cost and failure behavior have been load-tested and approved.

## Cache, Range, and integrity behavior

- Full and abbreviated packuments use separate cache keys and successful metadata is cached for at most five minutes.
- Missing (`404`/`410`) metadata and tarballs are cached for at most one minute. Other errors are not cached.
- Complete tarball responses are cached as immutable objects for one year. A Range request can be satisfied from an already cached complete object; an origin Range miss is streamed and is not inserted as a partial cached object. Conditional requests bypass cache lookup.
- npm's SHA-512 `dist.integrity` and SHA-1 `dist.shasum` fields are preserved. Tarballs are never repacked or recompressed.
- `X-Lemonize-Cache: HIT | MISS | BYPASS` describes Lemonize's Cache API decision, not npmjs's cache.
- The launch target is warm-cache P95 time-to-first-byte below 500 ms. A cold miss still depends on npmjs and has no latency guarantee.

Limits are 16 MiB per packument, 100 MiB per tarball, 4 MiB per search response, 1 MiB per audit request, and 8 MiB per audit response. Metadata/audit origin work has a 10-second timeout; tarballs have a 30-second timeout.

## Origin admission and WAF

Cache misses pass through a Durable Object admission controller before npmjs is contacted. The controller hashes the client IP, serializes a global ledger, and enforces per-IP, global minute/day, and route-specific metadata/search/audit/tarball origin budgets. A denied miss returns `429` with `Retry-After`; unavailable or corrupt admission state fails closed with `503`. Cache hits do not consume an origin-admission slot.

The checked-in starter budgets are intentionally conservative and may be lowered without changing the public API. They protect npmjs and free-tier origin traffic; they do not cap requests that terminate at the Worker or replace Cloudflare account-level usage monitoring.

Before production enablement, configure Cloudflare WAF/rate-limiting rules for `npm.lemonize.cyou` to block malformed or abusive traffic before Worker execution, exempt only the supported methods/routes, and verify normal npm, pnpm, Yarn, audit, HEAD, and Range traffic is not challenged. WAF configuration is provider-side and is not created by `wrangler.jsonc`; its rule IDs and a passing test record belong in the deployment evidence.

The minimum provider-side policy is:

1. block methods other than `GET`, `HEAD`, and `POST` on the npm hostname;
2. block `POST` unless the path is exactly one of the two supported audit endpoints;
3. rate-limit abusive per-IP request bursts at a threshold above normal parallel package installs but within the verified Worker allowance;
4. leave interactive browser challenges off supported package-manager traffic, because non-browser clients cannot solve them;
5. keep managed-rule exceptions scoped to this hostname and these routes, never the whole zone.

Test both the allow and deny cases after every rule change. The Worker's own route validator and admission controller remain mandatory even when WAF is active.

## Failure and privacy behavior

Upstream `404` and `429` responses retain npm-compatible status semantics. Proxy timeouts and validation failures use `502` or `504`, are never cached, and include `X-Request-Id`. Audit bodies are forwarded only to `https://registry.npmjs.org`, never cached or logged, and remain subject to npm's privacy and usage terms.

Standard npm clients may execute package lifecycle scripts. That is npm client behavior; the `lem` installer continues to disable lifecycle scripts.
