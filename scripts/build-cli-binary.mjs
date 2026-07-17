#!/usr/bin/env node
/**
 * Build a standalone `lem` executable for the HOST platform using Node's
 * Single Executable Applications (SEA) feature — no Node/npm required by users.
 *
 * Cross-OS binaries are produced by running this on each OS in CI
 * (see .github/workflows/release-cli.yml). Run locally:
 *
 *   node scripts/build-cli-binary.mjs
 *
 * Output: packages/cli/dist-bin/lem-<os>-<arch>[.exe]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, arch } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const cliDir = join(root, 'packages', 'cli');
const workDir = join(cliDir, '.sea-build');
const outDir = join(cliDir, 'dist-bin');
const isWin = platform() === 'win32';
const isMac = platform() === 'darwin';

const osName = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform()] ?? platform();
const binName = `lem-${osName}-${arch()}${isWin ? '.exe' : ''}`;
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: cliDir, ...opts });

console.log(`› Building lem for ${osName}/${arch()}…`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

// 1) Bundle the CLI into a single CommonJS file (SEA requires CJS).
//    esbuild bundles ALL dependencies (commander, tar, @lemonize/*), leaving
//    only Node builtins external — exactly what a self-contained binary needs.
console.log('› Bundling CLI (esbuild, cjs)…');
const bundle = join(workDir, 'lem.cjs');
run('pnpm', [
  'exec',
  'esbuild',
  'src/lem.ts',
  '--bundle',
  '--platform=node',
  '--target=node24',
  '--format=cjs',
  `--outfile=${bundle}`,
  '--minify',
]);
if (!existsSync(bundle)) throw new Error(`Expected bundle at ${bundle}`);

// 2) SEA config + preparation blob.
const seaConfig = join(workDir, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: 'lem.cjs',
      output: 'sea-prep.blob',
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
    },
    null,
    2,
  ),
);
console.log('› Generating SEA blob…');
run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: workDir });

// 3) Copy the Node binary and inject the blob.
const target = join(outDir, binName);
copyFileSync(process.execPath, target);
const blob = join(workDir, 'sea-prep.blob');
const postjectArgs = [target, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE];
if (isMac) {
  // Injecting a Mach-O segment invalidates Node's existing signature. Remove
  // it first, then apply an ad-hoc signature to the finished executable.
  run('codesign', ['--remove-signature', target]);
  postjectArgs.push('--macho-segment-name', 'NODE_SEA');
}
console.log('› Injecting blob (postject)…');
run('pnpm', ['exec', 'postject', ...postjectArgs]);
if (isMac) run('codesign', ['--sign', '-', target]);
if (!isWin) run('chmod', ['+x', target], { cwd: outDir });

// Emit a checksum next to the binary. The publishing script verifies this
// sidecar before uploading and includes the digest in the release manifest.
const checksum = createHash('sha256').update(readFileSync(target)).digest('hex');
writeFileSync(`${target}.sha256`, `${checksum}  ${binName}\n`, { encoding: 'utf8', mode: 0o644 });

console.log(`✔ Built ${join('packages/cli/dist-bin', binName)}`);
console.log(`✔ SHA-256 ${checksum}`);
