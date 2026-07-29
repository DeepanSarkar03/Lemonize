#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bash "$script_dir/require-env.sh" \
  APPWRITE_ENDPOINT APPWRITE_PROJECT_ID APPWRITE_DEPLOY_API_KEY \
  APPWRITE_SCANNER_API_KEY APPWRITE_SCANNER_API_KEY_ID \
  APPWRITE_SCANNER_API_KEY_ATTESTATION_JSON APPWRITE_SCANNER_FUNCTION_ID \
  APPWRITE_QUARANTINE_BUCKET_ID DEPLOY_ENV \
  REGISTRY_BASE_URL SCANNER_SHARED_SECRET MAX_TARBALL_SIZE_BYTES MAX_PACKAGE_FILES

# Keep every credential out of the local build and syntax check. The deploy and
# HMAC credentials are restored only after those steps; the temporary scanner
# key is passed selectively to its canary, variable write, and log redactor.
readonly deploy_api_key=$APPWRITE_DEPLOY_API_KEY
readonly scanner_api_key=$APPWRITE_SCANNER_API_KEY
readonly scanner_shared_secret=$SCANNER_SHARED_SECRET
unset APPWRITE_DEPLOY_API_KEY APPWRITE_SCANNER_API_KEY SCANNER_SHARED_SECRET
if [[ "$scanner_api_key" == "$deploy_api_key" ||
    "$scanner_api_key" == "$scanner_shared_secret" ||
    "$deploy_api_key" == "$scanner_shared_secret" ]]; then
  echo "Scanner deployment credentials must be distinct" >&2
  exit 1
fi

# Bind the selected environment to both its checked Appwrite project and exact
# registry origin before querying a write gate or making any provider mutation.
node "$script_dir/verify-appwrite-config.mjs" "$DEPLOY_ENV" >/dev/null

# This workflow sends the deploy API key through both the pinned CLI and the
# exact REST helpers below. Fail before the first key-bearing command if the
# protected environment is ever pointed at a different origin, port, or path.
readonly PINNED_APPWRITE_ENDPOINT='https://fra.cloud.appwrite.io/v1'
if [[ "$APPWRITE_ENDPOINT" != "$PINNED_APPWRITE_ENDPOINT" ]]; then
  echo "APPWRITE_ENDPOINT must match the pinned Lemonize Appwrite endpoint" >&2
  exit 1
fi

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
# Appwrite CLI only packages deployment directories below the current working
# directory. Keep the ephemeral payload inside the checkout and remove it on
# every exit through the cleanup trap.
deploy_dir=$(mktemp -d "$PWD/.appwrite-scanner-deploy.XXXXXX")
cleanup_paths+=("$deploy_dir")
mkdir -p "$deploy_dir/dist"
cp apps/artifact-scanner/package.json "$deploy_dir/package.json"
cp -R apps/artifact-scanner/dist/. "$deploy_dir/dist/"
test -s "$deploy_dir/dist/main.js"
node --check "$deploy_dir/dist/main.js"

# The remaining provider reconciliation path may now inherit these two secrets.
export APPWRITE_DEPLOY_API_KEY=$deploy_api_key
export SCANNER_SHARED_SECRET=$scanner_shared_secret

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

verify_exact_variables() {
  local label=$1
  local function_variables_file="$HOME/function-variables-$label.json"
  local project_variables_file="$HOME/project-variables-$label.json"
  read_scanner_variables "$function_variables_file" || return 1
  "$APPWRITE_BIN" --json project list-variables \
    --limit 100 > "$project_variables_file" || return 1
  node "$script_dir/verify-appwrite-scanner-fallback.mjs" --variables \
    "$function_variables_file" "$project_variables_file" \
    "$APPWRITE_SCANNER_FUNCTION_ID" "$REGISTRY_BASE_URL" \
    "$APPWRITE_QUARANTINE_BUCKET_ID" "$MAX_TARBALL_SIZE_BYTES" \
    "$MAX_PACKAGE_FILES" >/dev/null || return 1
}

