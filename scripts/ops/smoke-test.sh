#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bash "$script_dir/require-env.sh" REGISTRY_SMOKE_URL WEB_SMOKE_URL NPM_PROXY_SMOKE_URL

for url_name in REGISTRY_SMOKE_URL WEB_SMOKE_URL NPM_PROXY_SMOKE_URL; do
  url=${!url_name}
  if [[ "$url" != https://* ]]; then
    echo "$url_name must use HTTPS, got: $url" >&2
    exit 1
  fi
done

ready_url=${REGISTRY_SMOKE_URL%/}/ready
metadata_url=${REGISTRY_SMOKE_URL%/}/v1/limits
ready_file=$(mktemp)
metadata_file=$(mktemp)
web_file=$(mktemp)
npm_file=$(mktemp)
trap 'rm -f "$ready_file" "$metadata_file" "$web_file" "$npm_file"' EXIT

curl --fail --silent --show-error --location \
  --retry 8 --retry-delay 5 --retry-all-errors --connect-timeout 10 --max-time 30 \
  "$ready_url" > "$ready_file"

node - "$ready_file" <<'NODE'
const { readFileSync } = require('node:fs');
const body = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const dependencies = body.dependencies ?? {};
if (
  body.status !== 'ready' ||
  body.service !== 'lemonize-registry' ||
  ['appwrite', 'kv', 'r2'].some((name) => dependencies[name] !== 'ok')
) {
  throw new Error(`Unexpected registry readiness response: ${JSON.stringify(body)}`);
}
NODE

curl --fail --silent --show-error --location \
  --retry 8 --retry-delay 5 --retry-all-errors --connect-timeout 10 --max-time 30 \
  "$metadata_url" > "$metadata_file"

node - "$metadata_file" "${REGISTRY_SMOKE_URL%/}" <<'NODE'
const { readFileSync } = require('node:fs');
const body = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (
  body.registryBaseUrl !== process.argv[3] ||
  !Number.isSafeInteger(body.maxTarballSizeBytes) ||
  body.maxTarballSizeBytes < 1 ||
  typeof body.publishRestricted !== "boolean" ||
  typeof body.openSignup !== "boolean"
) {
  throw new Error(`Unexpected registry metadata response: ${JSON.stringify(body)}`);
}
NODE

curl --fail --silent --show-error --location \
  --retry 8 --retry-delay 5 --retry-all-errors --connect-timeout 10 --max-time 30 \
  "$WEB_SMOKE_URL" > "$web_file"

if [[ ! -s "$web_file" ]]; then
  echo "web smoke test returned an empty response" >&2
  exit 1
fi

curl --fail --silent --show-error \
  --retry 4 --retry-delay 2 --retry-all-errors --connect-timeout 10 --max-time 30 \
  -H 'Accept: application/vnd.npm.install-v1+json' \
  "${NPM_PROXY_SMOKE_URL%/}/is-number" > "$npm_file"

node - "$npm_file" "${NPM_PROXY_SMOKE_URL%/}" <<'NODE'
const { readFileSync } = require('node:fs');
const body = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const proxy = process.argv[3];
if (body.name !== 'is-number' || !body.versions || !body['dist-tags']?.latest) {
  throw new Error('npm proxy did not return a valid packument');
}
for (const version of Object.values(body.versions)) {
  const tarball = version?.dist?.tarball;
  if (typeof tarball !== 'string' || !tarball.startsWith(`${proxy}/`)) {
    throw new Error(`npm proxy returned an off-proxy tarball URL: ${tarball}`);
  }
}
NODE

echo "Readiness, public metadata, npm proxy, and web smoke tests passed"
