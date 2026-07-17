import { Hono } from 'hono';
import { notFound, ErrorCodes } from '@lemonize/shared';
import type { AppBindings } from '../lib/env.js';
import { rateLimit } from '../lib/ratelimit.js';
import { IMMUTABLE_CACHE, METADATA_CACHE } from '../lib/http-cache.js';

/**
 * CLI distribution: serve a one-line installer and stream the standalone `lem`
 * binaries from R2. This is how end users get the CLI WITHOUT npm or Node —
 * exactly like `curl -fsSL https://bun.sh/install | bash`.
 *
 * Binaries live in R2 under:  cli/{channel}/lem-{os}-{arch}[.exe]
 * (uploaded by CI on release; `latest` is the default channel.)
 */
export const cli = new Hono<AppBindings>();

// Only these object names may be requested — prevents arbitrary R2 key access.
const BINARY_RE = /^lem-(linux|darwin|windows)-(x64|arm64)(\.exe)?$/;
const FILE_RE = /^(?:lem-(?:linux|darwin|windows)-(?:x64|arm64)(?:\.exe)?(?:\.sha256)?|manifest\.json(?:\.sha256)?)$/;
const CHANNEL_RE = /^(latest|v[0-9][0-9A-Za-z._-]*)$/;

function shInstaller(base: string): string {
  return `#!/bin/sh
# Lemonize CLI installer — installs the standalone \`lem\` binary. No Node/npm needed.
#   curl -fsSL ${base}/install.sh | sh
set -eu

BASE="\${LEM_INSTALL_BASE:-${base}}"
CHANNEL="\${LEM_CHANNEL:-latest}"
INSTALL_DIR="\${LEM_INSTALL_DIR:-$HOME/.lemonize/bin}"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in linux) os=linux ;; darwin) os=darwin ;; *) echo "Unsupported OS: $os"; exit 1 ;; esac
arch=$(uname -m)
case "$arch" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "Unsupported arch: $arch"; exit 1 ;; esac

file="lem-\${os}-\${arch}"
url="\${BASE}/cli/\${CHANNEL}/\${file}"
echo "Downloading lem (\${os}/\${arch}) from \${url}"
mkdir -p "$INSTALL_DIR"
tmp="$(mktemp)"
sum_tmp="$(mktemp)"
trap 'rm -f "$tmp" "$sum_tmp"' EXIT HUP INT TERM
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp"
  curl -fsSL "$url.sha256" -o "$sum_tmp"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp" "$url"
  wget -qO "$sum_tmp" "$url.sha256"
else echo "Need curl or wget."; exit 1; fi
expected=$(awk 'NR==1 {print $1}' "$sum_tmp")
expected_file=$(awk 'NR==1 {print $2}' "$sum_tmp")
case "$expected" in *[!0-9a-fA-F]*|'') echo "Invalid release checksum."; exit 1 ;; esac
if [ "\${#expected}" -ne 64 ] || [ "$expected_file" != "$file" ]; then
  echo "Invalid release checksum record."; exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$tmp" | awk '{print $1}')
else echo "Need sha256sum or shasum to verify the download."; exit 1; fi
if [ "$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')" ]; then
  echo "Checksum verification failed; refusing to install."; exit 1
fi
chmod +x "$tmp"
mv "$tmp" "$INSTALL_DIR/lem"

echo ""
echo "Installed lem -> $INSTALL_DIR/lem"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) : ;;
  *) echo "Add it to your PATH:"; echo "  export PATH=\\"$INSTALL_DIR:\\$PATH\\"" ;;
esac
echo "Then run:  lem install stape-cli/latest"
`;
}

