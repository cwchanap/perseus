import { and, desc, eq, sql } from 'drizzle-orm';
import type { D1AppDb } from './types';
import { playerBookmarks } from './schema';

export const MAX_PLAYER_BOOKMARKS = 200;

export type AddPlayerBookmarkResult = 'added' | 'existing' | 'limit_reached';

/**
 * Adds a bookmark with the capacity check inside the persistence operation:
 * the INSERT only selects a row while the player is under the cap, and the
 * batch (transactional in D1) reads back existence to distinguish
 * 'existing' from 'limit_reached'. Re-adding an existing bookmark succeeds
 * even at the cap.
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
					) < ${MAX_PLAYER_BOOKMARKS}`
				)
		)
		.onConflictDoNothing({ target: [playerBookmarks.playerId, playerBookmarks.familyId] });
	const readBookmark = db
		.select({ familyId: playerBookmarks.familyId })
		.from(playerBookmarks)
		.where(and(eq(playerBookmarks.playerId, playerId), eq(playerBookmarks.familyId, familyId)))
		.limit(1);
	const [insertResult, existing] = await db.batch([insertIfUnderCap, readBookmark]);
	if (insertResult.meta.changes > 0) return 'added';
	return existing.length > 0 ? 'existing' : 'limit_reached';
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
