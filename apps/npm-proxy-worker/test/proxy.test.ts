import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { handleProxyRequest, type CacheStore, type ProxyDependencies } from '../src/proxy.js';
import type { AdmissionCandidate, AdmissionDecision } from '../src/admission.js';
import { createApp } from '../src/index.js';
import { MAX_AUDIT_BYTES, MAX_PACKUMENT_BYTES, MAX_TARBALL_BYTES } from '../src/protocol.js';

type StoredResponse = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
};

class MemoryCache implements CacheStore {
  readonly entries = new Map<string, StoredResponse>();
  readonly puts: string[] = [];

  async match(request: Request): Promise<Response | undefined> {
    const stored = this.entries.get(request.url);
    if (!stored) return undefined;
    const body = stored.body ? stored.body.slice(0) : null;
    return new Response(body, {
      status: stored.status,
      statusText: stored.statusText,
      headers: stored.headers,
    });
  }

  async put(request: Request, response: Response): Promise<void> {
    const body = response.body ? await response.arrayBuffer() : null;
    this.entries.set(request.url, {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
      body,
    });
    this.puts.push(request.url);
  }
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const body = JSON.stringify(value);
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  headers.set('content-length', String(new TextEncoder().encode(body).byteLength));
  return new Response(body, { ...init, headers });
}

function createHarness(
  fetchImplementation: (request: Request) => Promise<Response> | Response,
  cache: MemoryCache | null = new MemoryCache(),
  timeoutOverrides: Pick<ProxyDependencies, 'metadataAuditTimeoutMs' | 'tarballTimeoutMs'> = {},
  packumentMode: 'free' | 'full' = 'free',
  admissionImplementation: (
    candidate: AdmissionCandidate,
  ) => Promise<AdmissionDecision> | AdmissionDecision = () => ({
    allowed: true,
    retryAfterSeconds: 0,
  }),
) {
  const pending: Promise<unknown>[] = [];
  const upstreamFetch = vi.fn(async (request: Request) => fetchImplementation(request));
  const admitOrigin = vi.fn(async (candidate: AdmissionCandidate) =>
    admissionImplementation(candidate),
  );
  const dependencies: ProxyDependencies = {
    fetch: upstreamFetch,
    getCache: () => cache,
    admitOrigin,
    ...timeoutOverrides,
  };

  const handle = (request: Request, publicOrigin = 'https://npm.lemonize.cyou') =>
    handleProxyRequest(
      request,
      dependencies,
      { waitUntil: (promise) => pending.push(promise) },
      true,
      'test-request-id',
      publicOrigin,
      packumentMode,
    );

  return {
    cache,
    upstreamFetch,
    admitOrigin,
    handle,
    async request(
      path: string,
      init: RequestInit = {},
      publicOrigin = 'https://npm.lemonize.cyou',
    ) {
      return handle(new Request(`https://npm.lemonize.cyou${path}`, init), publicOrigin);
    },
    async flush() {
      await Promise.all(pending.splice(0));
    },
  };
}

