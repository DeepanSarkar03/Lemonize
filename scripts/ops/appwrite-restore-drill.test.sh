#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

fake_appwrite="$tmp/appwrite"
cat > "$fake_appwrite" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail

source_id=restore-src-12345-1
target_id=restore-dst-12345-1
source_name='Lemonize restore source 12345-1'
target_name='Lemonize restore target 12345-1'
mkdir -p "$FAKE_STATE"

if [[ "${1:-}" == client ]]; then
  echo client >> "$FAKE_STATE/commands.log"
  exit 0
fi
if [[ "${1:-}" == --json ]]; then shift; fi
printf '%q ' "$@" >> "$FAKE_STATE/commands.log"
printf '\n' >> "$FAKE_STATE/commands.log"

value_of() {
  local needle=$1
  shift
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "$needle" ]]; then
      printf '%s' "${2:-}"
      return 0
    fi
    shift
  done
  return 1
}

fail_read_once() {
  local operation=$1
  local marker="$FAKE_STATE/transient-$operation"
  if [[ "${FAKE_TRANSIENT_READ_ERRORS:-0}" == 1 && ! -e "$marker" ]]; then
    touch "$marker"
    return 0
  fi
  return 1
}

service=${1:-}
operation=${2:-}
shift 2 || true

case "$service:$operation" in
  tables-db:list)
    search=$(value_of --search "$@" || true)
    if [[ "$search" == "$source_id" && "${FAKE_DATABASE_STATE_VALID_THEN_FAIL:-0}" == 1 ]]; then
      printf '{"total":0,"databases":[]}'
      exit 1
    fi
    case "$search" in
      restore-)
        if [[ -f "$FAKE_STATE/preexisting-target" ]]; then
          printf '{"total":1,"databases":[{"$id":"%s","name":"Unexpected database","enabled":false,"status":"ready"}]}' "$target_id"
        else
          # Prefix preflight reports only unexpected databases, not drill-owned resources.
          printf '{"total":0,"databases":[]}'
        fi
        ;;
      registry)
        printf '{"total":1,"databases":[{"$id":"registry","name":"Lemonize Registry","enabled":true,"status":"ready","$updatedAt":"2026-07-28T00:00:00.000Z"}]}'
        ;;
      "$source_id")
        if [[ -f "$FAKE_STATE/source" ]]; then
          printf '{"total":1,"databases":[{"$id":"%s","name":"%s","enabled":false,"status":"ready"}]}' "$source_id" "$source_name"
        else
          printf '{"total":0,"databases":[]}'
        fi
        ;;
      "$target_id")
        if [[ -f "$FAKE_STATE/preexisting-target" ]]; then
          printf '{"total":1,"databases":[{"$id":"%s","name":"Unexpected database","enabled":false,"status":"ready"}]}' "$target_id"
        elif [[ -f "$FAKE_STATE/target" ]]; then
          enabled=true
          [[ "$(cat "$FAKE_STATE/target")" == false ]] && enabled=false
          printf '{"total":1,"databases":[{"$id":"%s","name":"%s","enabled":%s,"status":"ready"}]}' "$target_id" "$target_name" "$enabled"
        else
          printf '{"total":0,"databases":[]}'
        fi
        ;;
      *) printf '{"total":0,"databases":[]}' ;;
    esac
    ;;
  tables-db:get)
    id=$(value_of --database-id "$@")
    case "$id" in
      registry)
        printf '{"$id":"registry","name":"Lemonize Registry","enabled":true,"status":"ready","$updatedAt":"2026-07-28T00:00:00.000Z"}'
        ;;
      "$source_id")
        [[ -f "$FAKE_STATE/source" ]] || exit 1
        printf '{"$id":"%s","name":"%s","enabled":false,"status":"%s"}' \
          "$source_id" "$source_name" "${FAKE_SOURCE_DATABASE_STATUS:-ready}"
        ;;
      "$target_id")
        [[ -f "$FAKE_STATE/target" ]] || exit 1
        enabled=true
        [[ "$(cat "$FAKE_STATE/target")" == false ]] && enabled=false
        printf '{"$id":"%s","name":"%s","enabled":%s,"status":"ready"}' "$target_id" "$target_name" "$enabled"
        ;;
      *) exit 1 ;;
    esac
    ;;
  tables-db:create)
    id=$(value_of --database-id "$@")
    [[ "$id" == "$source_id" ]]
    printf 'false' > "$FAKE_STATE/source"
    printf '{"$id":"%s","name":"%s","enabled":false,"status":"ready"}' "$source_id" "$source_name"
    ;;
  tables-db:update)
    id=$(value_of --database-id "$@")
    [[ "$id" == "$source_id" || "$id" == "$target_id" ]]
    if [[ "$id" == "$source_id" ]]; then
      printf 'false' > "$FAKE_STATE/source"
    else
      printf 'false' > "$FAKE_STATE/target"
    fi
    printf '{"$id":"%s","enabled":false,"status":"ready"}' "$id"
    ;;
  tables-db:delete)
    id=$(value_of --database-id "$@")
    case "$id" in
      "$source_id") rm -f "$FAKE_STATE/source" ;;
      "$target_id") rm -f "$FAKE_STATE/target" ;;
      *) echo "refusing unexpected delete $id" >&2; exit 1 ;;
    esac
    printf '{}'
    ;;
  tables-db:create-table)
    printf '{"$id":"fixture","name":"Restore fixture","enabled":false,"rowSecurity":false}'
    ;;
  tables-db:create-varchar-column)
    printf '{"key":"value","type":"varchar","required":true,"status":"processing"}'
    ;;
  tables-db:get-column)
    if fail_read_once get-column; then exit 1; fi
    printf '{"key":"value","type":"varchar","required":true,"status":"%s"}' \
      "${FAKE_COLUMN_STATUS:-available}"
    ;;
  tables-db:create-row)
    printf '{"$id":"sentinel","value":"restore-sentinel-12345-1"}'
    ;;
  tables-db:get-row)
    id=$(value_of --database-id "$@")
    if [[ "$id" == "$target_id" && "${FAKE_BAD_TARGET_ROW:-0}" == 1 ]]; then
      printf '{"$id":"sentinel","value":"wrong"}'
    else
      printf '{"$id":"sentinel","value":"restore-sentinel-12345-1"}'
    fi
    ;;
  tables-db:list-tables)
    printf '{"total":1,"tables":[{"$id":"fixture","name":"Restore fixture","enabled":false,"rowSecurity":false}]}'
    ;;
  backups:create-archive)
    touch "$FAKE_STATE/archive"
    printf '{"$id":"archive-1","resourceId":"%s","policyId":null,"services":["tablesdb"],"status":"pending"}' "$source_id"
    ;;
  backups:get-archive)
    [[ -f "$FAKE_STATE/archive" ]] || exit 1
    if fail_read_once get-archive; then exit 1; fi
    printf '{"$id":"archive-1","resourceId":"%s","policyId":null,"services":["tablesdb"],"status":"%s","size":128}' \
      "$source_id" "${FAKE_ARCHIVE_STATUS:-completed}"
    ;;
  backups:delete-archive)
    rm -f "$FAKE_STATE/archive"
    printf '{}'
    ;;
  backups:list-archives)
    if [[ -f "$FAKE_STATE/archive" ]]; then
      printf '{"total":1,"archives":[{"$id":"archive-1"}]}'
    else
      printf '{"total":0,"archives":[]}'
    fi
    ;;
  backups:create-restoration)
    printf 'true' > "$FAKE_STATE/target"
    printf '{"$id":"restoration-1","archiveId":"archive-1","services":["tablesdb"],"status":"pending","options":"{\\"newResourceId\\":\\"%s\\",\\"newResourceName\\":\\"%s\\"}"}' "$target_id" "$target_name"
    ;;
  backups:get-restoration)
    if fail_read_once get-restoration; then exit 1; fi
    printf '{"$id":"restoration-1","archiveId":"archive-1","services":["tablesdb"],"status":"%s"}' \
      "${FAKE_RESTORATION_STATUS:-completed}"
    ;;
  *)
    echo "Unhandled fake Appwrite command: $service $operation $*" >&2
    exit 1
    ;;
