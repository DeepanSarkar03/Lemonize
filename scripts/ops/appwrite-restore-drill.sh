#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bash "$script_dir/require-env.sh" \
  APPWRITE_ENDPOINT APPWRITE_PROJECT_ID APPWRITE_BACKUP_API_KEY \
  APPWRITE_DEPLOY_API_KEY APPWRITE_RESTORE_DATA_API_KEY APPWRITE_DATABASE_ID REGISTRY_MODE \
  ALLOW_PUBLIC_PUBLISH RESTORE_DRILL_CONFIRMATION RESTORE_DRILL_RUN_ID

backup_api_key=$APPWRITE_BACKUP_API_KEY
deploy_api_key=$APPWRITE_DEPLOY_API_KEY
restore_data_api_key=$APPWRITE_RESTORE_DATA_API_KEY
unset APPWRITE_BACKUP_API_KEY APPWRITE_DEPLOY_API_KEY APPWRITE_RESTORE_DATA_API_KEY \
  APPWRITE_RUNTIME_API_KEY APPWRITE_API_KEY
if [[ "$backup_api_key" == "$deploy_api_key" ||
      "$backup_api_key" == "$restore_data_api_key" ||
      "$deploy_api_key" == "$restore_data_api_key" ]]; then
  echo "The restore drill requires three distinct least-privilege Appwrite API keys" >&2
  exit 64
fi

if [[ "$RESTORE_DRILL_CONFIRMATION" != RESTORE_STAGING_TO_ISOLATED_DATABASE ]]; then
  echo "The staging restore drill confirmation phrase is invalid" >&2
  exit 64
fi
if [[ "$APPWRITE_PROJECT_ID" != lemonize-staging-2026 ]]; then
  echo "The restore drill is restricted to the checked staging Appwrite project" >&2
  exit 64
fi
if [[ "$APPWRITE_DATABASE_ID" != registry ]]; then
  echo "The checked staging runtime database ID must be registry" >&2
  exit 64
fi
if [[ "$REGISTRY_MODE" != read_only || "$ALLOW_PUBLIC_PUBLISH" != false ]]; then
  echo "The staging registry must be read-only throughout a restore drill" >&2
  exit 64
fi
node -e '
  const endpoint = new URL(process.argv[1]);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash) {
    console.error("APPWRITE_ENDPOINT must be a credential-free HTTPS URL");
    process.exit(1);
  }
' "$APPWRITE_ENDPOINT"

if [[ ! "$RESTORE_DRILL_RUN_ID" =~ ^[0-9]+-[0-9]+$ ]]; then
  echo "RESTORE_DRILL_RUN_ID must contain the numeric GitHub run ID and attempt" >&2
  exit 64
fi

source_database_id="restore-src-$RESTORE_DRILL_RUN_ID"
target_database_id="restore-dst-$RESTORE_DRILL_RUN_ID"
source_database_name="Lemonize restore source $RESTORE_DRILL_RUN_ID"
target_database_name="Lemonize restore target $RESTORE_DRILL_RUN_ID"
fixture_table_id=fixture
fixture_row_id=sentinel
fixture_value="restore-sentinel-$RESTORE_DRILL_RUN_ID"