describe('packument proxying', () => {
  it('strips credentials, rewrites tarballs, preserves hashes, and separates corgi/full cache entries', async () => {
    const seen: Request[] = [];
    const packument = {
      name: '@scope/pkg',
      versions: {
        '1.0.0': {
          dist: {
            tarball: 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz',
            integrity: 'sha512-do-not-change',
            shasum: 'abcdef0123456789',
          },
        },
        '2.0.0': {
          dist: { tarball: 'https://registry.npmjs.org.evil.test/pkg.tgz' },
        },
      },
    };
    const harness = createHarness((request) => {
      seen.push(request);
      return jsonResponse(packument, { headers: { 'set-cookie': 'upstream-secret=1' } });
    });
    const corgiAccept =
      'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*; q=0.1';

    const first = await harness.request('/@scope%2Fpkg', {
      headers: {
        accept: corgiAccept,
        authorization: 'Bearer must-not-leak',
        cookie: 'session=must-not-leak',
      },
    });
    const firstBody = (await first.json()) as typeof packument;
    expect(first.status).toBe(200);
    expect(first.headers.get('x-lemonize-cache')).toBe('MISS');
    expect(first.headers.get('cache-control')).toContain('max-age=300');
    expect(first.headers.get('content-type')).toContain('application/vnd.npm.install-v1+json');
    expect(first.headers.get('vary')).toBe('Accept');
    expect(first.headers.get('etag')).toMatch(/^"sha256-[a-f0-9]{64}"$/);
    expect(first.headers.get('set-cookie')).toBeNull();
    expect(first.headers.get('x-request-id')).toBe('test-request-id');
    expect(firstBody.versions['1.0.0'].dist).toEqual({
      tarball: 'https://npm.lemonize.cyou/@scope/pkg/-/pkg-1.0.0.tgz',
      integrity: 'sha512-do-not-change',
      shasum: 'abcdef0123456789',
    });
    expect(firstBody.versions['2.0.0'].dist.tarball).toBe(
      'https://registry.npmjs.org.evil.test/pkg.tgz',
    );
    expect(seen[0]?.url).toBe('https://registry.npmjs.org/@scope%2Fpkg');
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.headers.get('accept')).toBe('application/vnd.npm.install-v1+json');
    expect(seen[0]?.headers.get('authorization')).toBeNull();
    expect(seen[0]?.headers.get('cookie')).toBeNull();

    await harness.flush();
    const cachedCorgi = await harness.request('/@scope/package'.replace('package', 'pkg'), {
      headers: { accept: corgiAccept },
    });
    expect(cachedCorgi.headers.get('x-lemonize-cache')).toBe('HIT');
    await cachedCorgi.arrayBuffer();
    expect(harness.upstreamFetch).toHaveBeenCalledTimes(1);

    const full = await harness.request('/@scope%2Fpkg', {
      headers: { accept: 'application/json' },
    });
    expect(full.headers.get('x-lemonize-cache')).toBe('MISS');
    expect(full.headers.get('content-type')).toContain('application/json');
    await full.arrayBuffer();
    expect(harness.upstreamFetch).toHaveBeenCalledTimes(2);
    expect(seen[1]?.headers.get('accept')).toBe('application/json');
  });

  it('uses GET internally for HEAD so rewritten headers match the GET representation', async () => {
    const harness = createHarness((request) => {
      expect(request.method).toBe('GET');
      return jsonResponse({
        name: 'pkg',
        versions: {
          '1.0.0': { dist: { tarball: 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz' } },
        },
      });
    });
    const response = await harness.request('/pkg', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toMatch(/^\d+$/);
    expect(response.headers.get('etag')).toMatch(/^"sha256-/);
    expect(await response.text()).toBe('');
    expect(harness.upstreamFetch).toHaveBeenCalledTimes(1);
    await harness.flush();
  });

  it('negative-caches missing packages for 60 seconds', async () => {
    const harness = createHarness(() =>
      jsonResponse({ error: 'Not found' }, { status: 404, headers: { 'set-cookie': 'remove=me' } }),
    );
    const first = await harness.request('/missing-package');
    expect(first.status).toBe(404);
    expect(first.headers.get('cache-control')).toContain('max-age=60');
    expect(first.headers.get('set-cookie')).toBeNull();
    await first.arrayBuffer();
    await harness.flush();

    const second = await harness.request('/missing-package');
    expect(second.status).toBe(404);
    expect(second.headers.get('x-lemonize-cache')).toBe('HIT');
    expect(harness.upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized and invalid upstream packuments', async () => {
    const oversized = createHarness(
      () => new Response('{}', { headers: { 'content-length': String(MAX_PACKUMENT_BYTES + 1) } }),
    );
    const tooLarge = await oversized.request('/huge');
    expect(tooLarge.status).toBe(502);
    expect(await tooLarge.json()).toMatchObject({ code: 'PACKUMENT_TOO_LARGE' });

    const invalid = createHarness(
      () => new Response('{not-json', { headers: { 'content-type': 'application/json' } }),
    );
    const malformed = await invalid.request('/broken');
    expect(malformed.status).toBe(502);
    expect(await malformed.json()).toMatchObject({ code: 'INVALID_PACKUMENT' });
  });

  it('stream-rewrites large packuments on the free tier and fully rewrites them in full mode', async () => {
    const packument = {
      name: 'large',
      description: 'x'.repeat(300_000),
      versions: {
        '1.0.0': {
          dist: { tarball: 'https://registry.npmjs.org/large/-/large-1.0.0.tgz' },
        },
      },
    };
    const createLargeResponse = () => jsonResponse(packument);

    const free = createHarness(createLargeResponse);
    const freeResponse = await free.request('/large');
    expect(freeResponse.headers.get('x-lemonize-packument-mode')).toBe(
      'free-tier-streaming-rewrite',
    );
    expect(freeResponse.headers.get('content-length')).toBeNull();
    expect(freeResponse.headers.get('etag')).toBeNull();
    const freeBody = (await freeResponse.json()) as typeof packument;
    expect(freeBody.versions['1.0.0'].dist.tarball).toBe(
      'https://npm.lemonize.cyou/large/-/large-1.0.0.tgz',
    );
    await free.flush();

    const full = createHarness(createLargeResponse, new MemoryCache(), {}, 'full');
    const fullResponse = await full.request('/large');
    const fullBody = (await fullResponse.json()) as typeof packument;
    expect(fullBody.versions['1.0.0'].dist.tarball).toBe(
      'https://npm.lemonize.cyou/large/-/large-1.0.0.tgz',
    );
    await full.flush();
  });

  it('stream-rewrites an npm tarball URL split across upstream chunks', async () => {
    const packument = {
      name: 'chunked-large',
      description: 'x'.repeat(300_000),
      versions: {
        '1.0.0': {
          dist: {
            tarball: 'https://registry.npmjs.org/chunked-large/-/chunked-large-1.0.0.tgz',
            integrity: 'sha512-preserved',
          },
        },
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(packument));
    const marker = new TextEncoder().encode('registry.npmjs.org');
    const markerStart = bytes.findIndex((_value, index) =>
      marker.every((value, offset) => bytes[index + offset] === value),
    );
    expect(markerStart).toBeGreaterThan(0);
    const split = markerStart + 8;
    const harness = createHarness(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, split));
              controller.enqueue(bytes.slice(split));
              controller.close();
            },
          }),
          {
            headers: {
              'content-length': String(bytes.byteLength),
              'content-type': 'application/json',
            },
          },
        ),
    );

    const response = await harness.request('/chunked-large');
    const body = (await response.json()) as typeof packument;
    expect(response.headers.get('x-lemonize-packument-mode')).toBe('free-tier-streaming-rewrite');
    expect(body.versions['1.0.0'].dist).toEqual({
      tarball: 'https://npm.lemonize.cyou/chunked-large/-/chunked-large-1.0.0.tgz',
      integrity: 'sha512-preserved',
    });
  });

  it('errors when streaming URL rewrites expand beyond the packument byte limit', async () => {
    const upstreamPrefix = 'https://registry.npmjs.org/';
    const publicOrigin = `https://${Array.from({ length: 4 }, () => 'a'.repeat(60)).join('.')}.example`;
    const replacementPrefix = `${publicOrigin}/`;
    const expansionPerMatch = replacementPrefix.length - upstreamPrefix.length;
    const occurrences = Math.ceil((MAX_PACKUMENT_BYTES + 1) / expansionPerMatch);
    const body = JSON.stringify({
      name: 'expanded',
      description: upstreamPrefix.repeat(occurrences),
      versions: {},
    });
    const bodyBytes = new TextEncoder().encode(body);
    expect(bodyBytes.byteLength).toBeLessThan(MAX_PACKUMENT_BYTES);

    const harness = createHarness(
      () =>
        new Response(bodyBytes, {
          headers: {
            'content-length': String(bodyBytes.byteLength),
            'content-type': 'application/json',
          },
        }),
      null,
    );

    const response = await harness.request('/expanded', {}, publicOrigin);
    expect(response.headers.get('x-lemonize-packument-mode')).toBe('free-tier-streaming-rewrite');
    await expect(response.text()).rejects.toThrow(
      'Rewritten response exceeded the streaming size limit.',
    );
  });
});

