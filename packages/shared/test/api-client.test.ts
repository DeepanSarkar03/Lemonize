import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, LemonizeClient } from '../src/api-client.js';

describe('LemonizeClient protocol details', () => {
  it('normalizes trailing slashes in linear time for adversarial registry input', async () => {
    const repeatedSlashes = '/'.repeat(100_000);
    const registry = `https://registry.example.test/${repeatedSlashes}suffix///`;
    const fetchMock = vi.fn(async (_input: Request | string | URL) => new Response('{}'));
    const client = new LemonizeClient({
      registry,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.limits();

    const request = fetchMock.mock.calls[0]?.[0];
    expect(request).toBe(`${registry.slice(0, -3)}/v1/limits`);
  });

  it('sends caller-generated publish idempotency keys', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            packageId: 'pkg',
            version: '1.0.0',
            uploadUrl: 'https://registry.example.test/upload',
            uploadToken: 'secret',
            method: 'PUT',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
          { status: 201 },
        ),
    );
    const client = new LemonizeClient({
      registry: 'https://registry.example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await client.createPublishIntent(
      '@demo/pkg',
      {
        manifest: { name: '@demo/pkg', version: '1.0.0' },
        integrity: `sha512-${'A'.repeat(88)}`,
        shasum: 'a'.repeat(64),
        tarballSize: 1,
        unpackedSize: 1,
        fileCount: 1,
      },
      { idempotencyKey: '8a80a6f4-8ab4-48f4-a216-a23679a62a4b' },
    );
    const calls = fetchMock.mock.calls as unknown as Array<
      [Parameters<typeof fetch>[0], RequestInit | undefined]
    >;
    const headers = new Headers(calls[0]?.[1]?.headers);
    expect(headers.get('idempotency-key')).toBe('8a80a6f4-8ab4-48f4-a216-a23679a62a4b');
  });

  it('exposes request IDs from registry errors', async () => {
    const client = new LemonizeClient({
      registry: 'https://registry.example.test',
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'BAD_REQUEST', message: 'bad input', requestId: 'req-123' },
            }),
            { status: 400 },
          ),
      ) as unknown as typeof fetch,
    });
    let error: unknown;
    try {
      await client.limits();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApiClientError);
    if (!(error instanceof ApiClientError)) throw new Error('Expected ApiClientError');
    expect(error.requestId).toBe('req-123');
  });
});
