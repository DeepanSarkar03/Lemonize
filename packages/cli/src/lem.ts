import { Command } from 'commander';
import { configureLogger, log } from './lib/logger.js';
import { ApiClientError } from '@lemonize/shared';
import * as cmd from './commands.js';
import { CLI_VERSION } from './version.js';

const program = new Command();

program
  .name('lem')
  .description('Lemonize — publish, install and run JavaScript/TypeScript packages.')
  .version(CLI_VERSION)
  .option('--registry <url>', 'registry URL override')
  .option('--json', 'machine-readable JSON output', false)
  .option('--verbose', 'verbose logging', false)
  .option('--no-color', 'disable colored output');

program.hook('preAction', (thisCommand) => {
  const o = thisCommand.opts();
  configureLogger({ json: !!o.json, verbose: !!o.verbose, color: o.color !== false });
});

const g = () => program.opts();

program
  .command('init')
  .description('scaffold a new package.json')
  .action(async () => {
    await cmd.cmdInit(g());
  });

program
  .command('login')
  .description('authenticate this device with the registry')
  .option('-u, --username <name>', 'suggested username')
  .action(async (o) => cmd.cmdLogin({ ...g(), username: o.username }));

program
  .command('logout')
  .description('remove stored credentials')
  .action(async () => cmd.cmdLogout(g()));
program
  .command('whoami')
  .description('print the current user')
  .action(async () => cmd.cmdWhoami(g()));

const token = program.command('token').alias('tokens').description('manage registry access tokens');
token
  .command('list')
  .alias('ls')
  .action(async () => cmd.cmdTokenList(g()));
token
  .command('create <label>')
  .option(
    '--expires-in-days <days>',
    'requested lifetime (1-90 days; default 30, may be capped by the current credential)',
    (value) => Number(value),
    30,
  )
  .option('--scope <scopes...>', 'read, publish, manage:packages')
  .action(async (label, options) =>
    cmd.cmdTokenCreate(label, {
      ...g(),
      expiresInDays: options.expiresInDays,
      scopes: options.scope,
    }),
  );
token.command('revoke <id>').action(async (id) => cmd.cmdTokenRevoke(id, g()));
token.command('revoke-all').action(async () => cmd.cmdTokenRevokeAll(g()));

program
  .command('publish')
  .description('pack and publish the current project')
  .option('--tag <tag>', 'dist-tag to assign', undefined)
  .option('--access <access>', 'public | private', undefined)
  .option('--dry-run', 'pack without uploading', false)
  .option('--resume', 'resume the last matching upload session', false)
  .action(async (o) => cmd.cmdPublish({ ...g(), ...o }));

program
  .command('install [packages...]')
  .alias('i')
  .description('install packages (unscoped targets default to npm; scoped targets need --source)')
  .option('--source <source>', 'package source for explicit targets: npm | lemonize')
  .option('--frozen-lockfile', 'install exactly from lockfileVersion 2', false)
  .option('--dev', 'include development dependencies', false)
  .action(async (pkgs, options) => cmd.cmdInstall(pkgs, { ...g(), ...options }));

program
  .command('add <packages...>')
  .description('install and save packages to dependencies')
  .option('--source <source>', 'package source: npm | lemonize')
  .option('--frozen-lockfile', 'require existing locked resolutions', false)
  .option('-D, --dev', 'save to devDependencies', false)
  .action(async (pkgs, options) => cmd.cmdInstall(pkgs, { ...g(), ...options, save: true }));

program
  .command('remove <packages...>')
  .alias('rm')
  .description('remove packages')
  .action(async (pkgs) => cmd.cmdRemove(pkgs, g()));

program
  .command('update [packages...]')
  .alias('up')
  .description('update packages to the latest satisfying version')
  .option('--frozen-lockfile', 'reject changes to locked resolutions', false)
  .option('--dev', 'include development dependencies', false)
  .action(async (pkgs, options) => cmd.cmdUpdate(pkgs, { ...g(), ...options }));

program
  .command('exec <package> [args...]')
  .description('download (if needed) and run a package binary')
  .action(async (pkg, args) => cmd.cmdExec(pkg, args ?? [], g()));

program
  .command('info <package>')
  .description('show package metadata')
  .action(async (p) => cmd.cmdInfo(p, g()));
program
  .command('search <query>')
  .description('search public packages')
  .action(async (q) => cmd.cmdSearch(q, g()));
program
  .command('list')
  .alias('ls')
  .description('list installed packages')
  .action(async () => cmd.cmdList(g()));
program
  .command('outdated')
  .description('show outdated packages')
  .action(async () => cmd.cmdOutdated(g()));

program
  .command('deprecate <package@version> <message>')
  .description('mark a version as deprecated')
  .action(async (target, message) => cmd.cmdDeprecate(target, message, g()));

program
  .command('unpublish <package@version>')
  .description('yank a version (soft delete)')
  .requiredOption('--force', 'confirm the yank')
  .action(async (target, o) => cmd.cmdUnpublish(target, { ...g(), force: o.force }));

const tag = program.command('tag').description('manage dist-tags');
tag.command('add <package@version> <tag>').action(async (t, name) => cmd.cmdTagAdd(t, name, g()));
tag.command('remove <package> <tag>').action(async (name, t) => cmd.cmdTagRemove(name, t, g()));

const config = program.command('config').description('manage CLI configuration');
config.command('get <key>').action((k) => cmd.cmdConfigGet(k, g()));
config.command('set <key> <value>').action((k, v) => cmd.cmdConfigSet(k, v, g()));
config.command('delete <key>').action((k) => cmd.cmdConfigDelete(k, g()));

const cache = program.command('cache').description('manage the global cache');
cache.command('clean').action(() => cmd.cmdCacheClean(g()));

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof ApiClientError) {
      const request = err.requestId ? ` request=${err.requestId}` : '';
      log.error(`${err.message} ${log.dim(`[${err.code}${request}]`)}`);
    } else {
      log.error((err as Error).message);
    }
    process.exitCode = 1;
  }
}

void main();
