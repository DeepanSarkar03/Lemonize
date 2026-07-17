import { DurableObject } from 'cloudflare:workers';

import { AppwriteError } from '../lib/appwrite.js';
import type { Env } from '../lib/env.js';
import { registryRepository } from '../lib/registry.js';

const APPROVAL_KEY = 'approval';
export const DEVICE_APPROVAL_TTL_SECONDS = 120;

interface StoredApproval {
  cleanupOnly?: false;
  expiresAt: number;
  tokenId: string;
  userCode: string;
  state: unknown;
}

interface CleanupRecord {
  cleanupOnly: true;
  expiresAt: number;
  tokenId: string;
  userCode: string;
}

type DeviceRecord = StoredApproval | CleanupRecord;

interface PutApprovalBody {
  tokenId: string;
  userCode: string;
  state: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function isPutApprovalBody(value: unknown): value is PutApprovalBody {
  if (!value || typeof value !== 'object') return false;
  const body = value as Partial<PutApprovalBody>;
  if (
    typeof body.tokenId !== 'string' ||
    body.tokenId.length === 0 ||
    typeof body.userCode !== 'string' ||
    body.userCode.length === 0 ||
    !body.state ||
    typeof body.state !== 'object'
  ) {
    return false;
  }
  return (body.state as { userCode?: unknown }).userCode === body.userCode;
}

function isDeviceRecord(value: unknown): value is DeviceRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<DeviceRecord> & { state?: unknown };
  if (
    !Number.isFinite(record.expiresAt) ||
    typeof record.tokenId !== 'string' ||
    typeof record.userCode !== 'string'
  ) {
    return false;
  }
  if (record.cleanupOnly === true) return record.state === undefined;
  return !!record.state && typeof record.state === 'object';
}

function isStoredApproval(value: unknown): value is StoredApproval {
  return isDeviceRecord(value) && value.cleanupOnly !== true;
}

/**
 * Single-use device approvals live in one object per human code. Durable
 * Object serialization plus a storage transaction makes consume exactly-once
 * across Worker isolates and regions.
 */
export class DeviceApprovalObject extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/approval' && request.method === 'PUT') return this.put(request);
    if (path === '/approval/consume' && request.method === 'POST') return this.consume();
    return json({ error: 'Not found' }, 404);
  }

  override async alarm(): Promise<void> {
    const stored = await this.ctx.storage.get<unknown>(APPROVAL_KEY);
    if (!isDeviceRecord(stored)) return this.clearInvalidRecord();
    if (isStoredApproval(stored) && stored.expiresAt > Date.now()) {
      await this.ctx.storage.setAlarm(stored.expiresAt);
      return;
    }
    const cleanup = await this.markForCleanup(stored);
    if (cleanup) await this.removeExpiredApproval(cleanup);
  }

  private async put(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    if (!isPutApprovalBody(body)) return json({ error: 'Invalid approval state' }, 400);

    const expiresAt = Date.now() + DEVICE_APPROVAL_TTL_SECONDS * 1_000;
    const stored = await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<unknown>(APPROVAL_KEY);
      // Never overwrite a stored secret. On a duplicate browser submission,
      // the newly minted token is removed by the caller and the original CLI
      // can still consume its approval.
      if (isDeviceRecord(current)) {
        if (current.expiresAt <= Date.now()) await txn.setAlarm(Date.now());
        return false;
      }
      await txn.put<StoredApproval>(APPROVAL_KEY, {
        expiresAt,
        tokenId: body.tokenId,
        userCode: body.userCode,
        state: body.state,
      });
      await txn.setAlarm(expiresAt);
      return true;
    });

    return stored
      ? json({ stored: true, expiresAt }, 201)
      : json({ error: 'Device code is already approved' }, 409);
  }

  private async consume(): Promise<Response> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<unknown>(APPROVAL_KEY);
      if (!isDeviceRecord(stored)) {
        await txn.delete(APPROVAL_KEY);
        await txn.deleteAlarm();
        return { kind: 'missing' as const };
      }
      if (stored.cleanupOnly === true || stored.expiresAt <= Date.now()) {
        const cleanup: CleanupRecord = {
          cleanupOnly: true,
          expiresAt: stored.expiresAt,
          tokenId: stored.tokenId,
          userCode: stored.userCode,
        };
        // Purge the raw token at the TTL boundary even if Appwrite is
        // temporarily unavailable; only the row id remains for cleanup retry.
        await txn.put<CleanupRecord>(APPROVAL_KEY, cleanup);
        await txn.setAlarm(Date.now() + 60_000);
        return { kind: 'expired' as const, stored: cleanup };
      }
      await txn.delete(APPROVAL_KEY);
      await txn.deleteAlarm();
      return { kind: 'approved' as const, state: stored.state };
    });

    if (result.kind === 'expired') await this.removeExpiredApproval(result.stored);
    return result.kind === 'approved'
      ? json({ status: 'approved', state: result.state })
      : json({ status: 'pending' }, 404);
  }

  private async clearInvalidRecord(): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      await txn.delete(APPROVAL_KEY);
      await txn.deleteAlarm();
    });
  }

  private async markForCleanup(expected: DeviceRecord): Promise<CleanupRecord | null> {
    return this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<unknown>(APPROVAL_KEY);
      if (
        !isDeviceRecord(current) ||
        current.tokenId !== expected.tokenId ||
        (isStoredApproval(current) && current.expiresAt > Date.now())
      ) {
        return null;
      }
      const cleanup: CleanupRecord = {
        cleanupOnly: true,
        expiresAt: current.expiresAt,
        tokenId: current.tokenId,
        userCode: current.userCode,
      };
      await txn.put<CleanupRecord>(APPROVAL_KEY, cleanup);
      await txn.setAlarm(Date.now() + 60_000);
      return cleanup;
    });
  }

  private async removeExpiredApproval(stored: CleanupRecord): Promise<void> {
    try {
      await this.deleteOrRevokeToken(stored.tokenId);
    } catch {
      // Preserve the token id (but never beyond this object) and retry cleanup;
      // deleting the approval first could permanently consume an account's
      // active-token quota with an unreachable credential.
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      // The credential secret is already gone and the token row stores only a
      // hash. A scheduled retry is safer and quieter than failing the expired
      // poll or relying solely on the platform's alarm backoff.
      return;
    }
    await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<unknown>(APPROVAL_KEY);
      if (
        isDeviceRecord(current) &&
        current.cleanupOnly === true &&
        current.tokenId === stored.tokenId &&
        current.expiresAt <= Date.now()
      ) {
        await txn.delete(APPROVAL_KEY);
        await txn.deleteAlarm();
      } else if (isDeviceRecord(current)) {
        await txn.setAlarm(current.expiresAt);
      } else {
        await txn.delete(APPROVAL_KEY);
        await txn.deleteAlarm();
      }
    });
  }

  private async deleteOrRevokeToken(tokenId: string): Promise<void> {
    const repo = registryRepository(this.env);
    try {
      await repo.tokens.delete(tokenId);
      return;
    } catch (deleteError) {
      if (deleteError instanceof AppwriteError && deleteError.status === 404) return;
    }
    try {
      await repo.revokeToken(tokenId);
    } catch (revokeError) {
      if (revokeError instanceof AppwriteError && revokeError.status === 404) return;
      throw revokeError;
    }
  }
}
