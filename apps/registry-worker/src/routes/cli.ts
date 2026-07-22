import { Hono } from 'hono';
import type { AppBindings } from '../lib/env.js';
import { METADATA_CACHE } from '../lib/http-cache.js';

/**
 * CLI bootstrap scripts deliberately delegate to npm. A checksum served beside
 * a mutable native binary does not establish publisher authenticity, while the
 * npm release is protected by the registry and OIDC provenance.
 */
export const cli = new Hono<AppBindings>();

function shInstaller(): string {
  return `#!/bin/sh
# Lemonize CLI installer. Uses the provenance-enabled npm package.
set -eu

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required: https://nodejs.org/" >&2
  exit 1
fi

npm install --global @lemonize/cli@latest
`;
}

function ps1Installer(): string {
  return `# Lemonize CLI installer (Windows). Uses the provenance-enabled npm package.
$ErrorActionPreference = 'Stop'

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'Node.js and npm are required: https://nodejs.org/'
}

npm install --global @lemonize/cli@latest
`;
}

cli.get('/install.sh', (c) =>
  c.body(shInstaller(), 200, {
    'content-type': 'text/x-shellscript; charset=utf-8',
    'cache-control': METADATA_CACHE,
  }),
);

cli.get('/install.ps1', (c) =>
  c.body(ps1Installer(), 200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': METADATA_CACHE,
  }),
);
