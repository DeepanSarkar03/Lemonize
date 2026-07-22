#!/usr/bin/env bash
# Create Lemonize's isolated Cloudflare KV and R2 resources.
#
# This script intentionally does not create D1: Appwrite TablesDB is the
# current registry source of truth. It prints a plan unless --apply is given.
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)
cd "$repo_root"

usage() {
  cat <<'USAGE'
Usage: scripts/bootstrap-cloudflare.sh [--apply]

Without --apply, print the resources and commands without changing Cloudflare.
With --apply, create dedicated KV namespaces and R2 buckets for dev, staging,
and production in the Wrangler-authenticated account.

The script does not edit wrangler.jsonc, create provider API tokens, configure
Appwrite, or create any D1 database.
USAGE
}

apply=false
case "${1:-}" in
  '') ;;
  --apply) apply=true ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if (( $# > 1 )); then
  usage >&2
  exit 2
fi

environments=(dev staging production)
kv_names=(lemonize-kv-dev lemonize-kv-staging lemonize-kv-prod)
r2_buckets=(lemonize-artifacts-dev lemonize-artifacts-staging lemonize-artifacts-prod)

echo 'Lemonize Cloudflare resource plan'
echo '  Database: Appwrite TablesDB (provisioned separately; no D1)'
for index in "${!environments[@]}"; do
  echo "  ${environments[$index]}: KV=${kv_names[$index]} R2=${r2_buckets[$index]}"
done

if [[ "$apply" != true ]]; then
  echo
  echo 'Dry plan only. Re-run with --apply after checking the Wrangler account.'
  echo 'Commands that will run:'
  for index in "${!environments[@]}"; do
    printf '  wrangler kv namespace create %q\n' "${kv_names[$index]}"
    printf '  wrangler r2 bucket create %q\n' "${r2_buckets[$index]}"
  done
  exit 0
fi

if command -v pnpm >/dev/null 2>&1 && [[ -f apps/registry-worker/package.json ]]; then
  wrangler=(pnpm --filter @lemonize/registry-worker exec wrangler)
elif command -v wrangler >/dev/null 2>&1; then
  wrangler=(wrangler)
else
  echo 'Neither pnpm nor wrangler is on PATH. Install the pinned workspace tools first.' >&2
  exit 1
fi

echo
echo 'Authenticated Wrangler account:'
"${wrangler[@]}" whoami
echo
echo 'Creating new resources. This script never looks up or reuses an existing name.'

for index in "${!environments[@]}"; do
  environment=${environments[$index]}
  kv_name=${kv_names[$index]}
  bucket_name=${r2_buckets[$index]}

  echo
  echo "[$environment] Creating KV namespace: $kv_name"
  "${wrangler[@]}" kv namespace create "$kv_name"
  echo "[$environment] Creating private R2 bucket: $bucket_name"
  "${wrangler[@]}" r2 bucket create "$bucket_name"
done

cat <<'NEXT'

Cloudflare resources created.

Next steps:
  1. Record each returned KV namespace ID in only its matching environment.
  2. Set each environment's R2 binding to the matching bucket name.
  3. Provision separate Appwrite and Clerk resources; this script does not do so.
  4. Keep production REGISTRY_MODE=read_only and ALLOW_PUBLIC_PUBLISH=false.

Do not reuse dev/staging IDs or credentials in production.
NEXT