for resource_id in "$source_database_id" "$target_database_id"; do
  if [[ ! "$resource_id" =~ ^restore-(src|dst)-[0-9]+-[0-9]+$ || ${#resource_id} -gt 36 ]]; then
    echo "Derived restore drill resource ID is invalid" >&2
    exit 64
  fi
  if [[ "$resource_id" == "$APPWRITE_DATABASE_ID" ]]; then
    echo "Restore drill resource ID collides with the runtime database" >&2
    exit 64
  fi
done

APPWRITE_BIN=${APPWRITE_BIN:-appwrite}
RESTORE_DRILL_POLL_SECONDS=${RESTORE_DRILL_POLL_SECONDS:-5}
RESTORE_DRILL_MAX_POLLS=${RESTORE_DRILL_MAX_POLLS:-90}
RESTORE_DRILL_READ_TIMEOUT_SECONDS=${RESTORE_DRILL_READ_TIMEOUT_SECONDS:-10}
if [[ ! "$RESTORE_DRILL_POLL_SECONDS" =~ ^[0-9]+$ ||
      ! "$RESTORE_DRILL_MAX_POLLS" =~ ^[1-9][0-9]*$ ||
      ! "$RESTORE_DRILL_READ_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Restore drill polling configuration is invalid" >&2
  exit 64
fi
if ! command -v timeout >/dev/null 2>&1; then
  echo "The restore drill requires GNU timeout to bound Appwrite reads" >&2
  exit 69
fi

if [[ -z "${APPWRITE_CLI_HOME:-}" ]]; then
  APPWRITE_CLI_HOME=$(mktemp -d)
  remove_cli_home=1
else
  remove_cli_home=0
  mkdir -p "$APPWRITE_CLI_HOME"
fi
export HOME=$APPWRITE_CLI_HOME
scratch=$(mktemp -d)

source_owned=0
target_owned=0
archive_owned=0
archive_creation_started=0
archive_id=
restoration_started=0
restoration_id=
cleanup_deferred_reason=
last_read_error=
drill_verified=0
cleanup_running=0

configure_client() {
  local key=$1
  "$APPWRITE_BIN" client \
    --endpoint "$APPWRITE_ENDPOINT" \
    --project-id "$APPWRITE_PROJECT_ID" \
    --key "$key" >/dev/null
}

read_json_bounded() {
  local output=$1
  shift
  local exit_code=0
  timeout --signal=TERM --kill-after=5 "${RESTORE_DRILL_READ_TIMEOUT_SECONDS}s" \
    "$APPWRITE_BIN" --json "$@" > "$output" 2>/dev/null || exit_code=$?
  if [[ "$exit_code" == 0 ]]; then
    last_read_error=
    return 0
  fi
  case "$exit_code" in
    124|137|143)
      last_read_error="Appwrite read timed out after ${RESTORE_DRILL_READ_TIMEOUT_SECONDS}s"
      ;;
    *)
      last_read_error="Appwrite read failed with exit code $exit_code"
      ;;
  esac
  return 1
}

read_json_required() {
  local output=$1
  shift
  local request="${1:-unknown} ${2:-read}"
  if ! read_json_bounded "$output" "$@"; then
    echo "Required Appwrite $request request failed: $last_read_error" >&2
    return 1
  fi
}

database_state() {
  local database_id=$1
  local expected_name=$2
  local output="$scratch/database-list-$database_id.json"
  read_json_bounded "$output" tables-db list --search "$database_id" --limit 100 || return 1
  node -e '
    const fs = require("node:fs");
    const [path, id, name] = process.argv.slice(1);
    const data = JSON.parse(fs.readFileSync(path, "utf8"));
    const matches = (data.databases ?? []).filter((item) => item.$id === id);
    if (matches.length === 0) process.stdout.write("absent");
    else if (matches.length !== 1 || matches[0].name !== name) process.stdout.write("mismatch");
    else process.stdout.write(matches[0].enabled === false ? "match-disabled" : "match-enabled");
  ' "$output" "$database_id" "$expected_name"
}

delete_owned_database() {
  local database_id=$1
  local expected_name=$2
  local owned=$3
  [[ "$owned" == 1 ]] || return 0
  if [[ ! "$database_id" =~ ^restore-(src|dst)-[0-9]+-[0-9]+$ ||
        "$database_id" == "$APPWRITE_DATABASE_ID" ]]; then
    echo "Refusing to clean an untrusted restore drill database ID" >&2
    return 1
  fi
  configure_client "$deploy_api_key" || return 1
  local state
  state=$(database_state "$database_id" "$expected_name") || return 1
  case "$state" in
    absent)
      return 0
      ;;
    match-enabled)
      "$APPWRITE_BIN" --json tables-db update \
        --database-id "$database_id" --enabled false > /dev/null || return 1
      state=$(database_state "$database_id" "$expected_name") || return 1
      [[ "$state" == match-disabled ]] || return 1
      ;;
    match-disabled)
      ;;
    *)
      echo "Restore drill cleanup found an unexpected database identity: $database_id" >&2
      return 1
      ;;
  esac
  "$APPWRITE_BIN" --json tables-db delete --database-id "$database_id" > /dev/null || return 1
  state=$(database_state "$database_id" "$expected_name") || return 1
  [[ "$state" == absent ]]
}

