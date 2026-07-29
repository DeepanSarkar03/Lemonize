# Lemonize artifact scanner

Appwrite Node function that validates staged registry tarballs and places valid
archives in the private `quarantine` bucket. Appwrite's bucket antivirus setting
performs the malware scan; this function intentionally has no ClamAV dependency.

## Appwrite build settings

- Runtime: Appwrite Node 25
- Repository build: `pnpm --filter @lemonize/artifact-scanner build` under the committed lockfile
- Appwrite build command: `node --check dist/main.js` (no remote dependency install)
- Entrypoint: `dist/main.js`

Deployment uploads only `package.json` and the dependency-free compiled `dist` directory. Appwrite must not run `npm install`; dependency resolution belongs to the protected, frozen-lock CI build.

## Environment

| Variable                        | Purpose                                                       |
| ------------------------------- | ------------------------------------------------------------- |
| `REGISTRY_INTERNAL_URL`         | HTTPS base URL for registry-internal scan endpoints           |
| `SCAN_SIGNING_SECRET`           | HMAC secret shared only with the registry (at least 32 bytes) |
| `APPWRITE_ENDPOINT`             | Local-only fallback for the Appwrite API endpoint             |
| `APPWRITE_PROJECT_ID`           | Local-only fallback for the Appwrite project ID               |
| `APPWRITE_API_KEY`              | Temporary secret fallback for the scanner-only Appwrite key   |
| `APPWRITE_QUARANTINE_BUCKET_ID` | Optional; defaults to `quarantine`                            |
| `MAX_ARCHIVE_BYTES`             | Optional; defaults to and cannot exceed 20 MiB                |
| `MAX_PACKAGE_FILES`             | Optional; defaults to 10,000                                  |
| `MAX_SIGNATURE_AGE_SECONDS`     | Optional; defaults to 300 seconds                             |

Appwrite 1.9.5 supplies the documented execution-scoped key in the
`x-appwrite-key` request header. The currently pinned Lemonize artifact has an
integration bug: it checks only the `APPWRITE_FUNCTION_API_KEY` and
`APPWRITE_API_KEY` environment variables and does not consume that header. A
separate Appwrite build artifact-handoff outage prevents deploying the corrected
artifact. Until that build succeeds, the protected workflow uses a temporary,
unsupported compatibility shim: it passes the environment's
`APPWRITE_SCANNER_API_KEY` only to the scanner deployment step, which stores it
as the secret function variable `APPWRITE_API_KEY`. Never reuse
`APPWRITE_RUNTIME_API_KEY` or `APPWRITE_DEPLOY_API_KEY` for this purpose.

Create one scanner key per environment with **only** `files.read` and
`files.write`. Appwrite API keys cannot introspect their own scopes, so an
operator must manually attest that no additional scope was selected during
provisioning and rotation. These `files.*` grants apply project-wide: the exact
quarantine-bucket runtime pin, storage canary, and signed execution challenge
constrain intended behavior but do not reduce the credential's provider-side
blast radius. Keep
environments in separate Appwrite projects, and treat a scanner-key compromise
as potential access to every file in that project allowed by those two scopes.

Deployment enforces zero project variables and exactly seven function
variables, including secret `APPWRITE_API_KEY` and `SCAN_SIGNING_SECRET`. After
the corrected scanner artifact consumes `x-appwrite-key` and Appwrite reliably
hands off that artifact, remove the provider key, protected secret and
attestation variables, `APPWRITE_API_KEY` function variable, and deployment shim
together.

## Signed protocol

The function accepts a JSON `POST` containing `schemaVersion`, `jobId`,
`versionId`, `packageName`, `version`, `shasum`, `integrity`, `tarballSize`,
`fileCount`, and `unpackedSize`. The request must include
`x-lemonize-timestamp` (Unix seconds) and `x-lemonize-signature`.

The v1 signature is a hexadecimal HMAC-SHA256 over:

```text
v1:<timestamp>:<METHOD>:<path-and-query>:<sha256-of-exact-body>
```

The scanner makes signed requests to these registry-relative endpoints:

```text
GET  /internal/v1/scan-jobs/<jobId>/artifact
POST /internal/v1/scan-jobs/<jobId>/result
```

The result endpoint receives one of `clean`, `rejected`, or `error`. Error
payloads contain stable codes only; upstream bodies, credentials, and exception
messages are never forwarded.
