import { and, desc, eq, sql } from 'drizzle-orm';
import type { D1AppDb } from './types';
import { playerBookmarks, puzzleFamilies } from './schema';

export const MAX_PLAYER_BOOKMARKS = 200;

export type AddPlayerBookmarkResult = 'added' | 'existing' | 'limit_reached' | 'family_missing';

/**
 * Adds a bookmark with the capacity check and family-deletion fence inside the
 * persistence operation: the INSERT only selects a row while the player is
 * under the cap AND a puzzle_families row still exists for the family. The
 * ownership row is the durable D1 marker of a live family — family deletion
 * removes it before deleting bookmark rows, so an insert that lands after the
 * deletion fence cannot resurrect a bookmark the cleanup already swept (the
 * route's KV readiness check alone can be raced by stale KV). The batch
 * (transactional in D1) reads back bookmark and family existence to
 * distinguish 'existing' from 'limit_reached' from 'family_missing'.
 * Re-adding an existing bookmark succeeds even at the cap.
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
					AND EXISTS (SELECT 1 FROM puzzle_families WHERE id = ${familyId})`
				)
		)
		.onConflictDoNothing({ target: [playerBookmarks.playerId, playerBookmarks.familyId] });
	const readBookmark = db
		.select({ familyId: playerBookmarks.familyId })
		.from(playerBookmarks)
		.where(and(eq(playerBookmarks.playerId, playerId), eq(playerBookmarks.familyId, familyId)))
		.limit(1);
	const readFamily = db
		.select({ id: puzzleFamilies.id })
		.from(puzzleFamilies)
		.where(eq(puzzleFamilies.id, familyId))
		.limit(1);
	const [insertResult, existing, familyRows] = await db.batch([
		insertIfUnderCap,
		readBookmark,
		readFamily
	]);
	if (insertResult.meta.changes > 0) return 'added';
	if (existing.length > 0) return 'existing';
	return familyRows.length === 0 ? 'family_missing' : 'limit_reached';
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

/**
 * Removes every bookmark row pointing at a family. Called from the fenced
 * family-deletion path so a deleted family cannot leave orphaned rows that
 * invisibly count toward the per-player cap.
 */
export async function deletePlayerBookmarksByFamily(db: D1AppDb, familyId: string): Promise<void> {
	await db.delete(playerBookmarks).where(eq(playerBookmarks.familyId, familyId)).run();
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
