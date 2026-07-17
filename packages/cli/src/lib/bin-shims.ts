import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

/**
 * Create cross-platform executable shims in node_modules/.bin, without any
 * shell interpolation. Mirrors the standard three-file approach.
 */
export function createBinShims(
  nodeModulesDir: string,
  pkgDir: string,
  bin: Record<string, string>,
): string[] {
  const binDir = join(nodeModulesDir, '.bin');
  mkdirSync(binDir, { recursive: true });
  const created: string[] = [];

  for (const [command, target] of Object.entries(bin)) {
    const safeCmd = command.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safeCmd) continue;
    const absTarget = join(pkgDir, target);
    const rel = relative(binDir, absTarget).split('\\').join('/');

    // POSIX shell shim
    const sh = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
exec node "$basedir/${rel}" "$@"
`;
    const shPath = join(binDir, safeCmd);
    writeFileSync(shPath, sh, { mode: 0o755 });
    try {
      chmodSync(shPath, 0o755);
    } catch {
      /* non-posix */
    }

    // Windows .cmd shim
    const cmd = `@ECHO OFF\r\nnode "%~dp0\\${rel.split('/').join('\\')}" %*\r\n`;
    writeFileSync(join(binDir, `${safeCmd}.cmd`), cmd);

    created.push(safeCmd);
  }
  return created;
  void dirname;
}