esac
FAKE
chmod +x "$fake_appwrite"

run_drill() {
  local state=$1
  shift
  mkdir -p "$state/home"
  env \
    APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
    APPWRITE_PROJECT_ID=lemonize-staging-2026 \
    APPWRITE_BACKUP_API_KEY=test-backup-key \
    APPWRITE_DEPLOY_API_KEY=test-deploy-key \
    APPWRITE_DATABASE_ID=registry \
    REGISTRY_MODE=read_only \
    ALLOW_PUBLIC_PUBLISH=false \
    RESTORE_DRILL_CONFIRMATION=RESTORE_STAGING_TO_ISOLATED_DATABASE \
    RESTORE_DRILL_RUN_ID=12345-1 \
    RESTORE_DRILL_POLL_SECONDS=0 \
    RESTORE_DRILL_MAX_POLLS=3 \
    APPWRITE_CLI_HOME="$state/home" \
    APPWRITE_BIN="$fake_appwrite" \
    FAKE_STATE="$state" \
    "$@" \
    bash "$script_dir/appwrite-restore-drill.sh"
}

success_state="$tmp/success"
success_output=$(run_drill "$success_state")
grep -Fq 'restoration was verified and all drill resources were removed' <<<"$success_output"
test ! -e "$success_state/source"
test ! -e "$success_state/target"
test ! -e "$success_state/archive"
restoration_command_count=$(grep -c '^backups create-restoration ' "$success_state/commands.log")
test "$restoration_command_count" -eq 1
restoration_command=$(grep '^backups create-restoration ' "$success_state/commands.log")
destination_flag_count=$(grep -oE -- '--new-resource-id(=| )[^ ]+' <<<"$restoration_command" | wc -l)
test "$destination_flag_count" -eq 1
if [[ " $restoration_command " != *' --new-resource-id restore-dst-12345-1 '* &&
      " $restoration_command " != *' --new-resource-id=restore-dst-12345-1 '* ]]; then
  echo 'restore drill did not use the exact generated restoration destination' >&2
  exit 1