delete_owned_archive() {
  if [[ "$archive_creation_started" == 1 && -z "$archive_id" ]]; then
    configure_client "$backup_api_key" || return 1
    local discovery_file="$scratch/archive-discovery.json"
    read_json_bounded "$discovery_file" backups list-archives --sort-desc '$createdAt' --limit 100 || return 1
    archive_id=$(node -e '
      const fs = require("node:fs");
      const [path, resourceId] = process.argv.slice(1);
      const data = JSON.parse(fs.readFileSync(path, "utf8"));
      const matches = (data.archives ?? []).filter((archive) => {
        const services = [...(archive.services ?? [])].sort();
        return archive.resourceId === resourceId && !archive.policyId &&
          JSON.stringify(services) === JSON.stringify(["tablesdb"]);
      });
      if (matches.length === 0) process.exit(2);
      if (matches.length !== 1 || typeof matches[0].$id !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(matches[0].$id)) process.exit(1);
      process.stdout.write(matches[0].$id);
    ' "$discovery_file" "$source_database_id")
    discovery_status=$?
    if [[ "$discovery_status" == 2 ]]; then
      archive_id=
      return 0
    fi
    [[ "$discovery_status" == 0 ]] || return 1
    archive_owned=1
  fi
  [[ "$archive_owned" == 1 && -n "$archive_id" ]] || return 0
  if [[ ! "$archive_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$ ]]; then
    echo "Refusing to clean an invalid restore drill archive ID" >&2
    return 1
  fi
  configure_client "$backup_api_key" || return 1
  local archive_file="$scratch/archive-cleanup.json"
  read_json_bounded "$archive_file" backups get-archive --archive-id "$archive_id" || return 1
  node -e '
    const fs = require("node:fs");
    const [path, id, resourceId] = process.argv.slice(1);
    const archive = JSON.parse(fs.readFileSync(path, "utf8"));
    const services = [...(archive.services ?? [])].sort();
    if (archive.$id !== id || archive.resourceId !== resourceId ||
        archive.policyId || JSON.stringify(services) !== JSON.stringify(["tablesdb"])) {
      console.error("Refusing to delete an archive that is not the one-off drill archive");
      process.exit(1);
    }
  ' "$archive_file" "$archive_id" "$source_database_id" || return 1
  "$APPWRITE_BIN" --json backups delete-archive --archive-id "$archive_id" > /dev/null || return 1
  local archives_file="$scratch/archives-after-cleanup.json"
  read_json_bounded "$archives_file" backups list-archives --sort-desc '$createdAt' --limit 100 || return 1
  node -e '
    const fs = require("node:fs");
    const [path, id] = process.argv.slice(1);
    const data = JSON.parse(fs.readFileSync(path, "utf8"));
    if ((data.archives ?? []).some((archive) => archive.$id === id)) process.exit(1);
  ' "$archives_file" "$archive_id"
}

cleanup() {
  local primary_status=$?
  if [[ "$cleanup_running" == 1 ]]; then
    exit "$primary_status"
  fi
  cleanup_running=1
  trap - EXIT INT TERM
  set +e
  local cleanup_failed=0
  local cleanup_deferred=0
  local reported_target_database_id=
  if [[ -n "$cleanup_deferred_reason" ]]; then
    cleanup_deferred=1
    echo "Automatic cleanup was deferred because an Appwrite operation may still be active: $cleanup_deferred_reason" >&2
    echo "Preserved source database ID: $source_database_id" >&2
    if [[ "$target_owned" == 1 ]]; then
      echo "Preserved target database ID: $target_database_id" >&2
    fi
    if [[ "$archive_creation_started" == 1 ]]; then
      echo "Preserved archive ID: ${archive_id:-unknown}" >&2
      echo "Archive lookup source database ID: $source_database_id" >&2
    fi
    if [[ "$restoration_started" == 1 ]]; then
      echo "Preserved restoration ID: ${restoration_id:-unknown}" >&2
      if [[ -f "$scratch/restoration-reported-target-ids" ]]; then
        while IFS= read -r reported_target_database_id; do
          if [[ "$reported_target_database_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$ ]]; then
            echo "Reported restoration target database ID: $reported_target_database_id" >&2
          fi
        done < "$scratch/restoration-reported-target-ids"
      fi
    fi
    echo "Wait for the provider operation to reach a terminal state, then perform reviewed cleanup before retrying." >&2
  else
    delete_owned_database "$target_database_id" "$target_database_name" "$target_owned" || cleanup_failed=1
    delete_owned_database "$source_database_id" "$source_database_name" "$source_owned" || cleanup_failed=1
    delete_owned_archive || cleanup_failed=1
  fi
  rm -rf -- "$scratch"
  if [[ "$remove_cli_home" == 1 ]]; then rm -rf -- "$APPWRITE_CLI_HOME"; fi
  if [[ "$primary_status" -ne 0 || "$cleanup_failed" -ne 0 || "$cleanup_deferred" -ne 0 ]]; then
    if [[ "$cleanup_failed" -ne 0 ]]; then
      echo "Restore drill cleanup failed; inspect the exact generated resource IDs before retrying" >&2
    fi
    exit 1
  fi
  if [[ "$drill_verified" == 1 ]]; then
    echo "Staging Appwrite backup restoration was verified and all drill resources were removed"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for_database_ready() {
  local database_id=$1
  local expected_name=$2
  local output=$3
  for ((attempt = 1; attempt <= RESTORE_DRILL_MAX_POLLS; attempt += 1)); do
    if read_json_bounded "$output" tables-db get --database-id "$database_id"; then
      local state
      state=$(node -e '
        const fs = require("node:fs");
        const [path, id, name] = process.argv.slice(1);
        const database = JSON.parse(fs.readFileSync(path, "utf8"));
        if (database.$id !== id || database.name !== name) process.stdout.write("identity-mismatch");
        else process.stdout.write(database.status ?? "unknown");
      ' "$output" "$database_id" "$expected_name")
      case "$state" in
        ready) return 0 ;;
        provisioning) ;;
        failed|identity-mismatch|*)
          echo "Database $database_id entered an unexpected state: $state" >&2
          return 1
          ;;
      esac
    fi
    sleep "$RESTORE_DRILL_POLL_SECONDS"
  done
  echo "Timed out waiting for database $database_id; ${last_read_error:-no terminal response was observed}" >&2
  return 1
}

configure_client "$deploy_api_key"
runtime_before="$scratch/runtime-before.json"
read_json_required "$runtime_before" tables-db get --database-id "$APPWRITE_DATABASE_ID"
node -e '
  const fs = require("node:fs");
  const database = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (database.$id !== "registry" || database.status !== "ready") {
    console.error("The staging runtime database is not ready");
    process.exit(1);
  }
' "$runtime_before"

read_json_required "$scratch/databases-orphan-check.json" tables-db list --search restore- --limit 100
node -e '
  const fs = require("node:fs");
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const orphans = (data.databases ?? [])
    .map((database) => database.$id)
    .filter((id) => typeof id === "string" && /^restore-(src|dst)-[0-9]+-[0-9]+$/.test(id));
  if (orphans.length > 0) {
    console.error(`Existing restore drill resources require reviewed cleanup: ${orphans.join(", ")}`);
    process.exit(1);
  }
' "$scratch/databases-orphan-check.json"

for pair in "$source_database_id|$source_database_name" "$target_database_id|$target_database_name"; do
  database_id=${pair%%|*}
  database_name=${pair#*|}
  state=$(database_state "$database_id" "$database_name")
  if [[ "$state" != absent ]]; then
    echo "Restore drill resource already exists; reviewed cleanup is required: $database_id" >&2
    exit 1
  fi
done

configure_client "$backup_api_key"
read_json_required "$scratch/archives-preflight.json" backups list-archives --sort-desc '$createdAt' --limit 100
node -e '
  const fs = require("node:fs");
  const [path, resourceId] = process.argv.slice(1);
  const data = JSON.parse(fs.readFileSync(path, "utf8"));
  const orphans = (data.archives ?? []).filter((archive) =>
    typeof archive.resourceId === "string" && /^restore-src-[0-9]+-[0-9]+$/.test(archive.resourceId));
  if (orphans.length > 0 || (data.archives ?? []).some((archive) => archive.resourceId === resourceId)) {
    console.error("An existing restore drill archive requires reviewed cleanup");
    process.exit(1);
  }
' "$scratch/archives-preflight.json" "$source_database_id"
configure_client "$deploy_api_key"

source_owned=1
cleanup_deferred_reason="source database creation did not reach ready"
"$APPWRITE_BIN" --json tables-db create \
  --database-id "$source_database_id" \
  --name "$source_database_name" \
  --enabled false > "$scratch/source-created.json"
wait_for_database_ready "$source_database_id" "$source_database_name" "$scratch/source-ready.json"
cleanup_deferred_reason=

"$APPWRITE_BIN" --json tables-db create-table \
  --database-id "$source_database_id" \
  --table-id "$fixture_table_id" \
  --name "Restore fixture" \
  --row-security false \
  --enabled false > "$scratch/table-created.json"
cleanup_deferred_reason="restore fixture column creation did not reach a terminal state"
"$APPWRITE_BIN" --json tables-db create-varchar-column \
  --database-id "$source_database_id" \
  --table-id "$fixture_table_id" \
  --key value \
  --size 128 \
  --required true \
  --array false \
  --encrypt false > "$scratch/column-created.json"

column_available=0
for ((attempt = 1; attempt <= RESTORE_DRILL_MAX_POLLS; attempt += 1)); do
  if ! read_json_bounded "$scratch/column.json" tables-db get-column \
    --database-id "$source_database_id" --table-id "$fixture_table_id" --key value; then
    sleep "$RESTORE_DRILL_POLL_SECONDS"
    continue
  fi
  column_state=$(node -e '
    const fs = require("node:fs");
    const column = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (column.key !== "value" || column.type !== "varchar" || column.required !== true) {
      process.stdout.write("identity-mismatch");
    } else process.stdout.write(column.status ?? "unknown");
  ' "$scratch/column.json")
  case "$column_state" in
    available) column_available=1; break ;;
    processing) ;;
    failed|stuck|deleting|identity-mismatch|*)
      echo "Restore fixture column entered an unexpected state: $column_state" >&2
      exit 1
      ;;
  esac
  sleep "$RESTORE_DRILL_POLL_SECONDS"
done
if [[ "$column_available" != 1 ]]; then
  echo "Timed out waiting for the restore fixture column; ${last_read_error:-no terminal response was observed}" >&2
  exit 1
fi
cleanup_deferred_reason=

fixture_data=$(node -e 'process.stdout.write(JSON.stringify({ value: process.argv[1] }))' "$fixture_value")
configure_client "$restore_data_api_key"
"$APPWRITE_BIN" --json tables-db create-row \
  --database-id "$source_database_id" \
  --table-id "$fixture_table_id" \
  --row-id "$fixture_row_id" \
  --data "$fixture_data" > "$scratch/row-created.json"

verify_fixture_row() {
  local database_id=$1
  local output=$2
  configure_client "$restore_data_api_key"
  read_json_required "$output" tables-db get-row \
    --database-id "$database_id" --table-id "$fixture_table_id" --row-id "$fixture_row_id"
  node -e '
    const fs = require("node:fs");
    const [path, rowId, value] = process.argv.slice(1);
    const row = JSON.parse(fs.readFileSync(path, "utf8"));
    if (row.$id !== rowId || row.value !== value) {
      console.error("Restore fixture sentinel did not match");
      process.exit(1);
    }
  ' "$output" "$fixture_row_id" "$fixture_value"
}
verify_fixture_row "$source_database_id" "$scratch/source-row-before.json"

configure_client "$backup_api_key"
archive_creation_started=1
cleanup_deferred_reason="archive creation did not reach a terminal state"
"$APPWRITE_BIN" --json backups create-archive \
  --services tablesdb \
  --resource-id "$source_database_id" > "$scratch/archive-created.json"
archive_id=$(node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const archive = JSON.parse(fs.readFileSync(path, "utf8"));
  if (typeof archive.$id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(archive.$id)) process.exit(1);
  process.stdout.write(archive.$id);
' "$scratch/archive-created.json")
archive_owned=1
node -e '
  const fs = require("node:fs");
  const [path, id, resourceId] = process.argv.slice(1);
  const archive = JSON.parse(fs.readFileSync(path, "utf8"));
  const services = [...(archive.services ?? [])].sort();
  if (archive.$id !== id || archive.resourceId !== resourceId || archive.policyId ||
      JSON.stringify(services) !== JSON.stringify(["tablesdb"])) process.exit(1);
' "$scratch/archive-created.json" "$archive_id" "$source_database_id"

archive_completed=0
for ((attempt = 1; attempt <= RESTORE_DRILL_MAX_POLLS; attempt += 1)); do
  if ! read_json_bounded "$scratch/archive.json" backups get-archive --archive-id "$archive_id"; then
    sleep "$RESTORE_DRILL_POLL_SECONDS"
    continue
  fi
  archive_state=$(node -e '
    const fs = require("node:fs");
    const [path, id, resourceId] = process.argv.slice(1);
    const archive = JSON.parse(fs.readFileSync(path, "utf8"));
    const services = [...(archive.services ?? [])].sort();
    if (archive.$id !== id || archive.resourceId !== resourceId || archive.policyId ||
        JSON.stringify(services) !== JSON.stringify(["tablesdb"])) {
      process.stdout.write("identity-mismatch");
    } else if (archive.status === "completed") {
      const size = Number(archive.size ?? archive.$size);
      process.stdout.write(Number.isFinite(size) && size > 0 ? "completed" : "empty");
    } else process.stdout.write(archive.status ?? "unknown");
  ' "$scratch/archive.json" "$archive_id" "$source_database_id")
  case "$archive_state" in
    completed) archive_completed=1; cleanup_deferred_reason=; break ;;
    pending|processing|uploading) ;;
    failed|skipped|empty)
      cleanup_deferred_reason=
      echo "Restore drill archive entered an unexpected state: $archive_state" >&2
      exit 1
      ;;
    identity-mismatch|*)
      echo "Restore drill archive entered an unexpected state: $archive_state" >&2
      exit 1
      ;;
  esac
  sleep "$RESTORE_DRILL_POLL_SECONDS"
done
if [[ "$archive_completed" != 1 ]]; then
  echo "Timed out waiting for the restore drill archive; ${last_read_error:-no terminal response was observed}" >&2
  exit 1
fi

verify_fixture_row "$source_database_id" "$scratch/source-row-after-archive.json"

configure_client "$backup_api_key"
target_owned=1
restoration_started=1
cleanup_deferred_reason="restoration did not reach a terminal state"
"$APPWRITE_BIN" --json backups create-restoration \
  --archive-id "$archive_id" \
  --services tablesdb \
  --new-resource-id "$target_database_id" \
  --new-resource-name "$target_database_name" > "$scratch/restoration-created.json"
restoration_id=$(node -e '
  const fs = require("node:fs");
  const [path, archiveId] = process.argv.slice(1);
  const restoration = JSON.parse(fs.readFileSync(path, "utf8"));
  const servicesMatch = Array.isArray(restoration.services) &&
    restoration.services.length === 1 && restoration.services[0] === "tablesdb";
  if (typeof restoration.$id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(restoration.$id) ||
      restoration.archiveId !== archiveId || !servicesMatch) {
    console.error("Restore initiation returned an unexpected identity");
    process.exit(1);
  }
  process.stdout.write(restoration.$id);
' "$scratch/restoration-created.json" "$archive_id")
node -e '
  const fs = require("node:fs");
  const [path, reportedTargetPath, restorationId, archiveId, sourceId, targetId, targetName] = process.argv.slice(1);
  const restoration = JSON.parse(fs.readFileSync(path, "utf8"));
  const servicesMatch = Array.isArray(restoration.services) &&
    restoration.services.length === 1 && restoration.services[0] === "tablesdb";
  if (restoration.$id !== restorationId || restoration.archiveId !== archiveId || !servicesMatch) {
    console.error("Restore initiation returned an unexpected identity");
    process.exit(1);
  }
  let options = restoration.options;
  if (typeof options === "string") {
    try { options = JSON.parse(options); } catch {
      console.error("Restore initiation returned invalid options JSON");
      process.exit(1);
    }
  }
  const databases = options?.tablesdb?.database;
  const reportedTargetIds = Array.isArray(databases)
    ? [...new Set(databases.map((database) => database?.newId).filter((id) =>
        typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(id)))]
    : [];
  if (reportedTargetIds.length > 0) {
    fs.writeFileSync(reportedTargetPath, `${reportedTargetIds.join("\n")}\n`);
  }
  const destinationMatches = Array.isArray(databases) && databases.length === 1 &&
    databases[0]?.oldId === sourceId && databases[0]?.newId === targetId &&
    databases[0]?.newName === targetName;
  if (!destinationMatches) {
    console.error("Restore initiation returned an unexpected destination");
    process.exit(1);
  }
' "$scratch/restoration-created.json" "$scratch/restoration-reported-target-ids" "$restoration_id" \
  "$archive_id" "$source_database_id" "$target_database_id" "$target_database_name"

restoration_completed=0
for ((attempt = 1; attempt <= RESTORE_DRILL_MAX_POLLS; attempt += 1)); do
  if ! read_json_bounded "$scratch/restoration.json" backups get-restoration \
    --restoration-id "$restoration_id"; then
    sleep "$RESTORE_DRILL_POLL_SECONDS"
    continue
  fi
  restoration_state=$(node -e '
    const fs = require("node:fs");
    const [path, id, archiveId] = process.argv.slice(1);
    const restoration = JSON.parse(fs.readFileSync(path, "utf8"));
    const services = [...(restoration.services ?? [])].sort();
    if (restoration.$id !== id || restoration.archiveId !== archiveId ||
        JSON.stringify(services) !== JSON.stringify(["tablesdb"])) {
      process.stdout.write("identity-mismatch");
    } else process.stdout.write(restoration.status ?? "unknown");
  ' "$scratch/restoration.json" "$restoration_id" "$archive_id")
  case "$restoration_state" in
    completed)
      restoration_completed=1
      cleanup_deferred_reason="restored target database did not reach ready"
      break
      ;;
    pending|downloading|processing) ;;
    failed)
      cleanup_deferred_reason=
      echo "Restore drill restoration entered an unexpected state: $restoration_state" >&2
      exit 1
      ;;
    identity-mismatch|*)
      echo "Restore drill restoration entered an unexpected state: $restoration_state" >&2
      exit 1
      ;;
  esac
  sleep "$RESTORE_DRILL_POLL_SECONDS"
