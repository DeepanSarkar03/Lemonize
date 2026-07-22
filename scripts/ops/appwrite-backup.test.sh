#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
temp_dir=$(mktemp -d)
trap 'rm -rf -- "$temp_dir"' EXIT

fake_appwrite="$temp_dir/appwrite"
cat > "$fake_appwrite" <<'FAKE_APPWRITE'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "client" ]]; then
  exit 0
fi

if [[ "${1:-}" == "--json" && "${2:-}" == "backups" && "${3:-}" == "get-policy" ]]; then
  printf '%s\n' '{"$id":"lemonize-daily","enabled":true,"schedule":"0 0 * * *","retention":7,"services":["tablesdb","functions","storage"],"resourceId":null}'
  exit 0
fi

if [[ "${1:-}" == "--json" && "${2:-}" == "backups" && "${3:-}" == "list-archives" ]]; then
  node - "${APPWRITE_BACKUP_TEST_MODE:-healthy}" "${APPWRITE_BACKUP_POLICY_ID:-lemonize-daily}" <<'NODE'
const [mode, policyId] = process.argv.slice(2);
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const latestAgeMinutes = mode === 'stale' ? 27 * 60 : 30;
const latestSize = mode === 'empty' ? 0 : 4096;

process.stdout.write(JSON.stringify({
  archives: [
    {
      $id: 'other-policy-newest',
      $createdAt: minutesAgo(5),
      policyId: 'another-policy',
      status: 'completed',
      size: 0,
    },
    {
      $id: 'target-older',
      $createdAt: minutesAgo(latestAgeMinutes + 60),
      policyId,
      status: 'completed',
      size: 0,
    },
    {
      $id: 'target-failed',
      $createdAt: minutesAgo(1),
      policyId,
      status: 'failed',
      size: 8192,
    },
    {
      $id: 'target-newest-completed',
      $createdAt: mode === 'invalid-time' ? 'not-a-timestamp' : minutesAgo(latestAgeMinutes),
      policyId,
      status: 'completed',
      size: latestSize,
    },
  ],
}));
NODE
  exit 0
fi

echo "Unexpected fake Appwrite invocation: $*" >&2
exit 64
FAKE_APPWRITE
chmod +x "$fake_appwrite"

run_verify() {
  local mode=$1
  APPWRITE_ENDPOINT='https://cloud.appwrite.test/v1' \
  APPWRITE_PROJECT_ID='test-project' \
  APPWRITE_BACKUP_API_KEY='test-key' \
  APPWRITE_BACKUP_POLICY_ID='lemonize-daily' \
  APPWRITE_BACKUP_RETENTION_DAYS='7' \
  APPWRITE_BACKUP_SCHEDULE='0 0 * * *' \
  APPWRITE_BACKUP_TEST_MODE="$mode" \
  APPWRITE_BIN="$fake_appwrite" \
  APPWRITE_CLI_HOME="$temp_dir/home-$mode" \
    bash "$script_dir/appwrite-backup.sh" verify
}

healthy_output=$(run_verify healthy)
grep -Fq 'Appwrite backup policy configuration is valid' <<<"$healthy_output"
grep -Fq 'Latest completed Appwrite archive is healthy' <<<"$healthy_output"

for invalid_mode in empty stale; do
  if run_verify "$invalid_mode" >"$temp_dir/$invalid_mode.log" 2>&1; then
    echo "Expected $invalid_mode archive verification to fail" >&2
    exit 1
  fi
  grep -Fq 'is stale or empty' "$temp_dir/$invalid_mode.log"
done

if run_verify invalid-time >"$temp_dir/invalid-time.log" 2>&1; then
  echo 'Expected invalid-time archive verification to fail' >&2
  exit 1
fi
grep -Fq 'has an invalid creation time' "$temp_dir/invalid-time.log"

echo 'Appwrite backup verification regression test passed'
