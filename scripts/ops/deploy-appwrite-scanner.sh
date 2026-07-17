#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bash "$script_dir/require-env.sh" \
  APPWRITE_ENDPOINT APPWRITE_PROJECT_ID APPWRITE_DEPLOY_API_KEY \
  APPWRITE_SCANNER_FUNCTION_ID APPWRITE_QUARANTINE_BUCKET_ID \
  REGISTRY_BASE_URL SCANNER_SHARED_SECRET MAX_TARBALL_SIZE_BYTES MAX_PACKAGE_FILES

APPWRITE_BIN=${APPWRITE_BIN:-appwrite}
cleanup_paths=()
cleanup() {
  local path
  for path in "${cleanup_paths[@]}"; do rm -rf -- "$path"; done
}
trap cleanup EXIT
if [[ -z "${APPWRITE_CLI_HOME:-}" ]]; then
  APPWRITE_CLI_HOME=$(mktemp -d)
  cleanup_paths+=("$APPWRITE_CLI_HOME")
fi
export HOME=$APPWRITE_CLI_HOME
mkdir -p "$HOME"

# Build under the repository's committed pnpm lock, then upload only the
# dependency-free JavaScript output. Appwrite never resolves npm packages.
pnpm --filter @lemonize/artifact-scanner build
deploy_dir=$(mktemp -d)
cleanup_paths+=("$deploy_dir")
mkdir -p "$deploy_dir/dist"
cp apps/artifact-scanner/package.json "$deploy_dir/package.json"
cp -R apps/artifact-scanner/dist/. "$deploy_dir/dist/"

"$APPWRITE_BIN" client \
  --endpoint "$APPWRITE_ENDPOINT" \
  --project-id "$APPWRITE_PROJECT_ID" \
  --key "$APPWRITE_DEPLOY_API_KEY" >/dev/null

functions_file="$HOME/functions.json"
"$APPWRITE_BIN" --json functions list --limit 100 > "$functions_file"
if node -e '
  const fs = require("node:fs");
  const [path, id] = process.argv.slice(1);
  const data = JSON.parse(fs.readFileSync(path, "utf8"));
  process.exit(data.functions?.some((fn) => fn.$id === id) ? 0 : 1);
' "$functions_file" "$APPWRITE_SCANNER_FUNCTION_ID"; then
  function_command=update
else
  function_command=create
fi

"$APPWRITE_BIN" --json functions "$function_command" \
  --function-id "$APPWRITE_SCANNER_FUNCTION_ID" \
  --name "Lemonize artifact scanner" \
  --runtime node-25 \
  --execute \
  --events \
  --schedule '' \
  --timeout 60 \
  --enabled true \
  --logging true \
  --entrypoint dist/main.js \
  --commands "node --check dist/main.js" \
  --scopes files.read files.write \
  --deployment-retention 3 >/dev/null

variables_file="$HOME/variables.json"
"$APPWRITE_BIN" --json functions list-variables \
  --function-id "$APPWRITE_SCANNER_FUNCTION_ID" --limit 100 > "$variables_file"

# The function uses Appwrite's short-lived execution key. Remove known legacy
# static credentials so a previous deployment cannot retain an admin key.
while IFS= read -r legacy_variable_id; do
  [[ -z "$legacy_variable_id" ]] && continue
  "$APPWRITE_BIN" --json functions delete-variable \
    --function-id "$APPWRITE_SCANNER_FUNCTION_ID" \
    --variable-id "$legacy_variable_id" >/dev/null
done < <(node -e '
  const fs = require("node:fs");
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const legacy = new Set(["APPWRITE_API_KEY", "APPWRITE_PROJECT_ID", "APPWRITE_ENDPOINT"]);
  for (const variable of data.variables ?? []) {
    if (legacy.has(variable.key)) console.log(variable.$id);
  }
' "$variables_file")

upsert_variable() {
  local variable_id=$1
  local key=$2
  local value=$3
  local secret=$4
  local command
  local existing_variable_id
  existing_variable_id=$(node -e '
    const fs = require("node:fs");
    const [path, key] = process.argv.slice(1);
    const data = JSON.parse(fs.readFileSync(path, "utf8"));
    const variable = data.variables?.find((item) => item.key === key);
    if (variable?.$id) process.stdout.write(variable.$id);
  ' "$variables_file" "$key")
  if [[ -n "$existing_variable_id" ]]; then
    command=update-variable
    variable_id=$existing_variable_id
  else
    command=create-variable
  fi
  "$APPWRITE_BIN" --json functions "$command" \
    --function-id "$APPWRITE_SCANNER_FUNCTION_ID" \
    --variable-id "$variable_id" \
    --key "$key" \
    --value "$value" \
    --secret "$secret" >/dev/null
}

upsert_variable registry_internal_url REGISTRY_INTERNAL_URL "$REGISTRY_BASE_URL" false
upsert_variable scan_signing_secret SCAN_SIGNING_SECRET "$SCANNER_SHARED_SECRET" true
upsert_variable quarantine_bucket APPWRITE_QUARANTINE_BUCKET_ID "$APPWRITE_QUARANTINE_BUCKET_ID" false
upsert_variable max_archive_bytes MAX_ARCHIVE_BYTES "$MAX_TARBALL_SIZE_BYTES" false
upsert_variable max_package_files MAX_PACKAGE_FILES "$MAX_PACKAGE_FILES" false
upsert_variable signature_max_age MAX_SIGNATURE_AGE_SECONDS 300 false

deployment_file="$HOME/deployment.json"
"$APPWRITE_BIN" --json functions create-deployment \
  --function-id "$APPWRITE_SCANNER_FUNCTION_ID" \
  --code "$deploy_dir" \
  --activate true \
  --entrypoint dist/main.js \
  --commands "node --check dist/main.js" > "$deployment_file"

deployment_id=$(node -e '
  const fs = require("node:fs");
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!data.$id) process.exit(1);
  process.stdout.write(data.$id);
' "$deployment_file")

for attempt in $(seq 1 60); do
  status_file="$HOME/deployment-status.json"
  "$APPWRITE_BIN" --json functions get-deployment \
    --function-id "$APPWRITE_SCANNER_FUNCTION_ID" \
    --deployment-id "$deployment_id" > "$status_file"
  status=$(node -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(data.status ?? "unknown");
  ' "$status_file")
  case "$status" in
    ready)
      echo "Appwrite scanner deployment $deployment_id is ready"
      exit 0
      ;;
    failed|canceled)
      echo "Appwrite scanner deployment $deployment_id ended with status $status" >&2
      exit 1
      ;;
    *)
      if (( attempt == 60 )); then
        echo "Timed out waiting for Appwrite scanner deployment $deployment_id (status $status)" >&2
        exit 1
      fi
      sleep 5
      ;;
  esac
done
