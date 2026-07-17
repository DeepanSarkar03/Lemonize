import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { DEVICE_APPROVAL_TTL_SECONDS } from '../src/durable-objects/device-approval.js';
import {
  consumeDeviceApproval,
  storeDeviceApproval,
} from '../src/lib/device-approval.js';

function code(label: string): string {
  return `LEMN-${label}-${crypto.randomUUID()}`;
}

describe('durable device approval delivery', () => {
  it('removes a newly minted token when durable delivery fails', async () => {
    const deliveryError = new Error('durable object unavailable');
    const remove = vi.fn().mockResolvedValue(undefined);
    const revoke = vi.fn().mockResolvedValue(undefined);
    const approvals = {
      getByName: vi.fn().mockReturnValue({ fetch: vi.fn().mockRejectedValue(deliveryError) }),
    } as unknown as DurableObjectNamespace;

    await expect(
      storeDeviceApproval({
        approvals,
        repo: { tokens: { delete: remove }, revokeToken: revoke },
        userCode: 'LEMN-1234-5678',
        state: { userCode: 'LEMN-1234-5678', token: 'secret' },
        tokenId: 'token-row',
      }),
    ).rejects.toBe(deliveryError);
    expect(remove).toHaveBeenCalledWith('token-row');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('stores for 120 seconds and atomically returns an approval only once', async () => {
    const userCode = code('ONCE');
    const state = { userCode, token: 'secret' };
    const remove = vi.fn().mockResolvedValue(undefined);

    await storeDeviceApproval({
      approvals: env.DEVICE_APPROVALS,
      repo: { tokens: { delete: remove }, revokeToken: vi.fn() },
      userCode,
      state,
      tokenId: 'token-row-once',
    });

    const stub = env.DEVICE_APPROVALS.getByName(`v1:${userCode}`);
    await runInDurableObject(stub, async (_instance, durableState) => {
      const stored = await durableState.storage.get<{ expiresAt: number }>('approval');
      const alarm = await durableState.storage.getAlarm();
      expect(DEVICE_APPROVAL_TTL_SECONDS).toBe(120);
      expect(stored).toBeDefined();
      expect(stored!.expiresAt - Date.now()).toBeGreaterThan(115_000);
      expect(stored!.expiresAt - Date.now()).toBeLessThanOrEqual(120_000);
      expect(alarm).toBe(stored!.expiresAt);
    });

    const attempts = await Promise.all([
      consumeDeviceApproval<typeof state>(env.DEVICE_APPROVALS, userCode),
      consumeDeviceApproval<typeof state>(env.DEVICE_APPROVALS, userCode),
      consumeDeviceApproval<typeof state>(env.DEVICE_APPROVALS, userCode),
    ]);
    expect(attempts.filter((attempt) => attempt !== null)).toEqual([state]);
    expect(remove).not.toHaveBeenCalled();
  });

  it('does not overwrite an unconsumed approval and removes the duplicate token', async () => {
    const userCode = code('DUPE');
    const first = { userCode, token: 'first-secret' };
    await storeDeviceApproval({
      approvals: env.DEVICE_APPROVALS,
      repo: { tokens: { delete: vi.fn() }, revokeToken: vi.fn() },
      userCode,
      state: first,
      tokenId: 'first-token-row',
    });

    const removeDuplicate = vi.fn().mockResolvedValue(undefined);
    await expect(
      storeDeviceApproval({
        approvals: env.DEVICE_APPROVALS,
        repo: { tokens: { delete: removeDuplicate }, revokeToken: vi.fn() },
        userCode,
        state: { userCode, token: 'second-secret' },
        tokenId: 'second-token-row',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(removeDuplicate).toHaveBeenCalledWith('second-token-row');
    await expect(consumeDeviceApproval(env.DEVICE_APPROVALS, userCode)).resolves.toEqual(first);
  });

  it('removes the unreachable token row when an approval expires', async () => {
    const userCode = code('EXPIRE');
    const stub = env.DEVICE_APPROVALS.getByName(`v1:${userCode}`);
    const appwriteFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', appwriteFetch);
    try {
      await runInDurableObject(stub, async (_instance, durableState) => {
        const expiresAt = Date.now() - 1;
        await durableState.storage.put('approval', {
          expiresAt,
          tokenId: 'expired-token-row',
          userCode,
          state: { userCode, token: 'unreachable-secret' },
        });
        // Keep the test runner from firing a past alarm before the explicit
        // assertion below; the stored record itself is already expired.
        await durableState.storage.setAlarm(Date.now() + 60_000);
      });

      await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
      expect(appwriteFetch).toHaveBeenCalledTimes(1);
      expect(appwriteFetch.mock.calls[0]?.[0]).toContain('/tables/api_tokens/rows/expired-token-row');
      await runInDurableObject(stub, async (_instance, durableState) => {
        await expect(durableState.storage.get('approval')).resolves.toBeUndefined();
        await expect(durableState.storage.getAlarm()).resolves.toBeNull();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('purges the raw token at expiry even while Appwrite cleanup is retrying', async () => {
    const userCode = code('RETRY');
    const stub = env.DEVICE_APPROVALS.getByName(`v1:${userCode}`);
    const appwriteFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ type: 'service_unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', appwriteFetch);
    try {
      await runInDurableObject(stub, async (_instance, durableState) => {
        await durableState.storage.put('approval', {
          expiresAt: Date.now() - 1,
          tokenId: 'retry-token-row',
          userCode,
          state: { userCode, token: 'must-not-persist' },
        });
      });

      await expect(consumeDeviceApproval(env.DEVICE_APPROVALS, userCode)).resolves.toBeNull();
      expect(appwriteFetch).toHaveBeenCalledTimes(2);
      await runInDurableObject(stub, async (_instance, durableState) => {
        const stored = await durableState.storage.get<Record<string, unknown>>('approval');
        expect(stored).toEqual({
          cleanupOnly: true,
          expiresAt: expect.any(Number),
          tokenId: 'retry-token-row',
          userCode,
        });
        expect(stored).not.toHaveProperty('state');
        expect(await durableState.storage.getAlarm()).not.toBeNull();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
