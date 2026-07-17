#!/usr/bin/env bash
set -euo pipefail
umask 077

operation=${1:-reconcile}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bash "$script_dir/require-env.sh" APPWRITE_ENDPOINT APPWRITE_PROJECT_ID APPWRITE_BACKUP_API_KEY

APPWRITE_BIN=${APPWRITE_BIN:-appwrite}
APPWRITE_BACKUP_POLICY_ID=${APPWRITE_BACKUP_POLICY_ID:-lemonize-12h}
APPWRITE_BACKUP_RETENTION_DAYS=${APPWRITE_BACKUP_RETENTION_DAYS:-7}
APPWRITE_BACKUP_SCHEDULE=${APPWRITE_BACKUP_SCHEDULE:-17 */12 * * *}
if [[ -z "${APPWRITE_CLI_HOME:-}" ]]; then
  APPWRITE_CLI_HOME=$(mktemp -d)
  trap 'rm -rf -- "$APPWRITE_CLI_HOME"' EXIT
fi
export HOME=$APPWRITE_CLI_HOME
mkdir -p "$HOME"

"$APPWRITE_BIN" client \
  --endpoint "$APPWRITE_ENDPOINT" \
  --project-id "$APPWRITE_PROJECT_ID" \
  --key "$APPWRITE_BACKUP_API_KEY" >/dev/null

case "$operation" in
  reconcile)
    policies_file="$HOME/policies.json"
    "$APPWRITE_BIN" --json backups list-policies --limit 100 > "$policies_file"
    policy_state=$(node -e '
      const fs = require("node:fs");
      const [path, id] = process.argv.slice(1);
      const data = JSON.parse(fs.readFileSync(path, "utf8"));
      const policy = data.policies?.find((item) => item.$id === id);
      if (!policy) process.stdout.write("missing");
      else {
        const expected = ["functions", "storage", "tablesdb"];
        const actual = [...(policy.services ?? [])].sort();
        process.stdout.write(JSON.stringify(actual) === JSON.stringify(expected) && !policy.resourceId ? "valid" : "invalid");
      }
    ' "$policies_file" "$APPWRITE_BACKUP_POLICY_ID")
    case "$policy_state" in
      valid)
        "$APPWRITE_BIN" --json backups update-policy \
          --policy-id "$APPWRITE_BACKUP_POLICY_ID" \
          --name "Lemonize 12-hour backup" \
          --retention "$APPWRITE_BACKUP_RETENTION_DAYS" \
          --schedule "$APPWRITE_BACKUP_SCHEDULE" \
          --enabled true
        ;;
      missing)
        "$APPWRITE_BIN" --json backups create-policy \
          --policy-id "$APPWRITE_BACKUP_POLICY_ID" \
          --services tablesdb functions storage \
          --retention "$APPWRITE_BACKUP_RETENTION_DAYS" \
          --schedule "$APPWRITE_BACKUP_SCHEDULE" \
          --name "Lemonize 12-hour backup" \
          --enabled true
        ;;
      *)
        echo "Existing policy $APPWRITE_BACKUP_POLICY_ID has unexpected services or is resource-scoped; review and replace it explicitly" >&2
        exit 1
        ;;
    esac
    ;;
  verify)
    policy_file="$HOME/policy.json"
    "$APPWRITE_BIN" --json backups get-policy --policy-id "$APPWRITE_BACKUP_POLICY_ID" > "$policy_file"
    node -e '
      const fs = require("node:fs");
      const [path, schedule, retention] = process.argv.slice(1);
      const policy = JSON.parse(fs.readFileSync(path, "utf8"));
      console.log(JSON.stringify(policy, null, 2));
      const expected = ["functions", "storage", "tablesdb"];
      const actual = [...(policy.services ?? [])].sort();
      if (!policy.enabled || policy.schedule !== schedule || policy.retention !== Number(retention) ||
          JSON.stringify(actual) !== JSON.stringify(expected) || policy.resourceId) {
        console.error("Appwrite backup policy does not match the required schedule, retention, or services");
        process.exit(1);
      }
    ' "$policy_file" "$APPWRITE_BACKUP_SCHEDULE" "$APPWRITE_BACKUP_RETENTION_DAYS"
    archives_file="$HOME/archives.json"
    "$APPWRITE_BIN" --json backups list-archives --sort-desc '$createdAt' --limit 5 > "$archives_file"
    node -e '
      const fs = require("node:fs");
      const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const archives = data.archives ?? [];
      console.log(JSON.stringify(data, null, 2));
      const latest = archives.find((archive) => archive.status === "completed");
      if (!latest) {
        console.error("No completed Appwrite archive was found in the five newest archives");
        process.exit(1);
      }
      const expected = ["functions", "storage", "tablesdb"];
      const services = [...(latest.services ?? [])].sort();
      const age = Date.now() - Date.parse(latest.$createdAt);
      const size = Number(latest.size ?? latest.$size);
      if (!Number.isFinite(age) || age < 0 || age > 13 * 60 * 60 * 1000 ||
          !Number.isFinite(size) || size <= 0 ||
          JSON.stringify(services) !== JSON.stringify(expected)) {
        console.error("Newest completed Appwrite archive is stale, empty, or does not cover all required services");
        process.exit(1);
      }
    ' "$archives_file"
    ;;
  create)
    "$APPWRITE_BIN" --json backups create-archive --services tablesdb functions storage
    ;;
  *)
    echo "usage: $0 <reconcile|verify|create>" >&2
    exit 64
    ;;
esac
