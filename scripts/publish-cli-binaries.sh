#!/usr/bin/env bash
# Upload compiled `lem` binaries to R2 with immutable checksums and manifests.
# Run AFTER building binaries on each OS (see .github/workflows/release-cli.yml).
# REVIEW before running - this writes to your production bucket.
set -euo pipefail

VERSION="${1:-$(node -p "require('./packages/cli/package.json').version")}"
BUCKET="${LEM_BUCKET:-lemonize-artifacts-prod}"
BIN_DIR="${LEM_BIN_DIR:-packages/cli/dist-bin}"
CANONICAL_BINARIES=(lem-linux-x64 lem-darwin-x64 lem-darwin-arm64 lem-windows-x64.exe)

# Both values become part of an R2 object key. Keep validation here even though
# arguments are quoted so a compromised release environment cannot escape the
# intended cli/v<version>/ prefix or turn a positional argument into an option.
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
  echo "Invalid CLI version: $VERSION" >&2
  exit 1
fi
if [[ ! "$BUCKET" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "Invalid R2 bucket name: $BUCKET" >&2
  exit 1
fi
if [[ ! -d "$BIN_DIR" ]]; then
  echo "Binary directory does not exist: $BIN_DIR" >&2
  exit 1
fi

required_artifacts=("${CANONICAL_BINARIES[@]}")
# This override may add release targets, but it must not weaken the canonical
# completeness check for the production release.
if [[ -n "${LEM_REQUIRED_BINARIES:-}" ]]; then
  read -r -a additional_required_artifacts <<< "$LEM_REQUIRED_BINARIES"
  required_artifacts+=("${additional_required_artifacts[@]}")
fi
for name in "${required_artifacts[@]}"; do
  if [[ ! "$name" =~ ^lem-(linux|darwin)-(x64|arm64)$ && ! "$name" =~ ^lem-windows-(x64|arm64)\.exe$ ]]; then
    echo "Invalid required binary name: $name" >&2
    exit 1
  fi
  if [[ ! -f "$BIN_DIR/$name" || -L "$BIN_DIR/$name" ]]; then
    echo "Release is incomplete; missing regular artifact: $name" >&2
    exit 1
  fi
done

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT
staged_dir="$tmp_dir/artifacts"
mkdir -p "$staged_dir"
records="$tmp_dir/artifacts.tsv"
: > "$records"

sha256_file() {
  node -e 'const {createHash}=require("node:crypto");const {readFileSync}=require("node:fs");process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))' "$1"
}

shopt -s nullglob
candidates=("$BIN_DIR"/lem-*)
artifacts=()

# Validate every artifact and every build-time checksum before starting any
# remote writes. Sidecars are normalized into the temporary directory.
for f in "${candidates[@]}"; do
  name="$(basename "$f")"
  if [[ ! "$name" =~ ^lem-(linux|darwin)-(x64|arm64)$ && ! "$name" =~ ^lem-windows-(x64|arm64)\.exe$ ]]; then
    continue
  fi
  if [[ ! -f "$f" || -L "$f" ]]; then
    echo "Refusing non-regular or symlinked artifact: $f" >&2
    exit 1
  fi

  # Upload the same immutable snapshot that is hashed below. Otherwise a
  # concurrent build or local write between validation and upload could make
  # the remote binary disagree with its checksum and manifest.
  staged="$staged_dir/$name"
  cp -- "$f" "$staged"
  digest="$(sha256_file "$staged")"
  sidecar="$f.sha256"
  if [[ ! -e "$sidecar" ]]; then
    echo "Missing build checksum for $name" >&2
    exit 1
  fi
  if [[ ! -f "$sidecar" || -L "$sidecar" ]]; then
    echo "Refusing non-regular or symlinked checksum: $sidecar" >&2
    exit 1
  fi
  checksum_record="$(tr -d '\r\n' < "$sidecar")"
  if [[ "$checksum_record" =~ ^([0-9A-Fa-f]{64})[[:space:]][[:space:]](.+)$ ]]; then
    expected_digest="$(printf '%s' "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')"
    expected_name="${BASH_REMATCH[2]}"
  else
    echo "Malformed checksum sidecar for $name" >&2
    exit 1
  fi
  if [[ "$expected_name" != "$name" || "$expected_digest" != "$digest" ]]; then
    echo "Checksum verification failed for $name" >&2
    exit 1
  fi

  size="$(wc -c < "$staged" | tr -d '[:space:]')"
  printf '%s\t%s\t%s\n' "$name" "$digest" "$size" >> "$records"
  printf '%s  %s\n' "$digest" "$name" > "$tmp_dir/$name.sha256"
  artifacts+=("$staged")
done

if (( ${#artifacts[@]} == 0 )); then
  echo "No supported lem binaries found in $BIN_DIR" >&2
  exit 1
fi

published_at="$(node -p 'new Date().toISOString()')"
manifest="$tmp_dir/manifest.json"
node --input-type=module - "$VERSION" "$records" "$manifest" "$published_at" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const [version, recordsPath, manifestPath, publishedAt] = process.argv.slice(2);
const rows = readFileSync(recordsPath, 'utf8').trim().split('\n').filter(Boolean);
const artifacts = rows.map((row) => {
  const [name, sha256, size] = row.split('\t');
  return {
    name,
    key: `cli/v${version}/${name}`,
    sha256,
    size: Number(size),
  };
});

writeFileSync(manifestPath, `${JSON.stringify({
  schemaVersion: 1,
  version,
  publishedAt,
  artifacts,
}, null, 2)}\n`);
NODE

manifest_digest="$(sha256_file "$manifest")"
printf '%s  manifest.json\n' "$manifest_digest" > "$tmp_dir/manifest.json.sha256"

echo "Uploading ${#artifacts[@]} lem binaries v$VERSION from $BIN_DIR to r2://$BUCKET"

# Versioned release objects are immutable. Wrangler does not currently expose
# R2 conditional PUT, so preflight every key and refuse any non-identical
# existing object. A second verification pass runs before moving `latest`.
declare -A existing_versioned=()
remote_counter=0
preflight_versioned() {
  local key=$1
  local local_file=$2
  local remote_file="$tmp_dir/remote-$remote_counter"
  local log_file="$tmp_dir/remote-$remote_counter.log"
  remote_counter=$((remote_counter + 1))
  if wrangler r2 object get "$BUCKET/$key" --file "$remote_file" --remote >"$log_file" 2>&1; then
    if ! cmp -s -- "$local_file" "$remote_file"; then
      echo "Refusing to overwrite immutable R2 object with different bytes: $key" >&2
      exit 1
    fi
    existing_versioned["$key"]=1
  elif grep -Fq 'The specified key does not exist.' "$log_file"; then
    rm -f -- "$remote_file"
  else
    cat "$log_file" >&2
    echo "Could not verify immutable R2 object: $key" >&2
    exit 1
  fi
}

put_versioned() {
  local key=$1
  local local_file=$2
  if [[ -n "${existing_versioned[$key]:-}" ]]; then
    echo "  verified existing $key"
  else
    wrangler r2 object put "$BUCKET/$key" --file "$local_file" --remote
  fi
}

for f in "${artifacts[@]}"; do
  name="$(basename "$f")"
  preflight_versioned "cli/v$VERSION/$name" "$f"
  preflight_versioned "cli/v$VERSION/$name.sha256" "$tmp_dir/$name.sha256"
done
preflight_versioned "cli/v$VERSION/manifest.json" "$manifest"
preflight_versioned "cli/v$VERSION/manifest.json.sha256" "$tmp_dir/manifest.json.sha256"

# Publish the immutable release completely before touching either latest form.
for f in "${artifacts[@]}"; do
  name="$(basename "$f")"
  put_versioned "cli/v$VERSION/$name" "$f"
  put_versioned "cli/v$VERSION/$name.sha256" "$tmp_dir/$name.sha256"
  echo "  uploaded $name"
done
put_versioned "cli/v$VERSION/manifest.json" "$manifest"
put_versioned "cli/v$VERSION/manifest.json.sha256" "$tmp_dir/manifest.json.sha256"

# Detect any concurrent conflicting write before updating mutable aliases.
for f in "${artifacts[@]}"; do
  name="$(basename "$f")"
  preflight_versioned "cli/v$VERSION/$name" "$f"
  preflight_versioned "cli/v$VERSION/$name.sha256" "$tmp_dir/$name.sha256"
done
preflight_versioned "cli/v$VERSION/manifest.json" "$manifest"
preflight_versioned "cli/v$VERSION/manifest.json.sha256" "$tmp_dir/manifest.json.sha256"

# Keep legacy /cli/latest/<binary> installers working. New clients should read
# cli/latest.json and then fetch only immutable versioned keys from its manifest.
for f in "${artifacts[@]}"; do
  name="$(basename "$f")"
  wrangler r2 object put "$BUCKET/cli/latest/$name" --file "$f" --remote
  wrangler r2 object put "$BUCKET/cli/latest/$name.sha256" --file "$tmp_dir/$name.sha256" --remote
done

pointer="$tmp_dir/latest.json"
node --input-type=module - "$VERSION" "$manifest_digest" "$pointer" "$published_at" <<'NODE'
import { writeFileSync } from 'node:fs';

const [version, manifestSha256, pointerPath, publishedAt] = process.argv.slice(2);
writeFileSync(pointerPath, `${JSON.stringify({
  schemaVersion: 1,
  channel: 'latest',
  version,
  manifest: `cli/v${version}/manifest.json`,
  manifestSha256,
  publishedAt,
}, null, 2)}\n`);
NODE

# R2 object PUTs are atomic. Updating this one small object last means readers
# see either the previous complete release or this complete release, never a
# partially uploaded set of versioned artifacts.
wrangler r2 object put "$BUCKET/cli/latest.json" --file "$pointer" --remote

echo "Published v$VERSION (manifest SHA-256: $manifest_digest)"
echo "Users can install with: curl -fsSL https://registry.lemonize.cyou/install.sh | sh"