done
if [[ "$restoration_completed" != 1 ]]; then
  echo "Timed out waiting for the restore drill restoration; ${last_read_error:-no terminal response was observed}" >&2
  exit 1
fi

configure_client "$deploy_api_key"
wait_for_database_ready "$target_database_id" "$target_database_name" "$scratch/target-ready.json"
cleanup_deferred_reason=
"$APPWRITE_BIN" --json tables-db update \
  --database-id "$target_database_id" --enabled false > "$scratch/target-disabled.json"
target_state=$(database_state "$target_database_id" "$target_database_name")
if [[ "$target_state" != match-disabled ]]; then
  echo "Restored drill database could not be disabled" >&2
  exit 1
fi

read_json_required "$scratch/target-tables.json" tables-db list-tables \
  --database-id "$target_database_id" --limit 100
node -e '
  const fs = require("node:fs");
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const ids = (data.tables ?? []).map((table) => table.$id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(["fixture"])) process.exit(1);
' "$scratch/target-tables.json"
read_json_required "$scratch/target-column.json" tables-db get-column \
  --database-id "$target_database_id" --table-id "$fixture_table_id" --key value
node -e '
  const fs = require("node:fs");
  const column = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (column.key !== "value" || column.type !== "varchar" ||
      column.required !== true || column.status !== "available") process.exit(1);
' "$scratch/target-column.json"
verify_fixture_row "$target_database_id" "$scratch/target-row.json"
verify_fixture_row "$source_database_id" "$scratch/source-row-final.json"

configure_client "$deploy_api_key"
runtime_after="$scratch/runtime-after.json"
read_json_required "$runtime_after" tables-db get --database-id "$APPWRITE_DATABASE_ID"
node -e '
  const fs = require("node:fs");
  const [beforePath, afterPath] = process.argv.slice(1);
  const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
  const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));
  for (const key of ["$id", "name", "enabled", "status", "$updatedAt"]) {
    if (before[key] !== after[key]) {
      console.error("The staging runtime database changed during the isolated restore drill");
      process.exit(1);
    }
  }
' "$runtime_before" "$runtime_after"

drill_verified=1
