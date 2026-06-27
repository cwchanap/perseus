import { eq, lt, desc, count, sql, and } from 'drizzle-orm';
import type { AppDb, NewPuzzleRow, PlayerProfileRow } from './types';
import { puzzles, playerProfiles, puzzleStats } from './schema';

export async function getProfileOverride(
	db: AppDb,
	playerId: string
): Promise<PlayerProfileRow | null> {
	const rows = await db
		.select()
		.from(playerProfiles)
		.where(eq(playerProfiles.playerId, playerId))
		.limit(1)
		.all();
	return rows[0] ?? null;
}

export async function upsertProfileOverride(
	db: AppDb,
	playerId: string,
	values: { displayName: string | null; avatarUrl: string | null }
): Promise<void> {
	const now = Date.now();
	await db
		.insert(playerProfiles)
		.values({
			playerId,
			displayName: values.displayName,
			avatarUrl: values.avatarUrl,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: playerProfiles.playerId,
			set: {
				displayName: values.displayName,
				avatarUrl: values.avatarUrl,
				updatedAt: now
			}
		})
		.run();
}

export async function insertPuzzleOwnership(db: AppDb, row: NewPuzzleRow): Promise<void> {
	await db.insert(puzzles).values(row).run();
}

export async function setPuzzleStatus(db: AppDb, id: string, status: string): Promise<void> {
	await db.update(puzzles).set({ status }).where(eq(puzzles.id, id)).run();
}

export async function listPlayerPuzzles(
	db: AppDb,
	playerId: string,
	opts: { limit: number; cursor?: number }
): Promise<{ rows: (typeof puzzles.$inferSelect)[]; nextCursor?: number }> {
	const limit = Math.min(Math.max(opts.limit, 1), 100);
	// Combine the player filter and the cursor into a single WHERE clause.
	// drizzle's `.where()` replaces (not merges) the previous condition, so
	// chaining a second `.where()` for the cursor would silently drop the
	// ownerId filter and leak other players' puzzles across pages.
	const cond =
		opts.cursor !== undefined
			? and(eq(puzzles.ownerId, playerId), lt(puzzles.createdAt, opts.cursor))
			: eq(puzzles.ownerId, playerId);
	const all = await db
		.select()
		.from(puzzles)
		.where(cond)
		.orderBy(desc(puzzles.createdAt))
		.limit(limit + 1)
		.all();
	const rows = all.slice(0, limit);
	const nextCursor = all.length > limit ? rows[rows.length - 1].createdAt : undefined;
	return { rows, nextCursor };
}

export async function countPlayerPuzzles(db: AppDb, playerId: string): Promise<number> {
	const rows = await db
		.select({ n: count() })
		.from(puzzles)
		.where(eq(puzzles.ownerId, playerId))
		.all();
	return rows[0]?.n ?? 0;
}

export async function recordCompletion(
	db: AppDb,
	playerId: string,
	puzzleId: string,
	timeSeconds: number
): Promise<void> {
	const now = Date.now();
	await db
		.insert(puzzleStats)
		.values({
			playerId,
			puzzleId,
			bestTimeSeconds: timeSeconds,
			totalCompletions: 1,
			firstCompletedAt: now,
			lastCompletedAt: now
		})
		.onConflictDoUpdate({
			target: [puzzleStats.playerId, puzzleStats.puzzleId],
			set: {
				// MIN of stored vs incoming (excluded) best time; `excluded` is SQLite's
				// name for the conflicting incoming row.
				bestTimeSeconds: sql`MIN(${puzzleStats.bestTimeSeconds}, excluded.best_time_seconds)`,
				totalCompletions: sql`${puzzleStats.totalCompletions} + 1`,
				lastCompletedAt: now
			}
		})
		.run();
}

export async function listPlayerStats(
	db: AppDb,
	playerId: string,
	opts: { limit: number }
): Promise<{ rows: (typeof puzzleStats.$inferSelect)[] }> {
	const limit = Math.min(Math.max(opts.limit, 1), 100);
	const rows = await db
		.select()
		.from(puzzleStats)
		.where(eq(puzzleStats.playerId, playerId))
		.orderBy(desc(puzzleStats.bestTimeSeconds))
		.limit(limit)
		.all();
	return { rows };
}

export async function getPlayerSummary(
	db: AppDb,
	playerId: string
): Promise<{ puzzlesUploaded: number; puzzlesSolved: number; totalCompletions: number }> {
	const uploadedRows = await db
		.select({ n: count() })
		.from(puzzles)
		.where(eq(puzzles.ownerId, playerId))
		.all();
	const solvedRows = await db
		.select({
			solved: count(),
			completions: sql<number>`COALESCE(SUM(${puzzleStats.totalCompletions}), 0)`
		})
		.from(puzzleStats)
		.where(eq(puzzleStats.playerId, playerId))
		.all();
	return {
		puzzlesUploaded: uploadedRows[0]?.n ?? 0,
		puzzlesSolved: solvedRows[0]?.solved ?? 0,
		totalCompletions: Number(solvedRows[0]?.completions ?? 0)
	};
}