verify_active_secret() {
  local expected_deployment_id=$1
  # appwrite-cli 22.6.1 hard-pins response format 1.8.1, whose compatibility
  # filter renames the modern execution fields used by the strict verifier.
  # The bounded helper pins the same trusted endpoint to response format 1.9.5.
  node "$script_dir/execute-appwrite-scanner-challenge.mjs" \
    "$expected_deployment_id" >/dev/null || return 1
}

# The pinned CLI response schema omits build/runtime specification fields.
# Read through the exact helper schema so every configuration verifier sees all
# mutable security and cost controls.
read_scanner_function() {
  local destination=$1
  node "$script_dir/reconcile-appwrite-scanner-function.mjs" get > "$destination"
}

read_scanner_variables() {
  local destination=$1
  node "$script_dir/reconcile-appwrite-scanner-function.mjs" \
    list-variables > "$destination"
}

verify_attested_appwrite_version() {
  local label=$1
  local version_file="$HOME/appwrite-version-$label.json"
  local version_nonce
  version_nonce="$(date +%s%N)-$RANDOM" || return 1
  curl --silent --show-error --fail-with-body \
    --retry 2 --retry-all-errors --retry-delay 1 --max-time 15 \
    --header 'Cache-Control: no-cache' --header 'Pragma: no-cache' \
    "${APPWRITE_ENDPOINT%/}/health/version?deployment_gate=$version_nonce" \
    > "$version_file" || return 1
  node "$script_dir/verify-appwrite-scanner-fallback.mjs" \
    --server-version "$version_file" >/dev/null || return 1
}

write_gate_verified=false
verify_live_registry_write_gate() {
  [[ "$write_gate_verified" == true ]] && return 0
  local limits_file="$HOME/live-registry-limits.json"
  local registry_url=${REGISTRY_BASE_URL%/}
  local gate_nonce
  gate_nonce="$(date +%s%N)-$RANDOM" || return 1
  curl --silent --show-error --fail-with-body \
    --retry 3 --retry-all-errors --retry-delay 1 --max-time 15 \
    --header 'Cache-Control: no-cache' \
    "$registry_url/v1/limits?deployment_gate=$gate_nonce" > "$limits_file" || return 1
  node "$script_dir/verify-appwrite-scanner-fallback.mjs" \
    --registry-write-gate "$limits_file" "$registry_url" >/dev/null || return 1
  write_gate_verified=true
}

# Static-key validation and every scanner mutation require the live registry to
# be fully read-only. This prevents an in-flight publish from racing key
# rotation or function-variable reconciliation.
if ! verify_live_registry_write_gate; then
  echo "Scanner deployment requires the live registry write gate" >&2
  exit 1
fi
APPWRITE_SCANNER_API_KEY="$scanner_api_key" \
  node "$script_dir/verify-appwrite-scanner-storage-key.mjs" >/dev/null

# Every deployment reconciles all mutable function state and writes the current
# protected scanner key. A previously live fallback must never bypass key
# rotation simply because its earlier configuration still verifies.
stale_fallback_candidate=false
fallback_id=${APPWRITE_SCANNER_FALLBACK_DEPLOYMENT_ID:-}
reconcile_response_file="$HOME/reconcile-response.json"
reconciled_function_file="$HOME/reconciled-function.json"
# Commander represents a bare optional variadic flag as boolean true, so the
# Appwrite CLI cannot express an intentional empty roles/events array. Send the
# exact JSON configuration to the same API endpoint and verify the response
# before any code or variable mutation can proceed.
node "$script_dir/reconcile-appwrite-scanner-function.mjs" \
  "$function_command" > "$reconcile_response_file"
read_scanner_function "$reconciled_function_file"
node "$script_dir/verify-appwrite-scanner-fallback.mjs" \
  --configuration-only "$reconciled_function_file" \
  "$APPWRITE_SCANNER_FUNCTION_ID" >/dev/null

variables_file="$HOME/variables.json"
read_scanner_variables "$variables_file"