function ps1Installer(base: string): string {
  return `# Lemonize CLI installer (Windows). No Node/npm needed.
#   irm ${base}/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$base = if ($env:LEM_INSTALL_BASE) { $env:LEM_INSTALL_BASE } else { '${base}' }
$channel = if ($env:LEM_CHANNEL) { $env:LEM_CHANNEL } else { 'latest' }
$dir = if ($env:LEM_INSTALL_DIR) { $env:LEM_INSTALL_DIR } else { "$env:USERPROFILE\\.lemonize\\bin" }
$arch = if ([System.Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x64' }
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
$file = "lem-windows-$arch.exe"
$url = "$base/cli/$channel/$file"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Host "Downloading lem (windows/$arch) from $url"
$temp = Join-Path ([IO.Path]::GetTempPath()) ("lem-" + [guid]::NewGuid().ToString('N') + '.exe')
$sumTemp = "$temp.sha256"
try {
  Invoke-WebRequest -Uri $url -OutFile $temp
  Invoke-WebRequest -Uri "$url.sha256" -OutFile $sumTemp
  $record = (Get-Content -LiteralPath $sumTemp -Raw).Trim()
  if ($record -notmatch '^([0-9A-Fa-f]{64})\\s{2}(.+)$' -or $Matches[2] -ne $file) {
    throw 'Invalid release checksum record.'
  }
  $expected = $Matches[1]
  $actual = (Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash
  if ($actual -ne $expected) { throw 'Checksum verification failed; refusing to install.' }
  Move-Item -LiteralPath $temp -Destination "$dir\\lem.exe" -Force
}
finally {
  Remove-Item -LiteralPath $temp,$sumTemp -Force -ErrorAction SilentlyContinue
}
$userPath = [Environment]::GetEnvironmentVariable('Path','User')
if ($userPath -notlike "*$dir*") {
  [Environment]::SetEnvironmentVariable('Path', "$dir;$userPath", 'User')
  Write-Host "Added $dir to your PATH (restart your terminal)."
}
Write-Host "Installed lem -> $dir\\lem.exe"
Write-Host "Then run:  lem install stape-cli/latest"
`;
}

cli.get('/install.sh', (c) => {
  const base = c.get('config').registryBaseUrl;
  return c.body(shInstaller(base), 200, {
    'content-type': 'text/x-shellscript; charset=utf-8',
    'cache-control': METADATA_CACHE,
  });
});

cli.get('/install.ps1', (c) => {
  const base = c.get('config').registryBaseUrl;
  return c.body(ps1Installer(base), 200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': METADATA_CACHE,
  });
});

cli.get('/cli/latest.json', async (c) => {
  const obj = await c.env.BUCKET.get('cli/latest.json');
  if (!obj) throw notFound(ErrorCodes.NOT_FOUND, 'CLI release pointer not found.');
  return new Response(obj.body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': METADATA_CACHE,
      'x-content-type-options': 'nosniff',
    },
  });
});

// Stream a CLI binary from R2 (public download; no auth).
cli.get('/cli/:channel/:file', async (c) => {
  await rateLimit(c, 'read', c.get('config').rateLimitReadsPerMinute);
  const channel = c.req.param('channel');
  const file = c.req.param('file');
  if (!CHANNEL_RE.test(channel) || !FILE_RE.test(file)) {
    throw notFound(ErrorCodes.NOT_FOUND, 'Unknown CLI artifact.');
  }
  const key = `cli/${channel}/${file}`;
  const obj = await c.env.BUCKET.get(key);
  if (!obj) throw notFound(ErrorCodes.NOT_FOUND, `CLI build ${channel}/${file} not found.`);
  const immutable = channel !== 'latest';
  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': file.endsWith('.json')
        ? 'application/json; charset=utf-8'
        : file.endsWith('.sha256')
          ? 'text/plain; charset=utf-8'
          : 'application/octet-stream',
      ...(BINARY_RE.test(file) ? { 'content-disposition': `attachment; filename="${file}"` } : {}),
      'cache-control': immutable ? IMMUTABLE_CACHE : METADATA_CACHE,
      'x-content-type-options': 'nosniff',
    },
  });
});
