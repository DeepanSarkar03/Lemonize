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
| `APPWRITE_API_KEY`              | Local-only fallback for the API key                           |
| `APPWRITE_QUARANTINE_BUCKET_ID` | Optional; defaults to `quarantine`                            |
| `MAX_ARCHIVE_BYTES`             | Optional; defaults to and cannot exceed 20 MiB                |
| `MAX_PACKAGE_FILES`             | Optional; defaults to 10,000                                  |
| `MAX_SIGNATURE_AGE_SECONDS`     | Optional; defaults to 300 seconds                             |

In Appwrite Cloud, the function uses the platform-injected
`APPWRITE_FUNCTION_API_*` values. Configure the function with only
`files.read` and `files.write` execution scopes; no long-lived Appwrite key is
stored as a function variable.

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
