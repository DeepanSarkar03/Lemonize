import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = () => mkdtempSync(join(tmpdir(), 'lem-auth-command-'));
const REGISTRY = 'https://registry.example.test';

describe('authenticated CLI commands', () => {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    process.chdir(originalCwd);
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('requires login before init writes an unowned package name', async () => {
    const cwd = tmp();
    process.chdir(cwd);
    vi.stubEnv('LEMONIZE_HOME', tmp());
    vi.stubEnv('LEMONIZE_TOKEN', '');
    vi.resetModules();
    const { cmdInit } = await import('../src/commands.js');

    await expect(cmdInit({ registry: REGISTRY })).rejects.toThrow(/lem login/);
    expect(existsSync(join(cwd, 'package.json'))).toBe(false);
  });

  it('scopes init to the authenticated namespace', async () => {
    const cwd = join(tmp(), 'My New Package');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(cwd, { recursive: true }));
    process.chdir(cwd);
    vi.stubEnv('LEMONIZE_HOME', tmp());
    vi.stubEnv('LEMONIZE_REGISTRY', REGISTRY);
    vi.stubEnv('LEMONIZE_TOKEN', 'lem_live_test');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            user: {
              id: 'user-1',
              username: 'alice',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          }),
        ),
    ) as unknown as typeof fetch;
    vi.resetModules();
    const { cmdInit } = await import('../src/commands.js');

    await cmdInit({ registry: REGISTRY });
    const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
      name: string;
    };
    expect(manifest.name).toBe('@alice/my-new-package');
  });

  it('clears local credentials but reports a failed remote revocation', async () => {
    vi.stubEnv('LEMONIZE_HOME', tmp());
    vi.stubEnv('LEMONIZE_REGISTRY', '');
    vi.stubEnv('LEMONIZE_TOKEN', '');
    vi.resetModules();
    const config = await import('../src/lib/config.js');
    config.setToken(REGISTRY, 'lem_live_stored');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'INTERNAL', message: 'revocation unavailable', requestId: 'req-logout' },
          }),
          { status: 500 },
        ),
    ) as unknown as typeof fetch;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { cmdLogout } = await import('../src/commands.js');

    await cmdLogout({ registry: REGISTRY });
    expect(config.getToken(REGISTRY)).toBeNull();
    expect(warning.mock.calls.flat().join(' ')).toContain('req-logout');
  });

  it('creates a 30-day token by default and forwards requested scopes', async () => {
    vi.stubEnv('LEMONIZE_HOME', tmp());
    vi.stubEnv('LEMONIZE_REGISTRY', REGISTRY);
    vi.stubEnv('LEMONIZE_TOKEN', 'lem_live_manager');
    let requestBody: unknown;
    globalThis.fetch = vi.fn(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: 'token-2',
          token: 'lem_live_child',
          label: 'automation',
          scopes: ['read', 'publish'],
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-31T00:00:00.000Z',
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.resetModules();
    const { cmdTokenCreate } = await import('../src/commands.js');

    await cmdTokenCreate('automation', {
      registry: REGISTRY,
      scopes: ['read', 'publish'],
    });
    expect(requestBody).toEqual({
      label: 'automation',
      expiresInDays: 30,
      scopes: ['read', 'publish'],
    });
  });

  it('rejects token-management delegation before making a request', async () => {
    vi.stubEnv('LEMONIZE_HOME', tmp());
    vi.stubEnv('LEMONIZE_REGISTRY', REGISTRY);
    vi.stubEnv('LEMONIZE_TOKEN', 'lem_live_manager');
    const fetcher = vi.fn();
    globalThis.fetch = fetcher as unknown as typeof fetch;
    vi.resetModules();
    const { cmdTokenCreate } = await import('../src/commands.js');

    await expect(
      cmdTokenCreate('delegated-manager', {
        registry: REGISTRY,
        scopes: ['manage:tokens'],
      }),
    ).rejects.toThrow('CLI-created tokens may use read, publish, or manage:packages');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
