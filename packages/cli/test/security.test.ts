import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type ConfigModule = typeof import('../src/lib/config.js');
type HttpModule = typeof import('../src/lib/http.js');

const tempHome = () => mkdtempSync(join(tmpdir(), 'lem-security-'));

describe('CLI registry credential boundary', () => {
  let config: ConfigModule;
  let http: HttpModule;
  let realFetch: typeof fetch;

  beforeEach(async () => {
    realFetch = globalThis.fetch;
    vi.stubEnv('LEMONIZE_HOME', tempHome());
    vi.stubEnv('LEMONIZE_REGISTRY', '');
    vi.stubEnv('LEMONIZE_TOKEN', '');
    vi.resetModules();
    config = await import('../src/lib/config.js');
    http = await import('../src/lib/http.js');
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('uses the production registry by default', () => {
    expect(config.resolveRegistry({ cwd: tempHome() })).toBe('https://registry.lemonize.cyou');
  });

  it('accepts HTTPS and exact loopback HTTP registries only', () => {
    expect(config.validateRegistryUrl('https://registry.example.test/')).toBe('https://registry.example.test');
    expect(config.validateRegistryUrl('http://localhost:8787/')).toBe('http://localhost:8787');
    expect(config.validateRegistryUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(config.validateRegistryUrl('http://[::1]:8787/')).toBe('http://[::1]:8787');

    for (const value of [
      'http://registry.example.test',
      'http://localhost.example.test',
      'ftp://registry.example.test',
      'https://user:pass@registry.example.test',
      'https://registry.example.test?next=evil',
      'https://registry.example.test?',
      'https://registry.example.test/#fragment',
      'https://registry.example.test/#',
      ' https://registry.example.test',
      'https://registry.example.test/line\nbreak',
    ]) {
      expect(() => config.validateRegistryUrl(value)).toThrow();
    }
  });

  it('binds LEMONIZE_TOKEN to LEMONIZE_REGISTRY origin', () => {
    vi.stubEnv('LEMONIZE_TOKEN', 'environment-secret');

    expect(config.getToken('https://registry.lemonize.cyou/v1')).toBe('environment-secret');
    expect(config.getToken('https://custom.example.test')).toBeNull();

    vi.stubEnv('LEMONIZE_REGISTRY', 'https://trusted.example.test/api');

    expect(config.getToken('https://trusted.example.test/other-base')).toBe('environment-secret');
    expect(config.getToken('https://evil.example.test')).toBeNull();
  });

  it('does not allow an authenticated client request to leave its registry origin', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const guardedFetch = http.createSecureRegistryFetch('https://trusted.example.test');

    await expect(
      guardedFetch('https://evil.example.test/v1/auth/me', {
        headers: { authorization: 'Bearer environment-secret' },
      }),
    ).rejects.toThrow(/untrusted origin/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to forward client credentials through redirects', async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example.test/collect' } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const guardedFetch = http.createSecureRegistryFetch('https://trusted.example.test');

    await expect(
      guardedFetch('https://trusted.example.test/v1/auth/me', {
        headers: { authorization: 'Bearer environment-secret' },
      }),
    ).rejects.toThrow(/redirect/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
  });

  it('follows package redirects without forwarding the registry token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/pkg.tgz' } }),
      )
      .mockResolvedValueOnce(new Response('package bytes', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await http.fetchPackageResource(
      'https://trusted.example.test',
      'https://trusted.example.test/v1/tarball',
      'environment-secret',
    );

    expect(await response.text()).toBe('package bytes');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = new Headers(fetchMock.mock.calls[0]![1]!.headers);
    const redirectedHeaders = new Headers(fetchMock.mock.calls[1]![1]!.headers);
    expect(firstHeaders.get('authorization')).toBe('Bearer environment-secret');
    expect(redirectedHeaders.has('authorization')).toBe(false);
  });

  it('never sends the registry token to a cross-origin tarball URL', async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      new Response('package bytes', { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await http.fetchPackageResource(
      'https://trusted.example.test',
      'https://cdn.example.test/pkg.tgz',
      'environment-secret',
    );

    const headers = new Headers(fetchMock.mock.calls[0]![1]!.headers);
    expect(headers.has('authorization')).toBe(false);
  });

  it('rejects traversal package names for install, remove, and exec', async () => {
    const cwd = tempHome();
    const outside = join(cwd, '..', `lem-victim-${Date.now()}`);
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'test-project', dependencies: {} }));
    writeFileSync(outside, 'do not delete');
    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      const commands = await import('../src/commands.js');
      const options = { registry: 'https://registry.example.test' };
      await expect(commands.cmdInstall(['../victim'], options)).rejects.toThrow(/Invalid package name/);
      await expect(commands.cmdRemove(['../victim'], options)).rejects.toThrow(/Invalid package name/);
      await expect(commands.cmdExec('../victim', [], options)).rejects.toThrow(/Invalid package name/);
      expect(existsSync(outside)).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