fi
grep -Fq 'tables-db delete --database-id restore-src-12345-1' "$success_state/commands.log"
grep -Fq 'tables-db delete --database-id restore-dst-12345-1' "$success_state/commands.log"
while IFS= read -r command; do
  if [[ "$command" == tables-db\ * &&
        (" $command " == *' --database-id registry '* || " $command " == *' --database-id=registry '*) ]]; then
    operation=${command#tables-db }
    operation=${operation%% *}
    if [[ "$operation" != get ]]; then
      echo "restore drill used non-read-only runtime database operation: $operation" >&2
      exit 1
    fi
  fi
done < "$success_state/commands.log"

transient_state="$tmp/transient-reads"
transient_output=$(run_drill "$transient_state" FAKE_TRANSIENT_READ_ERRORS=1)
grep -Fq 'restoration was verified and all drill resources were removed' <<<"$transient_output"
test ! -e "$transient_state/source"
test ! -e "$transient_state/target"
test ! -e "$transient_state/archive"
test -e "$transient_state/transient-get-column"
test -e "$transient_state/transient-get-archive"
test -e "$transient_state/transient-get-restoration"

bad_confirmation_state="$tmp/bad-confirmation"
mkdir -p "$bad_confirmation_state"
if env \
  APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
  APPWRITE_PROJECT_ID=lemonize-staging-2026 \
  APPWRITE_BACKUP_API_KEY=test-backup-key \
  APPWRITE_DEPLOY_API_KEY=test-deploy-key \
  APPWRITE_DATABASE_ID=registry \
  REGISTRY_MODE=read_only \
  ALLOW_PUBLIC_PUBLISH=false \
  RESTORE_DRILL_CONFIRMATION=WRONG \
  RESTORE_DRILL_RUN_ID=12345-1 \
  APPWRITE_BIN="$fake_appwrite" \
  FAKE_STATE="$bad_confirmation_state" \
  bash "$script_dir/appwrite-restore-drill.sh" >/dev/null 2>&1; then
  echo 'restore drill accepted an invalid confirmation' >&2
  exit 1
fi
test ! -e "$bad_confirmation_state/commands.log"

production_state="$tmp/production"
mkdir -p "$production_state"
if env \
  APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
  APPWRITE_PROJECT_ID=lemonize-prod-2026 \
  APPWRITE_BACKUP_API_KEY=test-backup-key \
  APPWRITE_DEPLOY_API_KEY=test-deploy-key \
  APPWRITE_DATABASE_ID=registry \
  REGISTRY_MODE=read_only \
  ALLOW_PUBLIC_PUBLISH=false \
  RESTORE_DRILL_CONFIRMATION=RESTORE_STAGING_TO_ISOLATED_DATABASE \
  RESTORE_DRILL_RUN_ID=12345-1 \
  APPWRITE_BIN="$fake_appwrite" \
  FAKE_STATE="$production_state" \
  bash "$script_dir/appwrite-restore-drill.sh" >/dev/null 2>&1; then
  echo 'restore drill accepted the production project' >&2
  exit 1
fi
test ! -e "$production_state/commands.log"

preexisting_state="$tmp/preexisting"
mkdir -p "$preexisting_state"
touch "$preexisting_state/preexisting-target"
if run_drill "$preexisting_state" >/dev/null 2>&1; then
  echo 'restore drill accepted a pre-existing target' >&2
  exit 1
fi
test -e "$preexisting_state/commands.log"
grep -Fq 'tables-db list' "$preexisting_state/commands.log"
if grep -Fq 'tables-db delete --database-id restore-dst-12345-1' "$preexisting_state/commands.log"; then
  echo 'restore drill deleted a target it did not create' >&2
  exit 1
fi

failed_state_read="$tmp/failed-state-read"
if run_drill "$failed_state_read" FAKE_DATABASE_STATE_VALID_THEN_FAIL=1 >/dev/null 2>&1; then
  echo 'restore drill accepted JSON from a failed ownership read' >&2
  exit 1
fi
test ! -e "$failed_state_read/source"
test ! -e "$failed_state_read/target"
test ! -e "$failed_state_read/archive"
grep -Fq 'tables-db list --search restore-src-12345-1' "$failed_state_read/commands.log"
if grep -Fq 'tables-db create --database-id restore-src-12345-1' "$failed_state_read/commands.log"; then
  echo 'restore drill created a database after a failed ownership read' >&2
  exit 1
fi

bad_row_state="$tmp/bad-row"
if run_drill "$bad_row_state" FAKE_BAD_TARGET_ROW=1 >/dev/null 2>&1; then
  echo 'restore drill accepted a corrupted restored sentinel' >&2
  exit 1
fi
test ! -e "$bad_row_state/source"
test ! -e "$bad_row_state/target"
test ! -e "$bad_row_state/archive"
grep -Fq 'tables-db delete --database-id restore-src-12345-1' "$bad_row_state/commands.log"
grep -Fq 'tables-db delete --database-id restore-dst-12345-1' "$bad_row_state/commands.log"

source_timeout_state="$tmp/source-timeout"
if source_timeout_output=$(run_drill "$source_timeout_state" FAKE_SOURCE_DATABASE_STATUS=provisioning RESTORE_DRILL_MAX_POLLS=2 2>&1); then
  echo 'restore drill accepted a source database readiness timeout' >&2
  exit 1
fi
test -e "$source_timeout_state/source"
test ! -e "$source_timeout_state/target"
test ! -e "$source_timeout_state/archive"
grep -Fq 'Automatic cleanup was deferred' <<<"$source_timeout_output"
grep -Fq 'Preserved source database ID: restore-src-12345-1' <<<"$source_timeout_output"
if grep -Eq '^(tables-db delete --database-id restore-src-12345-1|backups create-archive )' \
  "$source_timeout_state/commands.log"; then
  echo 'restore drill mutated later resources after source readiness timed out' >&2
  exit 1
fi

column_timeout_state="$tmp/column-timeout"
if column_timeout_output=$(run_drill "$column_timeout_state" FAKE_COLUMN_STATUS=processing RESTORE_DRILL_MAX_POLLS=2 2>&1); then
  echo 'restore drill accepted a fixture column readiness timeout' >&2
  exit 1
fi
test -e "$column_timeout_state/source"
test ! -e "$column_timeout_state/target"
test ! -e "$column_timeout_state/archive"
grep -Fq 'Automatic cleanup was deferred' <<<"$column_timeout_output"
grep -Fq 'Preserved source database ID: restore-src-12345-1' <<<"$column_timeout_output"
if grep -Eq '^(tables-db delete --database-id restore-src-12345-1|backups create-archive )' \
  "$column_timeout_state/commands.log"; then
  echo 'restore drill mutated later resources after column readiness timed out' >&2
  exit 1
fi

archive_timeout_state="$tmp/archive-timeout"
if archive_timeout_output=$(run_drill "$archive_timeout_state" FAKE_ARCHIVE_STATUS=pending RESTORE_DRILL_MAX_POLLS=2 2>&1); then
  echo 'restore drill accepted an archive polling timeout' >&2
  exit 1
fi
test -e "$archive_timeout_state/source"
test ! -e "$archive_timeout_state/target"
test -e "$archive_timeout_state/archive"
grep -Fq 'Automatic cleanup was deferred' <<<"$archive_timeout_output"
grep -Fq 'Preserved source database ID: restore-src-12345-1' <<<"$archive_timeout_output"
grep -Fq 'Preserved archive ID: archive-1' <<<"$archive_timeout_output"
if grep -Eq '^(tables-db delete --database-id restore-src-12345-1|backups delete-archive --archive-id archive-1)' \
  "$archive_timeout_state/commands.log"; then
  echo 'restore drill deleted resources while archive creation was still in flight' >&2
  exit 1
fi

restoration_timeout_state="$tmp/restoration-timeout"
if restoration_timeout_output=$(run_drill "$restoration_timeout_state" FAKE_RESTORATION_STATUS=pending RESTORE_DRILL_MAX_POLLS=2 2>&1); then
  echo 'restore drill accepted a restoration polling timeout' >&2
  exit 1
fi
test -e "$restoration_timeout_state/source"
test -e "$restoration_timeout_state/target"
test -e "$restoration_timeout_state/archive"
grep -Fq 'Automatic cleanup was deferred' <<<"$restoration_timeout_output"
grep -Fq 'Preserved target database ID: restore-dst-12345-1' <<<"$restoration_timeout_output"
grep -Fq 'Preserved restoration ID: restoration-1' <<<"$restoration_timeout_output"
if grep -Eq '^(tables-db delete --database-id restore-(src|dst)-12345-1|backups delete-archive --archive-id archive-1)' \
  "$restoration_timeout_state/commands.log"; then
  echo 'restore drill deleted resources while restoration was still in flight' >&2
  exit 1
fi

restoration_failure_state="$tmp/restoration-failure"
if run_drill "$restoration_failure_state" FAKE_RESTORATION_STATUS=failed >/dev/null 2>&1; then
  echo 'restore drill accepted a failed restoration' >&2
  exit 1
fi
test ! -e "$restoration_failure_state/source"
test ! -e "$restoration_failure_state/target"
test ! -e "$restoration_failure_state/archive"
grep -Fq 'tables-db delete --database-id restore-src-12345-1' "$restoration_failure_state/commands.log"
grep -Fq 'tables-db delete --database-id restore-dst-12345-1' "$restoration_failure_state/commands.log"
grep -Fq 'backups delete-archive --archive-id archive-1' "$restoration_failure_state/commands.log"

echo 'Appwrite restore drill safeguard regression test passed'
