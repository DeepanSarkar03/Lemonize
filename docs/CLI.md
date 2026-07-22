# Lemonize CLI (`lem`) reference

The workspace exposes `lem` and `lemx` from `@lemonize/cli`. Contributors can build and link it with:

```bash
pnpm cli:link
```

Install the CLI through the npm package protected by trusted publishing and provenance: `npm install --global @lemonize/cli`. The registry bootstrap scripts delegate to the same npm command; mutable native binaries are not an installation trust root.

## Global flags and registry selection

```text
--registry <url>  --json  --verbose  --no-color
```

Registry resolution, from highest to lowest precedence:

1. `--registry`
2. `LEMONIZE_REGISTRY`
3. project `.lemrc`
4. `~/.lemonize/config.json`
5. `https://registry.lemonize.cyou`

Registry URLs must use HTTPS. Plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `[::1]`; credentials, queries, fragments, whitespace, and other schemes are rejected.

`LEMONIZE_TOKEN` is supported for automation, but only for the origin selected explicitly by `LEMONIZE_REGISTRY` or for the default production origin. This prevents a repository-controlled `.lemrc` from retargeting an environment token.

## Login

```bash
lem login
```

The CLI prints `/login` and a short display code, then polls for up to ten minutes. Sign in through Clerk and manually type the exact code shown by your own terminal. The code is intentionally not embedded in the URL.

The Worker verifies the Clerk session and active account before returning a 30-day Lemonize API token. Active accounts linked to GitHub receive public-publisher scopes (`read`, `publish`, `manage:packages`, and `manage:tokens`); accounts without GitHub receive `read` and `manage:tokens`. Publishing also requires acceptance of the current terms and a write-enabled registry. The raw token is stored per normalized registry URL in `~/.lemonize/config.json` with mode `0600` where the filesystem supports it.

`lem login --username <name>` remains as a client compatibility option, but the server ignores that value for identity. A username is never proof of authentication.

The production Clerk instance, custom domains, TLS/JWKS, mail DNS, and public GitHub OAuth configuration are present. The production path remains a cutover blocker until email delivery, first-user GitHub sign-in and callback handling, lockout, linking, legal consent, active-user lookup, and manual device approval pass end-to-end. Use dedicated dev/staging Clerk and registry resources for write-capable tests.

Device approval is stored for 120 seconds in a per-code Durable Object and consumed transactionally at most once. An expired, undelivered approval removes or revokes the corresponding token row so it cannot silently consume the account's active-token quota.

## Token management

```bash
lem token list
lem token create ci-publish --expires-in-days 30 --scope read publish
lem token revoke <token-id>
lem token revoke-all
```

`token create` accepts a 1-90 day lifetime (default 30) and the child scopes `read`, `publish`, and `manage:packages`. A child cannot receive `manage:tokens`, contain a scope its root lacks, or outlive its root, so it cannot create another token. Only the creation response prints the raw credential. `token list` shows metadata and prefixes for the current root lineage, never raw values. `revoke-all` revokes that visible lineage one by one and removes the current root last; it cannot revoke independent login/device roots. Revoking or logging out the root also invalidates all of its children.

## Package names and versions

New packages and versions must use the authenticated publisher's namespace:

```json
{
  "name": "@your-namespace/example",
  "version": "1.0.0"
}
```

`lem init` currently scaffolds the directory name as an unscoped `name`. Edit it to `@your-namespace/name` before publishing. Legacy unscoped packages can still be installed, but cannot receive a new version or be maintained by a publisher. Explicit administrator remediation requires a mutable registry or direct controlled operations.

Install targets accept either an npm-style `@` separator or a Lemonize-style final `/` separator:

| Form                           | Example                                                  |
| ------------------------------ | -------------------------------------------------------- |
| Scoped, `@` version            | `lem add @demo/utils@^1.2 --source lemonize`             |
| Scoped, slash version          | `lem install @demo/utils/2.0.0-beta.1 --source lemonize` |
| Scoped, default `latest`       | `lem install @demo/utils --source lemonize`              |
| Legacy unscoped, `@` version   | `lem install legacy-tool@1.2.0 --source lemonize`        |
| Legacy unscoped, slash version | `lem install legacy-tool/latest --source lemonize`       |

The version part may be exact semver, a semver range such as `^1.2`, `~1.1.0`, or `>=1 <2`, or a dist-tag such as `latest`, `beta`, or `next`.

## npm and Lemonize dependency graphs

`lem install`, `lem add`, and `lem update` recursively resolve and install both public npm packages and native Lemonize packages:

- standard `dependencies`, `optionalDependencies`, and `devDependencies` come from npm through `https://npm.lemonize.cyou`;
- `lemonizeDependencies` come from the native Lemonize registry;
- unscoped explicit targets default to npm;
- a scoped explicit target is ambiguous and must include `--source npm` or `--source lemonize`;
- a package name cannot be declared from both sources in the same dependency context;
- required, optional, peer, and nested dependencies are validated recursively to a maximum depth of 128;
- lifecycle scripts are never run.

Examples:

