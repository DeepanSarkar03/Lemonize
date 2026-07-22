import { describe, expect, it, vi } from 'vitest';

import {
  activeApiTokenRoot,
  apiTokenCanManageTarget,
  createApiToken,
  revokeApiTokenLineage,
} from '../src/lib/api-token.js';
import { filterActiveTokenRows } from '../src/routes/tokens.js';
import type { RegistryAppwriteRepository } from '../src/lib/appwrite-repository.js';
import type { ApiTokenData, RegistryRow } from '../src/lib/appwrite-types.js';

const NOW = Date.parse('2026-07-23T12:00:00.000Z');

function tokenRow(
  id: string,
  overrides: Partial<ApiTokenData> = {},
): RegistryRow<'api_tokens'> {
  return {
    $id: id,
    $sequence: 1,
    $databaseId: 'registry',
    $tableId: 'api_tokens',
    $createdAt: '2026-07-23T00:00:00.000Z',
    $updatedAt: '2026-07-23T00:00:00.000Z',
    $permissions: [],
    userId: 'user-1',
    parentTokenId: null,
    rootTokenId: id,
    tokenHash: `hash-${id}`,
    prefix: `lem_${id}`,
    label: id,
    scopes: 'read,publish,manage:packages,manage:tokens',
    expiresAt: '2026-08-23T12:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function fakeRepository(initialRows: RegistryRow<'api_tokens'>[] = []) {
  const rows = new Map(initialRows.map((row) => [row.$id, row]));
  const create = vi.fn(async (data: ApiTokenData, rowId: string) => {
    const row = tokenRow(rowId, data);
    rows.set(rowId, row);
    return row;
  });
  const getOrNull = vi.fn(async (rowId: string) => rows.get(rowId) ?? null);
  const listTokensByUser = vi.fn(
    async (userId: string, options: { activeOnly?: boolean } = {}) => {
      const matching = [...rows.values()].filter(
        (row) => row.userId === userId && (!options.activeOnly || !row.revokedAt),
      );
      return { total: matching.length, rows: matching };
    },
  );
  const listTokensByRoot = vi.fn(
    async (
      userId: string,
      rootTokenId: string,
      options: { activeOnly?: boolean } = {},
    ) => {
      const matching = [...rows.values()].filter(
        (row) =>
          row.userId === userId &&
          row.rootTokenId === rootTokenId &&
          (!options.activeOnly || !row.revokedAt),
      );
      return { total: matching.length, rows: matching };
    },
  );
  const revokeToken = vi.fn(async (rowId: string, revokedAt: string) => {
    const current = rows.get(rowId);
    if (!current) throw new Error(`Missing token ${rowId}`);
    const revoked = { ...current, revokedAt };
    rows.set(rowId, revoked);
    return revoked;
  });
  const repo = {
    tokens: { create, getOrNull },
    listTokensByUser,
    listTokensByRoot,
    revokeToken,
  } as unknown as RegistryAppwriteRepository;
  return { repo, rows, create, getOrNull, listTokensByRoot, revokeToken };
}

describe('API token delegation security', () => {
  it('omits expired rows from token listings even when Appwrite reports them active', () => {
    const active = tokenRow('active', { expiresAt: '2026-07-24T12:00:00.000Z' });
    const expired = tokenRow('expired', { expiresAt: '2026-07-23T12:00:00.000Z' });
    const malformed = tokenRow('malformed', { expiresAt: 'not-a-date' });
    const revoked = tokenRow('revoked', {
      expiresAt: '2026-07-24T12:00:00.000Z',
      revokedAt: '2026-07-23T11:00:00.000Z',
    });

    expect(filterActiveTokenRows([active, expired, malformed, revoked], NOW)).toEqual([active]);
  });

  it('links API-created credentials to their root and caps scopes and expiry', async () => {
    const parentExpiry = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const { repo, create } = fakeRepository();

    const created = await createApiToken(repo, {
      userId: 'user-1',
      label: 'CI publish',
      scopes: ['read', 'publish'],
      expiresInDays: 90,
      parent: {
        tokenId: 'root-a',
        rootTokenId: 'root-a',
        userId: 'user-1',
        scopes: ['read', 'publish', 'manage:tokens'],
        expiresAt: parentExpiry,
      },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTokenId: 'root-a',
        rootTokenId: 'root-a',
        scopes: 'read,publish',
        expiresAt: parentExpiry,
      }),
      expect.any(String),
    );
    expect(created.row.expiresAt).toBe(parentExpiry);
  });

  it('prevents a delegated credential from receiving token management or parentless scopes', async () => {
    const parent = {
      tokenId: 'root-a',
      rootTokenId: 'root-a',
      userId: 'user-1',
      scopes: ['read', 'manage:tokens'] as const,
      expiresAt: '2026-08-23T12:00:00.000Z',
    };
    const { repo } = fakeRepository();

    await expect(
      createApiToken(repo, {
        userId: 'user-1',
        label: 'manager',
        scopes: ['manage:tokens'],
        parent,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await expect(
      createApiToken(repo, {
        userId: 'user-1',
        label: 'publisher',
        scopes: ['publish'],
        parent,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('invalidates a child when its root is revoked and rejects widened child bounds', async () => {
    const root = tokenRow('root-a', {
      scopes: 'read,publish,manage:tokens',
      expiresAt: '2026-07-30T12:00:00.000Z',
    });
    const child = tokenRow('child-a', {
      parentTokenId: 'root-a',
      rootTokenId: 'root-a',
      scopes: 'read,publish',
      expiresAt: '2026-07-29T12:00:00.000Z',
    });
    const active = fakeRepository([root]);
    await expect(activeApiTokenRoot(active.repo, child, NOW)).resolves.toBe('root-a');

    const revoked = fakeRepository([
      { ...root, revokedAt: '2026-07-23T11:00:00.000Z' },
    ]);
    await expect(activeApiTokenRoot(revoked.repo, child, NOW)).resolves.toBeNull();
    await expect(activeApiTokenRoot(fakeRepository().repo, child, NOW)).resolves.toBeNull();
    await expect(
      activeApiTokenRoot(
        active.repo,
        { ...child, scopes: 'read,manage:packages' },
        NOW,
      ),
    ).resolves.toBeNull();
    await expect(
      activeApiTokenRoot(active.repo, { ...child, scopes: 'read,manage:tokens' }, NOW),
    ).resolves.toBeNull();
    await expect(
      activeApiTokenRoot(
        active.repo,
        { ...child, expiresAt: '2026-07-31T12:00:00.000Z' },
        NOW,
      ),
    ).resolves.toBeNull();
  });

  it('cascades root revocation to direct children without touching a sibling root', async () => {
    const rootA = tokenRow('root-a');
    const childA1 = tokenRow('child-a-1', {
      parentTokenId: 'root-a',
      rootTokenId: 'root-a',
      scopes: 'read',
    });
    const childA2 = tokenRow('child-a-2', {
      parentTokenId: 'root-a',
      rootTokenId: 'root-a',
      scopes: 'publish',
    });
    const rootB = tokenRow('root-b');
    const { repo, revokeToken } = fakeRepository([rootA, childA1, childA2, rootB]);

    await revokeApiTokenLineage(repo, rootA, '2026-07-23T12:00:00.000Z');

    expect(revokeToken.mock.calls.map(([rowId]) => rowId).sort()).toEqual([
      'child-a-1',
      'child-a-2',
      'root-a',
    ]);
  });

  it('revokes the root before a descendant lookup failure can interrupt logout', async () => {
    const root = tokenRow('root-a');
    const { repo, listTokensByRoot, revokeToken } = fakeRepository([root]);
    listTokensByRoot.mockRejectedValueOnce(new Error('lineage lookup unavailable'));

    await expect(revokeApiTokenLineage(repo, root)).rejects.toThrow(
      'lineage lookup unavailable',
    );
    expect(revokeToken).toHaveBeenCalledWith('root-a', expect.any(String));
  });

  it('allows a root to manage only itself and its own direct descendants', () => {
    const rootA = tokenRow('root-a');
    const childA = tokenRow('child-a', {
      parentTokenId: 'root-a',
      rootTokenId: 'root-a',
      scopes: 'read',
    });
    const rootB = tokenRow('root-b');
    const childB = tokenRow('child-b', {
      parentTokenId: 'root-b',
      rootTokenId: 'root-b',
      scopes: 'read',
    });
    const canManage = (target: RegistryRow<'api_tokens'>) =>
      apiTokenCanManageTarget({
        callerTokenId: 'root-a',
        callerRootTokenId: 'root-a',
        callerUserId: 'user-1',
        target,
      });

    expect(canManage(rootA)).toBe(true);
    expect(canManage(childA)).toBe(true);
    expect(canManage(rootB)).toBe(false);
    expect(canManage(childB)).toBe(false);
    expect(canManage({ ...childA, userId: 'user-2' })).toBe(false);
  });

  it('revokes a child without revoking its root or sibling', async () => {
    const root = tokenRow('root-a');
    const child = tokenRow('child-a', {
      parentTokenId: 'root-a',
      rootTokenId: 'root-a',
      scopes: 'read',
    });
    const sibling = tokenRow('child-a-sibling', {
      parentTokenId: 'root-a',
      rootTokenId: 'root-a',
      scopes: 'publish',
    });
    const { repo, revokeToken } = fakeRepository([root, child, sibling]);

    await revokeApiTokenLineage(repo, child, '2026-07-23T12:00:00.000Z');

    expect(revokeToken).toHaveBeenCalledTimes(1);
    expect(revokeToken).toHaveBeenCalledWith(
      'child-a',
      '2026-07-23T12:00:00.000Z',
    );
  });
});
