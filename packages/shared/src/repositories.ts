import { eq, lt, gt, desc, asc, count, sql, and } from 'drizzle-orm';
import type { AppDb, NewPuzzleRow, PlayerProfileRow } from './types';
import { puzzles, playerProfiles, puzzleStats } from './schema';

// Sentinel ownerId for admin-created puzzles, which have no player owner.
// Player profile lists/counts filter by a real player's ownerId, so a
// system-owned row never leaks into a player's "My Puzzles" list or count.
// It DOES participate in the listPlayerStats left join, so a signed-in
// player who solves an admin-created puzzle sees the puzzle's name (not a
// UUID) in their Best Times list.
export const SYSTEM_OWNER_ID = 'system';

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

// Field-specific upserts: each writes only its own column via ON CONFLICT,
// leaving the other column untouched. This removes the read-modify-write race
// between concurrent PATCH /profile and POST /avatar requests, where a single
// upsert writing both columns could clobber the other field with a stale
// value. On first contact (no existing row) the missing column defaults to
// NULL.
export async function updateProfileDisplayName(
	db: AppDb,
	playerId: string,
	displayName: string | null
): Promise<void> {
	const now = Date.now();
	await db
		.insert(playerProfiles)
		.values({ playerId, displayName, updatedAt: now })
		.onConflictDoUpdate({
			target: playerProfiles.playerId,
			set: { displayName, updatedAt: now }
		})
		.run();
}

export async function updateProfileAvatarUrl(
	db: AppDb,
	playerId: string,
	avatarUrl: string
): Promise<void> {
	const now = Date.now();
	await db
		.insert(playerProfiles)
		.values({ playerId, avatarUrl, updatedAt: now })
		.onConflictDoUpdate({
			target: playerProfiles.playerId,
			set: { avatarUrl, updatedAt: now }
		})
		.run();
}

// Clear the avatarUrl flag on a profile override. Used to roll back the DB
// write when the live R2 object promotion fails after updateProfileAvatarUrl
// succeeded, so the profile doesn't keep pointing at a serve route that 404s.
// Writes only avatarUrl (preserving displayName) via the same field-specific
// upsert pattern. Setting avatarUrl to NULL (rather than '') keeps the
// "no avatar" sentinel consistent with the default for a fresh profile row.
export async function clearProfileAvatarUrl(db: AppDb, playerId: string): Promise<void> {
	const now = Date.now();
	await db
		.insert(playerProfiles)
		.values({ playerId, avatarUrl: null, updatedAt: now })
		.onConflictDoUpdate({
			target: playerProfiles.playerId,
			set: { avatarUrl: null, updatedAt: now }
		})
		.run();
}

export async function insertPuzzleOwnership(db: AppDb, row: NewPuzzleRow): Promise<void> {
	await db.insert(puzzles).values(row).run();
}

export async function deletePuzzleOwnership(db: AppDb, id: string): Promise<void> {
	await db.delete(puzzles).where(eq(puzzles.id, id)).run();
}

// Remove every player's stat row for a deleted puzzle. Without this, a
// deleted puzzle leaves orphaned puzzle_stats rows; listPlayerStats left-
// joins on puzzles so they surface with puzzleName null (cosmetic), but
// deleting them keeps the stats list clean and avoids counting solves of
// puzzles that no longer exist. Called best-effort from the admin delete
// path alongside deletePuzzleOwnership.
export async function deletePuzzleStats(db: AppDb, puzzleId: string): Promise<void> {
	await db.delete(puzzleStats).where(eq(puzzleStats.puzzleId, puzzleId)).run();
}

export async function setPuzzleStatus(db: AppDb, id: string, status: string): Promise<void> {
	await db.update(puzzles).set({ status }).where(eq(puzzles.id, id)).run();
}

export async function listPlayerPuzzles(
	db: AppDb,
	playerId: string,
	opts: { limit: number; cursor?: string }
): Promise<{ rows: (typeof puzzles.$inferSelect)[]; nextCursor?: string }> {
	// Floor to an integer before clamping: the route layer passes through any
	// finite Number(...) value, so a fractional query like ?limit=1.5 would
	// otherwise survive the clamp and bind a non-integer (2.5) to SQL LIMIT,
	// which SQLite/D1 rejects with a datatype error. Flooring treats 1.5 as 1
	// (the nearest valid integer at or below the requested value).
	const limit = Math.floor(Math.min(Math.max(opts.limit, 1), 100));
	// Composite cursor (createdAt, id) avoids skipping a row when two puzzles
	// share the same createdAt timestamp: rows are ordered by createdAt DESC
	// then id DESC, and the cursor excludes anything strictly "after" the last
	// row of the previous page on that lexicographic ordering.
	// drizzle's `.where()` replaces (not merges) the previous condition, so
	// chaining a second `.where()` for the cursor would silently drop the
	// ownerId filter and leak other players' puzzles across pages.
	const cond =
		opts.cursor !== undefined
			? and(eq(puzzles.ownerId, playerId), parsePlayerPuzzleCursor(opts.cursor))
			: eq(puzzles.ownerId, playerId);
	const all = await db
		.select()
		.from(puzzles)
		.where(cond)
		.orderBy(desc(puzzles.createdAt), desc(puzzles.id))
		.limit(limit + 1)
		.all();
	const rows = all.slice(0, limit);
	const nextCursor =
		all.length > limit ? encodePlayerPuzzleCursor(rows[rows.length - 1]) : undefined;
	return { rows, nextCursor };
}

