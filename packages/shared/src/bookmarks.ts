import { and, desc, eq, sql } from 'drizzle-orm';
import type { D1AppDb } from './types';
import { familyDeletionTombstones, playerBookmarks } from './schema';

export const MAX_PLAYER_BOOKMARKS = 200;

export type AddPlayerBookmarkResult = 'added' | 'existing' | 'limit_reached' | 'family_missing';

/**
 * Adds a bookmark with the capacity check and family-deletion fence inside the
 * persistence operation: the INSERT only selects a row while the player is
 * under the cap AND no family_deletion_tombstones row exists for the family.
 * The tombstone — not the puzzle_families ownership row — is the fence:
 * ownership is a best-effort mirror on some publish paths, so its absence
 * cannot distinguish "family deleted" from "mirror write failed", while the
 * tombstone is written atomically with the bookmark sweep in the deletion
 * cleanup. An insert that lands after the tombstone therefore cannot
 * resurrect a bookmark the cleanup already swept (the route's KV readiness
 * check alone can be raced by stale KV). The batch (transactional in D1)
 * reads back bookmark and tombstone existence to distinguish 'existing' from
 * 'limit_reached' from 'family_missing'. Re-adding an existing bookmark
 * succeeds even at the cap.
 */
export async function addPlayerBookmark(
	db: D1AppDb,
	playerId: string,
	familyId: string,
	createdAt = Date.now()
): Promise<AddPlayerBookmarkResult> {
	const insertIfUnderCap = db
		.insert(playerBookmarks)
		.select(
			db
				.select({
					playerId: sql<string>`${playerId}`.as('player_id'),
					familyId: sql<string>`${familyId}`.as('family_id'),
					createdAt: sql<number>`${createdAt}`.as('created_at')
				})
				.from(sql`(SELECT 1)`)
				.where(
					sql`(
						SELECT COUNT(*) FROM player_bookmarks WHERE player_id = ${playerId}
					) < ${MAX_PLAYER_BOOKMARKS}
					AND NOT EXISTS (
						SELECT 1 FROM family_deletion_tombstones WHERE family_id = ${familyId}
					)`
				)
		)
		.onConflictDoNothing({ target: [playerBookmarks.playerId, playerBookmarks.familyId] });
	const readBookmark = db
		.select({ familyId: playerBookmarks.familyId })
		.from(playerBookmarks)
		.where(and(eq(playerBookmarks.playerId, playerId), eq(playerBookmarks.familyId, familyId)))
		.limit(1);
	const readTombstone = db
		.select({ familyId: familyDeletionTombstones.familyId })
		.from(familyDeletionTombstones)
		.where(eq(familyDeletionTombstones.familyId, familyId))
		.limit(1);
	const [insertResult, existing, tombstoneRows] = await db.batch([
		insertIfUnderCap,
		readBookmark,
		readTombstone
	]);
	if (insertResult.meta.changes > 0) return 'added';
	if (existing.length > 0) return 'existing';
	return tombstoneRows.length > 0 ? 'family_missing' : 'limit_reached';
}

export async function removePlayerBookmark(
	db: D1AppDb,
	playerId: string,
	familyId: string
): Promise<void> {
	await db
		.delete(playerBookmarks)
		.where(and(eq(playerBookmarks.playerId, playerId), eq(playerBookmarks.familyId, familyId)))
		.run();
}

export async function listPlayerBookmarks(
	db: D1AppDb,
	playerId: string
): Promise<Array<{ familyId: string; createdAt: number }>> {
	return (
		db
			.select({ familyId: playerBookmarks.familyId, createdAt: playerBookmarks.createdAt })
			.from(playerBookmarks)
			.where(eq(playerBookmarks.playerId, playerId))
			// familyId tiebreak keeps same-millisecond bookmarks deterministic.
			.orderBy(desc(playerBookmarks.createdAt), desc(playerBookmarks.familyId))
			.limit(MAX_PLAYER_BOOKMARKS)
	);
}
