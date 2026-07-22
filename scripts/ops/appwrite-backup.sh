#!/usr/bin/env bash
set -euo pipefail
umask 077

operation=${1:-reconcile}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bash "$script_dir/require-env.sh" APPWRITE_ENDPOINT APPWRITE_PROJECT_ID APPWRITE_BACKUP_API_KEY

APPWRITE_BIN=${APPWRITE_BIN:-appwrite}
APPWRITE_BACKUP_POLICY_ID=${APPWRITE_BACKUP_POLICY_ID:-lemonize-daily}
APPWRITE_BACKUP_RETENTION_DAYS=${APPWRITE_BACKUP_RETENTION_DAYS:-7}
APPWRITE_BACKUP_SCHEDULE="${APPWRITE_BACKUP_SCHEDULE:-0 0 * * *}"
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
          --name "Lemonize daily backup" \
          --retention "$APPWRITE_BACKUP_RETENTION_DAYS" \
          --schedule "$APPWRITE_BACKUP_SCHEDULE" \
          --enabled true > "$HOME/policy-updated.json"
        echo "Appwrite backup policy configuration was reconciled"
        ;;
      missing)
        "$APPWRITE_BIN" --json backups create-policy \
          --policy-id "$APPWRITE_BACKUP_POLICY_ID" \
          --services tablesdb functions storage \
          --retention "$APPWRITE_BACKUP_RETENTION_DAYS" \
          --schedule "$APPWRITE_BACKUP_SCHEDULE" \
          --name "Lemonize daily backup" \
          --enabled true > "$HOME/policy-created.json"
        echo "Appwrite backup policy was created"
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
      const expected = ["functions", "storage", "tablesdb"];
      const actual = [...(policy.services ?? [])].sort();
      if (!policy.enabled || policy.schedule !== schedule || policy.retention !== Number(retention) ||
          JSON.stringify(actual) !== JSON.stringify(expected) || policy.resourceId) {
        console.error("Appwrite backup policy does not match the required schedule, retention, or services");
        process.exit(1);
      }
      console.log("Appwrite backup policy configuration is valid");
    ' "$policy_file" "$APPWRITE_BACKUP_SCHEDULE" "$APPWRITE_BACKUP_RETENTION_DAYS"
    archives_file="$HOME/archives.json"
    "$APPWRITE_BIN" --json backups list-archives --sort-desc '$createdAt' --limit 100 > "$archives_file"
    node -e '
      const fs = require("node:fs");
      const [path, policyId] = process.argv.slice(1);
      const data = JSON.parse(fs.readFileSync(path, "utf8"));
      const archives = data.archives ?? [];
      const completed = archives
        .filter((archive) => archive.policyId === policyId && archive.status === "completed")
        .map((archive) => ({ archive, createdAt: Date.parse(archive.$createdAt) }));
      if (completed.length === 0) {
        console.error(`No completed Appwrite archive was found for policy ${policyId}`);
        process.exit(1);
      }
      if (completed.some(({ createdAt }) => !Number.isFinite(createdAt))) {
        console.error(`A completed Appwrite archive for policy ${policyId} has an invalid creation time`);
        process.exit(1);
      }
      completed.sort((left, right) => right.createdAt - left.createdAt);
      const { archive: latest, createdAt } = completed[0];
      const age = Date.now() - createdAt;
      const size = Number(latest.size ?? latest.$size);
      if (!Number.isFinite(age) || age < 0 || age > 26 * 60 * 60 * 1000 ||
          !Number.isFinite(size) || size <= 0) {
        console.error(`Newest completed Appwrite archive for policy ${policyId} is stale or empty`);
        process.exit(1);
      }
      console.log("Latest completed Appwrite archive is healthy");
    ' "$archives_file" "$APPWRITE_BACKUP_POLICY_ID"
    ;;
  create)
    archive_file="$HOME/archive-created.json"
    "$APPWRITE_BIN" --json backups create-archive --services tablesdb functions storage > "$archive_file"
    node -e '
      const fs = require("node:fs");
      const archive = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (!archive.$id) process.exit(1);
      console.log("Appwrite backup archive creation was accepted");
    ' "$archive_file"
    ;;
  *)
    echo "usage: $0 <reconcile|verify|create>" >&2
    exit 64
    ;;
esac