```bash
lem add is-number
lem add @types/node --source npm -D
lem add @your-namespace/tool --source lemonize
lem install --frozen-lockfile
```

`lemonize-lock.json` version 2 records both registry origins, distinct source-qualified package keys, every dependency edge, peer ranges, exact resolved URLs, SHA-512 integrity, and SHA-256 content hashes. Normal installs rebuild a deterministic complete graph and atomically replace the lockfile. `--frozen-lockfile` requires v2, validates the root manifest and every stored edge, and installs without changing it. A non-frozen install upgrades a v1 native-only lockfile and moves its root packages to `lemonizeDependencies`.

## Commands

| Command                                          | Description                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `lem init`                                       | Scaffold `package.json`, `index.js`, and `README.md`; edit the generated name to your scope before publishing |
| `lem login`                                      | Start Clerk-verified manual device approval and store the resulting scoped API token                          |
| `lem logout`                                     | Revoke the presenting Lemonize API token when possible and remove it locally                                  |
| `lem whoami`                                     | Show the authenticated Lemonize identity                                                                      |
| `lem token list` / `lem tokens ls`               | List active token metadata and prefixes                                                                       |
| `lem token create <label> [options]`             | Create a scoped 1-90 day token; the raw credential is displayed once                                          |
| `lem token revoke <id>`                          | Revoke the current root or one of its direct children                                                         |
| `lem token revoke-all`                           | Revoke the current root lineage; independent login/device roots are isolated                                  |
| `lem publish [--tag t] [--access a] [--dry-run]` | Pack, reserve, upload, and queue the current project for scanning                                             |
| `lem install [pkg...]` / `lem i`                 | Recursively install explicit targets or all declared npm/Lemonize roots                                       |
| `lem add <pkg...>`                               | Recursively install and save to npm dependencies or `lemonizeDependencies`                                    |
| `lem remove <pkg...>` / `lem rm`                 | Remove package files, dependency entries, and lock entries                                                    |
| `lem update [pkg...]` / `lem up`                 | Update named or all dependencies to resolved latest versions                                                  |
| `lem exec <pkg> [args...]`                       | Install if needed and run a package binary without a shell                                                    |
| `lemx <pkg> [-- args...]`                        | Convenience entry point for `exec`; pass package arguments after `--`                                         |
| `lem info <pkg>`                                 | Show package metadata, versions, tags, integrity, and maintainers                                             |
| `lem search <query>`                             | Search public packages                                                                                        |
| `lem list` / `lem ls`                            | List packages from `lemonize-lock.json`                                                                       |
| `lem outdated`                                   | Show installed packages with newer resolutions                                                                |
| `lem deprecate <pkg@version> <message>`          | Set/clear a deprecation message; disabled in production read-only mode                                        |
| `lem unpublish <pkg@version> --force`            | Soft-yank and retain bytes when the registry is mutable; rejected in production read-only mode                |
| `lem tag add <pkg@version> <tag>`                | Set a dist-tag; disabled in production read-only mode                                                         |
| `lem tag remove <pkg> <tag>`                     | Remove a dist-tag other than `latest`; disabled in read-only mode                                             |
| `lem config get/set/delete <key> [value]`        | Manage global CLI configuration                                                                               |
| `lem cache clean`                                | Remove the global artifact cache                                                                              |

`lem publish` may return after the registry queues the security scan. A queued upload is not published or installable yet; it becomes visible only after the Appwrite scanner returns a matching signed clean result and the Worker promotes it to immutable R2 storage. Re-running an existing `name@version` cannot overwrite it.

Production is intentionally read-only for cutover. Use staging for publish, tag, deprecation, and soft-yank tests; every package maintenance route is rejected in production read-only mode.

## Files and directories

- `~/.lemonize/config.json`: registry and per-registry raw API tokens; keep private.
- `~/.lemonize/cache/`: content-addressed verified tarball cache.
- `lemonize-lock.json`: deterministic v2 npm/Lemonize registry roots, source-qualified graph edges, versions, resolved URLs, integrity, and SHA-256 data.
- `.lemrc`: optional project JSON, for example `{ "registry": "https://registry-staging.lemonize.cyou" }`.

## Examples

```bash
lem config set registry https://registry-staging.lemonize.cyou
lem login
lem install @demo/utils/latest --source lemonize
lem add @demo/utils@^1.2 --source lemonize
lem add kleur
lem info @demo/utils

# Publisher in a package whose manifest name is @your-namespace/tool
lem publish --dry-run
lem publish --tag beta

# Mutable staging only; artifact bytes are retained
lem unpublish @your-namespace/tool@1.0.0 --force
```

## Installer safety

The CLI verifies SHA-512 SRI for both npm and Lemonize tarballs and also verifies the lockfile's SHA-256 digest before extraction. Extraction rejects path traversal, absolute/drive paths, backslashes, links, special entries, duplicate/unsafe paths, and archives outside the `package/` root. Lemonize never executes package lifecycle scripts.

`lem exec` and `lemx` spawn a JavaScript runtime with an argument array, never a shell command. A standalone `lem` binary still needs Node.js or Bun on `PATH` to run a third-party JavaScript package binary.
