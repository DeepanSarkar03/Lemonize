import { describe, expect, it, vi } from 'vitest';
import type { AppwriteRow, ReservationData } from '../src/lib/appwrite-types.js';
import type { RegistryAppwriteRepository } from '../src/lib/appwrite-repository.js';
import { listExpiredReservationCandidates } from '../src/lib/reservation-cleanup.js';

function reservation(index: number): AppwriteRow<ReservationData> {
  const timestamp = '2026-07-17T00:00:00.000Z';
  return {
    packageId: 'package-1',
    version: `1.0.${index}`,
    userId: 'user-1',
    idempotencyKey: `idempotency-${index}`,
    uploadTokenHash: String(index).padStart(64, '0').slice(-64),
    stagingKey: `staging/reservation-${index}/artifact.tgz`,
    status: index < 100 ? 'failed' : 'completed',
    expiresAt: timestamp,
    $id: `reservation-${index}`,
    $sequence: index,
    $databaseId: 'registry',
    $tableId: 'reservations',
    $createdAt: timestamp,
    $updatedAt: timestamp,
    $permissions: [],
  };
}

describe('reservation cleanup pagination', () => {
  it('reads beyond an ineligible first page with an Appwrite cursor', async () => {
    const first = Array.from({ length: 100 }, (_, index) => reservation(index));
    const second = Array.from({ length: 20 }, (_, index) => reservation(index + 100));
    const listExpiredReservations = vi
      .fn()
      .mockResolvedValueOnce({ total: 120, rows: first })
      .mockResolvedValueOnce({ total: 120, rows: second });
    const repo = { listExpiredReservations } as unknown as RegistryAppwriteRepository;

    const candidates = await listExpiredReservationCandidates(
      repo,
      '2026-07-18T00:00:00.000Z',
      120,
    );

    expect(candidates).toHaveLength(120);
    expect(candidates.at(-1)?.status).toBe('completed');
    expect(listExpiredReservations).toHaveBeenCalledTimes(2);
    const secondOptions = listExpiredReservations.mock.calls[1]?.[1] as {
      queries: string[];
    };
    expect(secondOptions.queries).toContain(
      '{"method":"cursorAfter","values":["reservation-99"]}',
    );
  });
});
