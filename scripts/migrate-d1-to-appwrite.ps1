param(
  [switch]$Apply,
  [string]$Database = 'lemonize_db',
  [string]$Bucket = 'lemonize-artifacts-prod',
  [string]$ProjectId = 'lemonize-prod-2026',
  [string]$Endpoint = 'https://fra.cloud.appwrite.io/v1',
  [string]$OwnerEmailMap = '{"deepan":"deepansarkar03@gmail.com"}',
  [string]$ConfirmCutover = ''
)

$ErrorActionPreference = 'Stop'

function Invoke-D1Query([string]$Sql) {
  $raw = & pnpm dlx wrangler@4.111.0 d1 execute $Database --remote --command $Sql --json
  if ($LASTEXITCODE -ne 0) { throw 'D1 query failed.' }
  $decoded = $raw | ConvertFrom-Json
  if (-not $decoded[0].success) { throw 'D1 query was not successful.' }
  return @($decoded[0].results)
}

$source = @{
  users = @(Invoke-D1Query 'SELECT id, username, email FROM users ORDER BY id')
  packages = @(Invoke-D1Query 'SELECT id, name, normalized_name, scope, owner_user_id, description, readme, latest_version, deleted_at FROM packages ORDER BY id')
  versions = @(Invoke-D1Query 'SELECT id, package_id, version, tarball_key, integrity, shasum, unpacked_size, tarball_size, file_count, manifest_json, published_by, published_at, deprecated_message, yanked_at FROM package_versions ORDER BY id')
  tags = @(Invoke-D1Query 'SELECT id, package_id, tag, version FROM dist_tags ORDER BY id')
}

if ($Apply) {
  $activeTokens = @(Invoke-D1Query 'SELECT COUNT(*) AS count FROM api_tokens WHERE revoked_at IS NULL')[0].count
  if ([int]$activeTokens -ne 0) {
    throw 'Legacy writes are not frozen: active D1 API tokens still exist.'
  }
}

# Verify the exact R2 keys used by the target Worker, not only the public HTTP
# route. Production writes must already be frozen before this snapshot.
$proofs = @()
foreach ($version in $source.versions) {
  $temporary = [IO.Path]::GetTempFileName()
  try {
    & pnpm dlx wrangler@4.111.0 r2 object get "$Bucket/$($version.tarball_key)" --remote --file $temporary --config apps/registry-worker/wrangler.jsonc
    if ($LASTEXITCODE -ne 0) { throw "R2 object missing: $($version.tarball_key)" }
    $bytes = [IO.File]::ReadAllBytes($temporary)
    $sha256 = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    $sha512 = 'sha512-' + [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($bytes))
    if ($bytes.Length -ne $version.tarball_size -or $sha256 -ne $version.shasum -or $sha512 -ne $version.integrity) {
      throw "R2 integrity mismatch: $($version.tarball_key)"
    }
    $proofs += @{
      key = $version.tarball_key
      size = $bytes.Length
      shasum = $sha256
      integrity = $sha512
    }
  }
  finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}
$source.r2Proofs = $proofs

$env:CF_D1_DATABASE_NAME = $Database
$env:LEGACY_R2_BUCKET = $Bucket
$env:APPWRITE_PROJECT_ID = $ProjectId
$env:APPWRITE_ENDPOINT = $Endpoint
$env:LEGACY_OWNER_EMAIL_MAP = $OwnerEmailMap

$arguments = @('scripts/migrate-d1-to-appwrite.mjs', '--stdin')
if ($Apply) {
  if ($ConfirmCutover -ne $ProjectId) {
    throw 'For --Apply, -ConfirmCutover must exactly equal -ProjectId.'
  }
  $env:CONFIRM_CUTOVER = $ConfirmCutover
  $arguments += '--apply'
}
$source | ConvertTo-Json -Depth 20 -Compress | & node @arguments
if ($LASTEXITCODE -ne 0) { throw 'D1 to Appwrite migration failed.' }