# Appwrite 1.9.5 supplies the documented execution key in the x-appwrite-key
# request header, but the pinned scanner artifact checks only environment
# variables. APPWRITE_API_KEY is a temporary compatibility shim using a
# dedicated files.read/files.write key. Keep it secret and treat these seven
# values as an exact allowlist. Inherited values such as NODE_OPTIONS, proxy
# settings, or any other static credentials could change byte-identical source
# behavior.
while IFS= read -r unexpected_variable_id; do
  [[ -z "$unexpected_variable_id" ]] && continue
  "$APPWRITE_BIN" --json functions delete-variable \
    --function-id "$APPWRITE_SCANNER_FUNCTION_ID" \
    --variable-id "$unexpected_variable_id" >/dev/null
done < <(node -e '
  const fs = require("node:fs");
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const allowed = new Set([
    "REGISTRY_INTERNAL_URL",
    "SCAN_SIGNING_SECRET",
    "APPWRITE_API_KEY",
    "APPWRITE_QUARANTINE_BUCKET_ID",
    "MAX_ARCHIVE_BYTES",
    "MAX_PACKAGE_FILES",
    "MAX_SIGNATURE_AGE_SECONDS",
  ]);
  const seen = new Set();
  for (const variable of data.variables ?? []) {
    if (!allowed.has(variable.key) || seen.has(variable.key)) console.log(variable.$id);
    else seen.add(variable.key);
  }
' "$variables_file")

upsert_variable() {
  local variable_id=$1
  local key=$2
  local value=$3
  local secret=$4
  local existing_variable_id existing_variable_secret create_variable_id preferred_id_in_use
  create_variable_id=$variable_id
  existing_variable_id=$(node -e '
    const fs = require("node:fs");
    const [path, key] = process.argv.slice(1);
    const data = JSON.parse(fs.readFileSync(path, "utf8"));
    const variable = data.variables?.find((item) => item.key === key);
    if (variable?.$id) process.stdout.write(variable.$id);
  ' "$variables_file" "$key")
  existing_variable_secret=$(node -e '
    const fs = require("node:fs");
    const [path, key] = process.argv.slice(1);
    const data = JSON.parse(fs.readFileSync(path, "utf8"));
    const variable = data.variables?.find((item) => item.key === key);
    if (variable?.$id) process.stdout.write(String(variable.secret));
  ' "$variables_file" "$key")
  preferred_id_in_use=$(node -e '
    const fs = require("node:fs");
    const [path, id] = process.argv.slice(1);
    const data = JSON.parse(fs.readFileSync(path, "utf8"));
    process.stdout.write(String(data.variables?.some((item) => item.$id === id) ?? false));
  ' "$variables_file" "$variable_id")
  if [[ -z "$existing_variable_id" && "$preferred_id_in_use" == true ]]; then
    # Variable IDs are not semantic. Let Appwrite choose a collision-free ID
    # when another allowed key already occupies the preferred bootstrap ID.
    create_variable_id='unique()'
  fi
  if [[ -n "$existing_variable_id" &&
      "$existing_variable_secret" != true &&
      "$existing_variable_secret" != false ]]; then
    echo "Appwrite returned an invalid secret classification for $key" >&2
    return 1
  fi
  if [[ -n "$existing_variable_id" &&
      "$existing_variable_secret" == true && "$secret" == false ]]; then
    # Appwrite refuses only the secret-to-non-secret transition in place.
    # Preserve the existing ID so swapped or manually assigned IDs cannot
    # collide with another allowed variable during the required re-creation.
    verify_live_registry_write_gate || return 1
    create_variable_id=$existing_variable_id
    "$APPWRITE_BIN" --json functions delete-variable \
      --function-id "$APPWRITE_SCANNER_FUNCTION_ID" \
      --variable-id "$existing_variable_id" >/dev/null
    existing_variable_id=''
  fi
  if [[ -n "$existing_variable_id" ]]; then
    "$APPWRITE_BIN" --json functions update-variable \
      --function-id "$APPWRITE_SCANNER_FUNCTION_ID" \
      --variable-id "$existing_variable_id" \
      --key "$key" \
      --value "$value" \
      --secret "$secret" >/dev/null
  else
    "$APPWRITE_BIN" --json functions create-variable \
      --function-id "$APPWRITE_SCANNER_FUNCTION_ID" \
      --variable-id "$create_variable_id" \
      --key "$key" \
      --value "$value" \
      --secret "$secret" >/dev/null
  fi
}

upsert_variable registry_internal_url REGISTRY_INTERNAL_URL "$REGISTRY_BASE_URL" false
upsert_variable scan_signing_secret SCAN_SIGNING_SECRET "$SCANNER_SHARED_SECRET" true
upsert_variable appwrite_api_key APPWRITE_API_KEY "$scanner_api_key" true
upsert_variable quarantine_bucket APPWRITE_QUARANTINE_BUCKET_ID "$APPWRITE_QUARANTINE_BUCKET_ID" false
upsert_variable max_archive_bytes MAX_ARCHIVE_BYTES "$MAX_TARBALL_SIZE_BYTES" false
upsert_variable max_package_files MAX_PACKAGE_FILES "$MAX_PACKAGE_FILES" false
upsert_variable signature_max_age MAX_SIGNATURE_AGE_SECONDS 300 false

verify_exact_variables reconciled
if [[ "$function_command" == update && -n "$fallback_id" ]]; then
  # Reconciliation deliberately marks Appwrite's live flag false. The pinned
  # stale exception is not trusted yet: it is recomputed from provider version,
  # ready deployment metadata, exact source, exact variables, and a final
  # signed execution only after the exact artifact-handoff failure occurs.
  stale_fallback_candidate=true
fi

try_identical_active_fallback() {
  local failed_status_file=$1
  local fallback_id=${APPWRITE_SCANNER_FALLBACK_DEPLOYMENT_ID:-}
  [[ -n "$fallback_id" ]] || return 1
  [[ "$stale_fallback_candidate" == true ]] || return 1

  # This exception is intentionally narrower than a generic failed build. It
  # covers Appwrite's post-build artifact handoff failure and nothing else.
  node "$script_dir/verify-appwrite-scanner-fallback.mjs" \
    --build-log "$failed_status_file" || return 1
  verify_attested_appwrite_version fallback-initial || return 1

  local fallback_dir function_file final_function_file fallback_deployment_file
  local final_fallback_deployment_file
  local source_archive verified_id final_verified_id
  fallback_dir=$(mktemp -d "$PWD/.appwrite-scanner-fallback.XXXXXX") || return 1
  cleanup_paths+=("$fallback_dir")
  function_file="$fallback_dir/function.json"
  final_function_file="$fallback_dir/function-final.json"
  fallback_deployment_file="$fallback_dir/deployment.json"
  final_fallback_deployment_file="$fallback_dir/deployment-final.json"
  source_archive="$fallback_dir/source.tar.gz"

  read_scanner_function "$function_file" || return 1
  "$APPWRITE_BIN" --json functions get-deployment \
    --function-id "$APPWRITE_SCANNER_FUNCTION_ID" \
    --deployment-id "$fallback_id" > "$fallback_deployment_file" || return 1
  verify_exact_variables fallback-initial || return 1
  # appwrite-cli 22.6.1 constructs an unauthenticated browser download URL for
  # this endpoint. Use the bounded server-side downloader so the protected API
  # key is sent in a header and redirects cannot shed the authentication gate.
  node "$script_dir/download-appwrite-deployment-source.mjs" \
    "$fallback_id" "$source_archive" || return 1
  test -s "$source_archive" || return 1

  verified_id=$(node "$script_dir/verify-appwrite-scanner-fallback.mjs" \
    --attested-stale-fallback "$function_file" "$fallback_deployment_file" \
    "$fallback_id" "$APPWRITE_SCANNER_FUNCTION_ID" "$deploy_dir" \
    "$source_archive" "$APPWRITE_PROJECT_ID") || return 1
  [[ "$verified_id" == "$fallback_id" ]] || return 1

  # Re-read every mutable or status-bearing input after the source comparison.
  # The signed no-side-effect challenge is deliberately last so a concurrent
  # activation or hidden-secret mutation cannot pass on a stale preflight.
  verify_exact_variables fallback-final || return 1
  read_scanner_function "$final_function_file" || return 1
  "$APPWRITE_BIN" --json functions get-deployment \
    --function-id "$APPWRITE_SCANNER_FUNCTION_ID" \
    --deployment-id "$fallback_id" > "$final_fallback_deployment_file" || return 1
  verify_attested_appwrite_version fallback-final || return 1
  final_verified_id=$(node "$script_dir/verify-appwrite-scanner-fallback.mjs" \
    --attested-stale-fallback "$final_function_file" \
    "$final_fallback_deployment_file" "$fallback_id" \
    "$APPWRITE_SCANNER_FUNCTION_ID" "$deploy_dir" "$source_archive" \
    "$APPWRITE_PROJECT_ID") || return 1
  [[ "$final_verified_id" == "$fallback_id" ]] || return 1
  verify_active_secret "$fallback_id" || return 1
  echo "Appwrite artifact handoff failed; retained attested-stale byte-identical active scanner $verified_id"
  return 0
}

max_build_attempts=3
for build_attempt in $(seq 1 "$max_build_attempts"); do
  deployment_file="$HOME/deployment-$build_attempt.json"
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

  for status_attempt in $(seq 1 60); do
    status_file="$HOME/deployment-status-$build_attempt.json"
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
        verify_exact_variables ready
        ready_function_file="$HOME/ready-function.json"
        ready_verification_error="$HOME/ready-function-verification.log"
        ready_verified_id=''
        for config_attempt in $(seq 1 12); do
          read_scanner_function "$ready_function_file"
          if ready_verified_id=$(node "$script_dir/verify-appwrite-scanner-fallback.mjs" \
            --function-only "$ready_function_file" "$deployment_id" \
            "$APPWRITE_SCANNER_FUNCTION_ID" 2> "$ready_verification_error"); then
            break
          fi
          ready_verified_id=''
          (( config_attempt == 12 )) || sleep 1
        done
        if [[ "$ready_verified_id" != "$deployment_id" ]]; then
          cat "$ready_verification_error" >&2
          echo "Ready scanner deployment did not become the exact live function configuration" >&2
          exit 1
        fi
        if ! verify_active_secret "$deployment_id"; then
          echo "Ready scanner deployment did not prove the configured signing secret" >&2
          exit 1
        fi
        echo "Appwrite scanner deployment $deployment_id is ready"
        exit 0
        ;;
      failed|canceled)
        if [[ "$status" == failed ]] && try_identical_active_fallback "$status_file"; then
          exit 0
        fi
        if [[ "$status" == failed && "$build_attempt" -lt "$max_build_attempts" ]] &&
          node "$script_dir/verify-appwrite-scanner-fallback.mjs" \
            --build-log "$status_file"; then
          echo "Appwrite artifact handoff failed; retrying exact scanner build ($build_attempt/$max_build_attempts)" >&2
          continue 2
        fi
        APPWRITE_SCANNER_API_KEY="$scanner_api_key" node - "$status_file" <<'NODE' >&2
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let logs = typeof data.buildLogs === 'string' ? data.buildLogs : '';
logs = logs.replace(/\u001b\[[0-9;]*m/g, '');
for (const name of [
  'APPWRITE_DEPLOY_API_KEY',
  'APPWRITE_SCANNER_API_KEY',
  'SCANNER_SHARED_SECRET',
]) {
  const secret = process.env[name];
  if (secret) logs = logs.split(secret).join('[REDACTED]');
}
const tail = logs
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .slice(-40)
  .join('\n')
  .slice(-8_000);
if (tail) process.stderr.write(`Appwrite build log tail:\n${tail}\n`);
NODE
        echo "Appwrite scanner deployment $deployment_id ended with status $status" >&2
        exit 1
        ;;
      *)
        if (( status_attempt == 60 )); then
          echo "Timed out waiting for Appwrite scanner deployment $deployment_id (status $status)" >&2
          exit 1
        fi
        sleep 5
        ;;
    esac
  done
done