// Composite cursor format: "<createdAt>|<id>". createdAt is the millisecond
// timestamp; id is the puzzle's text primary key. Both are URL-safe enough for
// a query parameter when encoded via encodeURIComponent at the API boundary.
function encodePlayerPuzzleCursor(row: { createdAt: number; id: string }): string {
	return `${row.createdAt}|${row.id}`;
}

function parsePlayerPuzzleCursor(cursor: string) {
	// (createdAt, id) ordering: a row is "after" the cursor if its createdAt is
	// strictly less than the cursor's, OR its createdAt equals the cursor's and
	// its id is strictly less (lexicographically) than the cursor's id. We want
	// to exclude rows at or "before" the cursor (already served), so the
	// condition keeps rows strictly "after".
	const sep = cursor.lastIndexOf('|');
	if (sep <= 0) {
		// Malformed cursor: fall back to treating the whole string as a
		// createdAt timestamp for backward compatibility with older clients.
		const ts = Number(cursor);
		return Number.isFinite(ts) ? lt(puzzles.createdAt, ts) : sql`false`;
	}
	const createdAtStr = cursor.slice(0, sep);
	const idStr = cursor.slice(sep + 1);
	const createdAt = Number(createdAtStr);
	if (!Number.isFinite(createdAt)) return sql`false`;
	return sql`(${puzzles.createdAt} < ${createdAt} OR (${puzzles.createdAt} = ${createdAt} AND ${puzzles.id} < ${idStr}))`;
}

export async function countPlayerPuzzles(db: AppDb, playerId: string): Promise<number> {
	const rows = await db
		.select({ n: count() })
		.from(puzzles)
		.where(eq(puzzles.ownerId, playerId))
		.all();
	return rows[0]?.n ?? 0;
}

// Server-side dedupe window for completion submissions. Two completions of
// the same (player, puzzle) closer together than this are treated as a retried
// or duplicated submission (e.g. a re-POST after a lost response, or a
// double-tap) and do NOT increment totalCompletions. Genuine re-solves take
// longer than this even for small puzzles (navigation + re-solving), so they
// still count. This is a heuristic — the server cannot distinguish a rapid
// legitimate replay from a retry without a client-provided idempotency key —
// but it closes the realistic double-count vector without a schema change.
// bestTimeSeconds still takes the MIN regardless, so a better time is always
// recorded even for a deduped retry.
const COMPLETION_DEDUPE_WINDOW_MS = 30_000;

export async function recordCompletion(
	db: AppDb,
	playerId: string,
	puzzleId: string,
	timeSeconds: number
): Promise<void> {
	// Accepted risk: the server cannot verify that the client actually solved
	// the puzzle. Any authenticated player can POST an arbitrary timeSeconds
	// for any ready puzzle. The impact is self-scoped (only the caller's own
	// stats are affected) and there is no leaderboard or competitive ranking
	// at stake, so server-side verification is not worth the complexity. The
	// MAX_COMPLETION_TIME_SECONDS ceiling in the route layer rejects obvious
	// garbage values.
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
				// best time always tracks the minimum observed (`excluded` is
				// SQLite's name for the conflicting incoming row). Safe even for a
				// deduped retry, which carries the same time anyway.
				bestTimeSeconds: sql`MIN(${puzzleStats.bestTimeSeconds}, excluded.best_time_seconds)`,
				// Only count the solve and advance lastCompletedAt when it falls
				// outside the dedupe window of the last RECORDED completion. A rapid
				// retry within the window leaves both untouched, preventing inflated
				// counts. `excluded.last_completed_at` is the incoming now.
				totalCompletions: sql`CASE WHEN excluded.last_completed_at - ${puzzleStats.lastCompletedAt} >= ${COMPLETION_DEDUPE_WINDOW_MS} THEN ${puzzleStats.totalCompletions} + 1 ELSE ${puzzleStats.totalCompletions} END`,
				lastCompletedAt: sql`CASE WHEN excluded.last_completed_at - ${puzzleStats.lastCompletedAt} >= ${COMPLETION_DEDUPE_WINDOW_MS} THEN excluded.last_completed_at ELSE ${puzzleStats.lastCompletedAt} END`
			}
		})
		.run();
}