describe('tarball proxying', () => {
  it('streams full tarballs byte-for-byte and caches immutable 200 responses', async () => {
    const bytes = new Uint8Array([0, 255, 31, 139, 8, 0, 1, 2, 3, 128]);
    const harness = createHarness((request) => {
      expect(request.url).toBe('https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz');
      expect(request.headers.get('authorization')).toBeNull();
      expect(request.headers.get('cookie')).toBeNull();
      return new Response(bytes, {
        headers: {
          'content-length': String(bytes.byteLength),
          'content-type': 'application/octet-stream',
          etag: '"upstream-etag"',
          'set-cookie': 'remove=me',
        },
      });
    });

    const first = await harness.request('/pkg/-/pkg-1.0.0.tgz', {
      headers: { authorization: 'Bearer secret', cookie: 'secret=yes' },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(first.headers.get('x-lemonize-cache')).toBe('MISS');
    expect(first.headers.get('set-cookie')).toBeNull();
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(bytes);
    await harness.flush();

    const second = await harness.request('/pkg/-/pkg-1.0.0.tgz');
    expect(second.headers.get('x-lemonize-cache')).toBe('HIT');
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(bytes);
    expect(harness.upstreamFetch).toHaveBeenCalledTimes(1);

    const head = await harness.request('/pkg/-/pkg-1.0.0.tgz', { method: 'HEAD' });
    expect(head.headers.get('x-lemonize-cache')).toBe('HIT');
    expect(head.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(await head.text()).toBe('');
    expect(harness.upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('always bypasses Cache API for byte ranges', async () => {
    const rangeBytes = new Uint8Array([20, 30]);
    const harness = createHarness((request) => {
      expect(request.headers.get('range')).toBe('bytes=1-2');
      return new Response(rangeBytes, {
        status: 206,
        headers: {
          'content-length': String(rangeBytes.byteLength),
          'content-range': 'bytes 1-2/5',
        },
      });
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await harness.request('/pkg/-/pkg-1.0.0.tgz', {
        headers: { range: 'bytes=1-2' },
      });
      expect(response.status).toBe(206);
      expect(response.headers.get('x-lemonize-cache')).toBe('BYPASS');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(rangeBytes);
    }
    expect(harness.upstreamFetch).toHaveBeenCalledTimes(2);
    expect(harness.cache?.puts).toHaveLength(0);
  });

  it('uses a one-byte probe for an uncached HEAD and returns full-object headers', async () => {
    const harness = createHarness((request) => {
      expect(request.method).toBe('GET');
      expect(request.headers.get('range')).toBe('bytes=0-0');
      return new Response(new Uint8Array([31]), {
        status: 206,
        statusText: 'Partial Content',
        headers: {
          'content-length': '1',
          'content-range': 'bytes 0-0/3730',
          etag: '"tarball-etag"',
        },
      });
    });

    const response = await harness.request('/pkg/-/pkg-1.0.0.tgz', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.statusText).toBe('OK');
    expect(response.headers.get('content-length')).toBe('3730');
    expect(response.headers.get('content-range')).toBeNull();
    expect(response.headers.get('etag')).toBe('"tarball-etag"');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it('enforces declared full and ranged tarball limits', async () => {
    const oversized = createHarness(
      () =>
        new Response(new Uint8Array([1]), {
          headers: { 'content-length': String(MAX_TARBALL_BYTES + 1) },
        }),
    );
    const full = await oversized.request('/pkg/-/pkg.tgz');
    expect(full.status).toBe(502);
    expect(await full.json()).toMatchObject({ code: 'TARBALL_TOO_LARGE' });

    const oversizedRange = createHarness(
      () =>
        new Response(new Uint8Array([1]), {
          status: 206,
          headers: {
            'content-length': '1',
            'content-range': `bytes 0-0/${MAX_TARBALL_BYTES + 1}`,
          },
        }),
    );
    const partial = await oversizedRange.request('/pkg/-/pkg.tgz', {
      headers: { range: 'bytes=0-0' },
    });
    expect(partial.status).toBe(502);
    expect(await partial.json()).toMatchObject({ code: 'TARBALL_TOO_LARGE' });

    const unknownLength = createHarness(() => new Response(new Uint8Array([1])));
    const missingLength = await unknownLength.request('/pkg/-/pkg.tgz');
    expect(missingLength.status).toBe(502);
    expect(await missingLength.json()).toMatchObject({ code: 'UPSTREAM_LENGTH_REQUIRED' });
  });
});

describe('npm utility routes and read-only policy', () => {
  it.each([
    [
      '/-/v1/search?text=vitest&size=20',
      'https://registry.npmjs.org/-/v1/search?text=vitest&size=20&from=0&quality=0.65&popularity=0.98&maintenance=0.5',
      'max-age=300',
    ],
    ['/-/ping?write=true', 'https://registry.npmjs.org/-/ping?write=true', 'no-store'],
  ])('proxies %s without forwarding credentials', async (path, expectedUrl, cacheControl) => {
    const harness = createHarness((request) => {
      expect(request.url).toBe(expectedUrl);
      expect(request.headers.get('authorization')).toBeNull();
      expect(request.headers.get('cookie')).toBeNull();
      return jsonResponse({ ok: true }, { headers: { 'set-cookie': 'remove=me' } });
    });
    const response = await harness.request(path, {
      headers: { authorization: 'Bearer secret', cookie: 'session=secret' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain(cacheControl);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });

  it('canonicalizes supported queries and rejects cache-fragmentation parameters', async () => {
    const harness = createHarness((request) => jsonResponse({ url: request.url }));
    const search = await harness.request('/-/v1/search?size=20&text=vitest&quality=1&from=0');
    expect(await search.json()).toEqual({
      url: 'https://registry.npmjs.org/-/v1/search?text=vitest&size=20&from=0&quality=1&popularity=0.98&maintenance=0.5',
    });

    const fragmented = await harness.request('/pkg?nonce=attacker-controlled');
    expect(fragmented.status).toBe(400);
    expect(await fragmented.json()).toMatchObject({ code: 'INVALID_NPM_PATH' });
    expect(harness.upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['/-/npm/v1/security/advisories/bulk', '/-/npm/v1/security/audits/quick'])(
    'allows bounded POST audit requests at %s',
    async (path) => {
      const payload = new Uint8Array([31, 139, 8, 0, 10, 20, 30]);
      const harness = createHarness(async (request) => {
        expect(request.method).toBe('POST');
        expect(request.url).toBe(`https://registry.npmjs.org${path}`);
        expect(request.headers.get('content-encoding')).toBe('gzip');
        expect(request.headers.get('content-type')).toBe('application/json');
        expect(request.headers.get('authorization')).toBeNull();
        expect(request.headers.get('cookie')).toBeNull();
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(payload);
        return jsonResponse({ advisories: {} }, { headers: { 'set-cookie': 'remove=me' } });
      });

      const response = await harness.request(path, {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          cookie: 'session=secret',
          'content-encoding': 'gzip',
          'content-type': 'application/json',
        },
        body: payload,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('x-lemonize-cache')).toBe('BYPASS');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await response.json()).toEqual({ advisories: {} });
    },
  );

  it('rejects audit payloads larger than 1 MiB without contacting npm', async () => {
    const harness = createHarness(() => jsonResponse({ shouldNot: 'run' }));
    const response = await harness.request('/-/npm/v1/security/audits/quick', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(MAX_AUDIT_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'AUDIT_PAYLOAD_TOO_LARGE' });
    expect(harness.upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/pkg', 'GET, HEAD'],
    ['PUT', '/pkg', 'GET, HEAD'],
    ['PATCH', '/pkg', 'GET, HEAD'],
    ['DELETE', '/pkg/-/pkg.tgz', 'GET, HEAD'],
    ['GET', '/-/npm/v1/security/audits/quick', 'POST'],
  ])('returns 405 for %s %s', async (method, path, allow) => {
    const harness = createHarness(() => jsonResponse({ shouldNot: 'run' }));
    const response = await harness.request(path, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe(allow);
    expect(await response.json()).toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
    expect(harness.upstreamFetch).not.toHaveBeenCalled();
  });

  it('returns stable local errors for unsupported and malformed paths', async () => {
    const harness = createHarness(() => jsonResponse({ shouldNot: 'run' }));
    const unsupported = await harness.request('/-/whoami');
    expect(unsupported.status).toBe(404);
    expect(await unsupported.json()).toMatchObject({ code: 'NOT_FOUND' });

    const invalid = await harness.request('/pkg/-/archive.zip');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'INVALID_NPM_PATH' });
  });

  it('rejects redirects outside the hardcoded npm origin', async () => {
    const harness = createHarness(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example/package' },
        }),
    );
    const response = await harness.request('/pkg');
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'UNSAFE_UPSTREAM_REDIRECT' });
  });

  it('continues safely with an explicit BYPASS when Cache API is unavailable', async () => {
    const harness = createHarness(() => jsonResponse({ name: 'pkg', versions: {} }), null);
    const response = await harness.request('/pkg');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-lemonize-cache')).toBe('BYPASS');
  });
});

describe('operational fail-safes', () => {
  it('fails closed unless NPM_PROXY_ENABLED is exactly true', async () => {
    const upstreamFetch = vi.fn(async () => jsonResponse({ name: 'pkg', versions: {} }));
    const app = createApp({
      fetch: upstreamFetch,
      getCache: () => null,
      admitOrigin: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    });
    const pending: Promise<unknown>[] = [];
    const executionContext = {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;

    const disabled = await app.fetch(
      new Request('https://npm.lemonize.cyou/pkg'),
      {},
      executionContext,
    );
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toMatchObject({ code: 'PROXY_DISABLED' });
    expect(upstreamFetch).not.toHaveBeenCalled();

    const enabled = await app.fetch(
      new Request('https://npm.lemonize.cyou/pkg'),
      { NPM_PROXY_ENABLED: 'true' },
      executionContext,
    );
    expect(enabled.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['metadata', '/pkg', { metadataAuditTimeoutMs: 5 }],
    ['audit', '/-/npm/v1/security/audits/quick', { metadataAuditTimeoutMs: 5 }],
    ['tarball', '/pkg/-/pkg.tgz', { tarballTimeoutMs: 5 }],
  ])(
    'aborts stalled %s upstream headers at the configured deadline',
    async (_kind, path, timeouts) => {
      let upstreamSignal: AbortSignal | undefined;
      const harness = createHarness(
        (request) => {
          upstreamSignal = request.signal;
          return new Promise<Response>((_resolve, reject) => {
            const onAbort = () => reject(request.signal.reason ?? new Error('aborted'));
            if (request.signal.aborted) onAbort();
            else request.signal.addEventListener('abort', onAbort, { once: true });
          });
        },
        null,
        timeouts,
      );
      const response = await harness.request(path, {
        method: _kind === 'audit' ? 'POST' : 'GET',
        body: _kind === 'audit' ? '{}' : undefined,
        headers: _kind === 'audit' ? { 'content-type': 'application/json' } : undefined,
      });
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
      expect(upstreamSignal?.aborted).toBe(true);
    },
  );

  it('does not couple the upstream header deadline to downstream tarball reading', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const harness = createHarness(
      (request) => {
        upstreamSignal = request.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([42]));
            controller.close();
          },
        });
        return new Response(body, { headers: { 'content-length': '1' } });
      },
      null,
      { tarballTimeoutMs: 5 },
    );

    const response = await harness.request('/pkg/-/pkg.tgz');
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([42]));
    expect(upstreamSignal?.aborted).toBe(false);
  });

  it.each([
    ['packument', '/pkg', 'GET'],
    ['audit', '/-/npm/v1/security/audits/quick', 'POST'],
  ])('returns 504 when a buffered %s body stalls', async (_kind, path, method) => {
    const harness = createHarness(
      () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          headers: { 'content-length': '1', 'content-type': 'application/json' },
        }),
      null,
      { metadataAuditTimeoutMs: 5 },
    );
    const response = await harness.request(path, {
      method,
      body: method === 'POST' ? '{}' : undefined,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
    });
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  });

  it('errors a tarball stream when an active upstream read stalls', async () => {
    const harness = createHarness(
      () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          headers: { 'content-length': '1' },
        }),
      null,
      { tarballTimeoutMs: 5 },
    );
    const response = await harness.request('/pkg/-/pkg.tgz');
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  });
});

describe('origin admission integration', () => {
  it('admits only cache misses and never charges Cache API hits', async () => {
    const harness = createHarness(() => jsonResponse({ name: 'pkg', versions: {} }));

    const miss = await harness.request('/pkg', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    expect(miss.status).toBe(200);
    await miss.arrayBuffer();
    await harness.flush();

    const hit = await harness.request('/pkg', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    expect(hit.status).toBe(200);
    expect(hit.headers.get('x-lemonize-cache')).toBe('HIT');
    await hit.arrayBuffer();

    expect(harness.admitOrigin).toHaveBeenCalledTimes(1);
    expect(harness.upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('does not spend global route capacity when one client is already denied', async () => {
    const upstreamFetch = vi.fn(async () => jsonResponse({ objects: [], total: 0 }));
    const app = createApp({ fetch: upstreamFetch, getCache: () => null });
    const bindings = {
      NPM_ADMISSION_CONTROLLER: env.NPM_ADMISSION_CONTROLLER,
      NPM_PROXY_ENABLED: 'true',
    };
    const execute = (clientIp: string) =>
      app.fetch(
        new Request('https://npm.lemonize.cyou/-/v1/search?text=package', {
          headers: { 'cf-connecting-ip': clientIp },
        }),
        bindings,
        {
          waitUntil: () => undefined,
          passThroughOnException: () => undefined,
          props: {},
        } as unknown as ExecutionContext,
      );

    expect((await execute('2001:db8:1::1')).status).toBe(200);
    const denied = await execute('2001:db8:1::2');
    expect(denied.status).toBe(429);
    expect(await denied.json()).toMatchObject({ code: 'ORIGIN_BUDGET_EXHAUSTED' });
    expect((await execute('2001:db8:2::1')).status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });

  it('rechecks metadata cache after admission before fetching npm', async () => {
    const cache = new MemoryCache();
    let lookups = 0;
    vi.spyOn(cache, 'match').mockImplementation(async () => {
      lookups += 1;
      return lookups === 1
        ? undefined
        : jsonResponse({ name: 'pkg', versions: {} }, { headers: { 'cache-control': 'public' } });
    });
    const harness = createHarness(() => jsonResponse({ shouldNot: 'run' }), cache);

    const response = await harness.request('/pkg');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-lemonize-cache')).toBe('HIT');
    expect(await response.json()).toMatchObject({ name: 'pkg' });
    expect(lookups).toBe(2);
    expect(harness.admitOrigin).toHaveBeenCalledTimes(1);
    expect(harness.upstreamFetch).not.toHaveBeenCalled();
  });

  it('rechecks tarball cache after admission before fetching npm', async () => {
    const bytes = new Uint8Array([31, 139, 8, 0]);
    const cache = new MemoryCache();
    let lookups = 0;
    vi.spyOn(cache, 'match').mockImplementation(async () => {
      lookups += 1;
      return lookups === 1
        ? undefined
        : new Response(bytes, {
            headers: {
              'cache-control': 'public, max-age=31536000, immutable',
              'content-length': String(bytes.byteLength),
            },
          });
    });
    const harness = createHarness(
      () => new Response('should not run', { headers: { 'content-length': '14' } }),
      cache,
    );

    const response = await harness.request('/pkg/-/pkg-1.0.0.tgz');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-lemonize-cache')).toBe('HIT');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(lookups).toBe(2);
    expect(harness.admitOrigin).toHaveBeenCalledTimes(1);
    expect(harness.upstreamFetch).not.toHaveBeenCalled();
  });

  it('maps every supported origin route to its budget class', async () => {
    const harness = createHarness((request) => {
      if (request.url.includes('/-/npm/v1/security/')) return jsonResponse({ advisories: {} });
      if (request.url.endsWith('.tgz')) {
        return new Response(new Uint8Array([31]), { headers: { 'content-length': '1' } });
      }
      return jsonResponse({ name: 'pkg', versions: {} });
    });

    await (await harness.request('/pkg')).arrayBuffer();
    await (await harness.request('/-/v1/search?text=pkg')).arrayBuffer();
    await (await harness.request('/pkg/-/pkg.tgz')).arrayBuffer();
    await (
      await harness.request('/-/npm/v1/security/audits/quick', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).arrayBuffer();

    expect(harness.admitOrigin.mock.calls.map(([candidate]) => candidate.routeClass)).toEqual([
      'metadata',
      'search',
      'tarball',
      'audit',
    ]);
  });

  it('returns 429 before npm fetch when a budget is exhausted', async () => {
    const harness = createHarness(
      () => jsonResponse({ shouldNot: 'run' }),
      new MemoryCache(),
      {},
      'free',
      () => ({
        allowed: false,
        reason: 'global_minute',
        retryAfterSeconds: 17,
      }),
    );

    const response = await harness.request('/pkg');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('17');
    expect(await response.json()).toMatchObject({ code: 'ORIGIN_BUDGET_EXHAUSTED' });
    expect(harness.upstreamFetch).not.toHaveBeenCalled();
  });

  it('rejects audit admission without reading or buffering its request body', async () => {
    const harness = createHarness(
      () => jsonResponse({ shouldNot: 'run' }),
      new MemoryCache(),
      {},
      'free',
      () => ({
        allowed: false,
        reason: 'client_route_minute',
        retryAfterSeconds: 11,
      }),
    );
    const request = new Request('https://npm.lemonize.cyou/-/npm/v1/security/audits/quick', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"unread"}',
    });

    const response = await harness.handle(request);
    expect(response.status).toBe(429);
    expect(request.bodyUsed).toBe(false);
    expect(harness.upstreamFetch).not.toHaveBeenCalled();
  });

  it('fails closed before npm fetch when admission is unavailable', async () => {
    const harness = createHarness(
      () => jsonResponse({ shouldNot: 'run' }),
      new MemoryCache(),
      {},
      'free',
      () => Promise.reject(new Error('durable object unavailable')),
    );

    const response = await harness.request('/pkg');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'ADMISSION_UNAVAILABLE' });
    expect(harness.upstreamFetch).not.toHaveBeenCalled();
  });

  it('fails closed when the Durable Object binding is absent', async () => {
    const upstreamFetch = vi.fn(async () => jsonResponse({ shouldNot: 'run' }));
    const app = createApp({ fetch: upstreamFetch, getCache: () => null });
    const executionContext = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;

    const response = await app.fetch(
      new Request('https://npm.lemonize.cyou/pkg'),
      { NPM_PROXY_ENABLED: 'true' },
      executionContext,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'ADMISSION_UNAVAILABLE' });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});
