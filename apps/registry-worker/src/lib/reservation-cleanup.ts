import { AppwriteQuery } from './appwrite.js';
import type { AppwriteRow, ReservationData } from './appwrite-types.js';
import type { RegistryAppwriteRepository } from './appwrite-repository.js';

const PAGE_SIZE = 100;

/** Reads a stable cursor window before cleanup mutates or deletes any cursor rows. */
export async function listExpiredReservationCandidates(
  repo: RegistryAppwriteRepository,
  before: string,
  maximum: number,
): Promise<Array<AppwriteRow<ReservationData>>> {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) return [];
  const boundedMaximum = Math.min(maximum, 500);
  const candidates: Array<AppwriteRow<ReservationData>> = [];
  const seen = new Set<string>();
  let cursor: string | null = null;

  while (candidates.length < boundedMaximum) {
    const pageSize = Math.min(PAGE_SIZE, boundedMaximum - candidates.length);
    const page = await repo.listExpiredReservations(before, {
      queries: [
        AppwriteQuery.limit(pageSize),
        ...(cursor === null ? [] : [AppwriteQuery.cursorAfter(cursor)]),
      ],
      total: false,
    });
    if (page.rows.length === 0) break;
    const pageRows = page.rows.slice(0, pageSize);
    let added = 0;
    for (const row of pageRows) {
      if (seen.has(row.$id)) continue;
      seen.add(row.$id);
      candidates.push(row);
      added += 1;
    }
    if (added === 0) break;

    const nextCursor = pageRows.at(-1)?.$id;
    if (!nextCursor || nextCursor === cursor || page.rows.length < pageSize) break;
    cursor = nextCursor;
  }

  return candidates;
}
