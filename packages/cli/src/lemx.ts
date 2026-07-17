/**
 * `lemx <package> [-- args...]` — alias for `lem exec`.
 * Resolves, caches and runs a package binary. Passes through args after `--`.
 */
import { configureLogger, log } from './lib/logger.js';
import { cmdExec } from './commands.js';

async function main() {
  const argv = process.argv.slice(2);
  configureLogger({ json: false, verbose: argv.includes('--verbose'), color: !argv.includes('--no-color') });

  // Split on the first `--`; everything after is passed to the bin unchanged.
  const sepIndex = argv.indexOf('--');
  const head = sepIndex === -1 ? argv : argv.slice(0, sepIndex);
  const passthrough = sepIndex === -1 ? [] : argv.slice(sepIndex + 1);

  let registry: string | undefined;
  const rIdx = head.indexOf('--registry');
  if (rIdx !== -1) registry = head[rIdx + 1];

  const pkg = head.find((a) => !a.startsWith('-') && a !== registry);
  if (!pkg) {
    log.error('Usage: lemx <package> [-- args...]');
    process.exitCode = 1;
    return;
  }
  try {
    await cmdExec(pkg, passthrough, { registry, verbose: head.includes('--verbose') });
  } catch (err) {
    log.error((err as Error).message);
    process.exitCode = 1;
  }
}

void main();