export async function listPlayerStats(
	db: AppDb,
	playerId: string,
	opts: { limit: number; cursor?: string }
): Promise<{
	rows: {
		playerId: string;
		puzzleId: string;
		puzzleName: string | null;
		bestTimeSeconds: number;
		totalCompletions: number;
		firstCompletedAt: number;
		lastCompletedAt: number;
	}[];
	nextCursor?: string;
}> {
	// Floor to an integer before clamping — see listPlayerPuzzles for the
	// rationale. A fractional ?limit would otherwise bind a non-integer to
	// SQL LIMIT and D1/SQLite would reject it with a datatype error.
	const limit = Math.floor(Math.min(Math.max(opts.limit, 1), 100));
	// Composite cursor (bestTimeSeconds, puzzleId) avoids skipping a row when
	// two puzzles share the same best time: rows are ordered by bestTimeSeconds
	// ASC then puzzleId ASC, and the cursor excludes anything at or "before"
	// the last row of the previous page on that lexicographic ordering.
	// drizzle's `.where()` replaces (not merges) the previous condition, so
	// chaining a second `.where()` for the cursor would silently drop the
	// ownerId filter and leak other players' stats across pages.
	//
	// Known limitation: bestTimeSeconds is mutable. If a player improves their
	// best time on a puzzle between page fetches, that row moves earlier in
	// the ASC ordering and may be skipped (it falls "before" the cursor). This
	// is acceptable for a personal best-times list — the row will reappear on
	// the next full reload, and the impact is limited to a transient missing
	// entry in an append-only scroll, not a data-integrity issue.
	const cond =
		opts.cursor !== undefined
			? and(eq(puzzleStats.playerId, playerId), parsePlayerStatsCursor(opts.cursor))
			: eq(puzzleStats.playerId, playerId);
	// Left join on puzzles so a deleted puzzle's stat row still surfaces
	// (puzzleName null). Ordered by best time ascending (fastest first), with
	// puzzleId as a deterministic tiebreaker for equal best times.
	const all = await db
		.select({
			playerId: puzzleStats.playerId,
			puzzleId: puzzleStats.puzzleId,
			puzzleName: puzzles.name,
			bestTimeSeconds: puzzleStats.bestTimeSeconds,
			totalCompletions: puzzleStats.totalCompletions,
			firstCompletedAt: puzzleStats.firstCompletedAt,
			lastCompletedAt: puzzleStats.lastCompletedAt
		})
		.from(puzzleStats)
		.leftJoin(puzzles, eq(puzzleStats.puzzleId, puzzles.id))
		.where(cond)
		.orderBy(asc(puzzleStats.bestTimeSeconds), asc(puzzleStats.puzzleId))
		.limit(limit + 1)
		.all();
	const rows = all.slice(0, limit);
	const nextCursor =
		all.length > limit ? encodePlayerStatsCursor(rows[rows.length - 1]) : undefined;
	return { rows, nextCursor };
}

// Composite cursor format: "<bestTimeSeconds>|<puzzleId>". bestTimeSeconds is
// an integer second count; puzzleId is the stat row's text primary key. Both
// are URL-safe enough for a query parameter when encoded via
// encodeURIComponent at the API boundary.
function encodePlayerStatsCursor(row: { bestTimeSeconds: number; puzzleId: string }): string {
	return `${row.bestTimeSeconds}|${row.puzzleId}`;
}

function parsePlayerStatsCursor(cursor: string) {
	// (bestTimeSeconds, puzzleId) ordering: a row is "after" the cursor if its
	// bestTimeSeconds is strictly greater than the cursor's, OR its
	// bestTimeSeconds equals the cursor's and its puzzleId is strictly greater
	// (lexicographically) than the cursor's puzzleId. We want to exclude rows
	// at or "before" the cursor (already served), so the condition keeps rows
	// strictly "after".
	const sep = cursor.lastIndexOf('|');
	if (sep <= 0) {
		// Malformed cursor: fall back to treating the whole string as a
		// bestTimeSeconds value for backward compatibility with older clients.
		// Stats are ordered ASC, so "after" means strictly greater.
		const ts = Number(cursor);
		return Number.isFinite(ts) ? gt(puzzleStats.bestTimeSeconds, ts) : sql`false`;
	}
	const bestStr = cursor.slice(0, sep);
	const idStr = cursor.slice(sep + 1);
	const best = Number(bestStr);
	if (!Number.isFinite(best)) return sql`false`;
	return sql`(${puzzleStats.bestTimeSeconds} > ${best} OR (${puzzleStats.bestTimeSeconds} = ${best} AND ${puzzleStats.puzzleId} > ${idStr}))`;
}

export async function getPlayerSummary(
	db: AppDb,
	playerId: string
): Promise<{ puzzlesUploaded: number; puzzlesSolved: number; totalCompletions: number }> {
	// Intentionally non-transactional: the two counts (uploaded puzzles,
	// solved puzzles + total completions) are independent reads from
	// separate tables. Wrapping them in a transaction would add a round-trip
	// for no correctness benefit — a concurrent insert/delete between the two
	// reads could make the counts momentarily inconsistent regardless, and
	// the profile UI treats these as approximate summary tiles, not as an
	// atomic snapshot. D1/SQLite also doesn't support read-only transactions
	// any differently from plain reads here.
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
