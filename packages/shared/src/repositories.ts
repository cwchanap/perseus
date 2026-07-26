import { eq, lt, desc, asc, count, sql, and, inArray } from 'drizzle-orm';
import type { RecordPuzzleCompletionV1 } from '@perseus/types';
import type { AppDb, NewPuzzleRow, PlayerProfileRow } from './types';
import { puzzles, playerProfiles, puzzleStats } from './schema';
import {
	interpretVersionedCompletionWrite,
	type CompletionWriteExecutor,
	type LegacyCompletionWriteExecution,
	type VersionedCompletionResult,
	type VersionedCompletionWrite
} from './completion-writes';

// Statuses that appear in a player's "My Puzzles" list and "Uploaded" count.
// 'processing' is included so an in-flight upload is visible to its owner
// immediately after the ownership row is written (puzzles.worker.ts inserts
// it with status 'processing' before kicking off the workflow). The card UI
// (PuzzleCard.svelte) renders non-ready statuses as a non-clickable card
// with a PROCESSING…/FAILED overlay, so a processing puzzle is not a broken
// link. The list and the count share this filter so the tile always matches
// the visible cards.
const VISIBLE_PLAYER_PUZZLE_STATUSES = ['ready', 'failed', 'processing'] as const;

// Sentinel ownerId for admin-created puzzles, which have no player owner.
// Player profile lists/counts filter by a real player's ownerId, so a
// system-owned row never leaks into a player's "My Puzzles" list or count.
// It DOES participate in the listPlayerStats left join, so a signed-in
// player who solves an admin-created puzzle sees the puzzle's name (not a
// UUID) in their Puzzle Results list.
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
	avatarUrl: string,
	avatarUpdatedAt: number = Date.now(),
	avatarUpdateToken?: string
): Promise<void> {
	const now = Date.now();
	const token = avatarUpdateToken ?? null;
	await db
		.insert(playerProfiles)
		.values({ playerId, avatarUrl, avatarUpdatedAt, avatarUpdateToken: token, updatedAt: now })
		.onConflictDoUpdate({
			target: playerProfiles.playerId,
			set: { avatarUrl, avatarUpdatedAt, avatarUpdateToken: token, updatedAt: now }
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
		.values({
			playerId,
			avatarUrl: null,
			avatarUpdatedAt: null,
			avatarUpdateToken: null,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: playerProfiles.playerId,
			set: { avatarUrl: null, avatarUpdatedAt: null, avatarUpdateToken: null, updatedAt: now }
		})
		.run();
}

// Owner-checked avatar rollback: only nulls avatarUrl when the row's
// avatarUpdateToken matches ownerToken (the collision-resistant UUID the
// caller wrote via updateProfileAvatarUrl). This prevents a concurrent
// upload's successful avatar from being clobbered when this upload's live
// R2 put fails after the DB write. Two concurrent uploads can receive the
// same Date.now() millisecond, so the token is a UUID rather than a
// timestamp to guarantee uniqueness. Display-name writes update updatedAt
// but not avatarUpdateToken, so a name change after the avatar DB write
// cannot cause rollback to no-op while avatarUrl still points at a missing
// file. Uses a plain UPDATE (not upsert) so a missing row is a no-op.
export async function clearProfileAvatarUrlIfOwned(
	db: AppDb,
	playerId: string,
	ownerToken: string
): Promise<void> {
	const now = Date.now();
	await db
		.update(playerProfiles)
		.set({ avatarUrl: null, avatarUpdatedAt: null, avatarUpdateToken: null, updatedAt: now })
		.where(
			and(eq(playerProfiles.playerId, playerId), eq(playerProfiles.avatarUpdateToken, ownerToken))
		)
		.run();
}

// D1 imposes a limit of 100 bound parameters per query. An inArray() with
// more than 100 IDs exceeds this limit and the query throws — which in the
// avatar GC reaper means fail-closed (no deletion). Chunk to stay safely
// below the limit and merge the resulting maps. 90 gives headroom for any
// additional bound parameters the query builder might introduce.
const D1_IN_ARRAY_CHUNK_SIZE = 90;

// Batch-fetch the authoritative avatarUpdateToken for a set of players.
// Used by the avatar GC reaper to determine which versioned R2 objects are
// no longer reachable. Returns a Map<playerId, token | null>. Players with
// no profile row map to null (no authoritative token — all their versioned
// objects are orphans, but the legacy unversioned key is preserved by the
// caller as the D1-unavailable fallback). An empty input returns an empty
// Map without hitting D1.
//
// Chunks playerIds into groups of D1_IN_ARRAY_CHUNK_SIZE to stay under D1's
// 100 bound parameter limit. Without chunking, a reaper run with >100
// distinct players would throw, fail closed, and skip all deletion — so
// orphaned avatar objects would accumulate indefinitely.
export async function getAvatarTokensByPlayerIds(
	db: AppDb,
	playerIds: string[]
): Promise<Map<string, string | null>> {
	const result = new Map<string, string | null>();
	if (playerIds.length === 0) return result;
	for (let i = 0; i < playerIds.length; i += D1_IN_ARRAY_CHUNK_SIZE) {
		const chunk = playerIds.slice(i, i + D1_IN_ARRAY_CHUNK_SIZE);
		const rows = await db
			.select({
				playerId: playerProfiles.playerId,
				avatarUpdateToken: playerProfiles.avatarUpdateToken
			})
			.from(playerProfiles)
			.where(inArray(playerProfiles.playerId, chunk))
			.all();
		for (const row of rows) {
			result.set(row.playerId, row.avatarUpdateToken ?? null);
		}
	}
	return result;
}

export async function insertPuzzleOwnership(db: AppDb, row: NewPuzzleRow): Promise<void> {
	await db.insert(puzzles).values(row).run();
}

// Lazily backfill a D1 ownership row for a puzzle that has none yet — e.g. an
// admin puzzle whose best-effort ownership insert failed at creation time, or
// a puzzle that predates the D1 mirror. Uses the system sentinel owner so the
// row never leaks into a real player's "My Puzzles" list/counts (those filter
// by ownerId = playerId), but it DOES participate in listPlayerStats' left
// join so the Puzzle Results UI shows the puzzle's name instead of its UUID.
//
// ON CONFLICT (id) DO NOTHING: if a row already exists (player-owned, or a
// previously backfilled system row), it is left untouched. The KV/DO metadata
// is the source of truth for puzzle existence/status; this is a best-effort
// mirror write, so the caller logs failures rather than aborting the
// completion (mirroring the admin ownership-insert pattern).
export async function ensurePuzzleOwnership(db: AppDb, row: NewPuzzleRow): Promise<void> {
	await db.insert(puzzles).values(row).onConflictDoNothing({ target: puzzles.id }).run();
}

export async function deletePuzzleOwnership(db: AppDb, id: string): Promise<void> {
	await db.delete(puzzles).where(eq(puzzles.id, id)).run();
}

// Compatibility delegate while deletion callers move to the executor lifecycle.
// The executor owns the runtime-specific transaction so neither completion table
// can be deleted without the other.
export async function deletePuzzleStats(
	executor: CompletionWriteExecutor,
	puzzleId: string
): Promise<void> {
	await executor.finishPuzzleDeletion(puzzleId);
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
	const ownerCond = and(
		eq(puzzles.ownerId, playerId),
		inArray(puzzles.status, [...VISIBLE_PLAYER_PUZZLE_STATUSES])
	);
	const cond =
		opts.cursor !== undefined ? and(ownerCond, parsePlayerPuzzleCursor(opts.cursor)) : ownerCond;
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

export async function recordLegacyCompletion(
	executor: CompletionWriteExecutor,
	playerId: string,
	puzzleId: string,
	timeSeconds: number
): Promise<LegacyCompletionWriteExecution> {
	// Accepted risk: the server cannot verify that the client actually solved
	// the puzzle. Any authenticated player can POST an arbitrary timeSeconds
	// for any ready puzzle. The impact is self-scoped (only the caller's own
	// stats are affected) and there is no leaderboard or competitive ranking
	// at stake, so server-side verification is not worth the complexity. The
	// MAX_COMPLETION_TIME_SECONDS ceiling in the route layer rejects obvious
	// garbage values.
	const now = Date.now();
	return executor.writeLegacy({ playerId, puzzleId, timeSeconds, receivedAt: now });
}

export async function recordVersionedCompletion(
	executor: CompletionWriteExecutor,
	playerId: string,
	puzzleId: string,
	request: RecordPuzzleCompletionV1,
	receivedAt = Date.now()
): Promise<VersionedCompletionResult> {
	const input: VersionedCompletionWrite = {
		playerId,
		puzzleId,
		runId: request.runId,
		resultClass: request.resultClass,
		timingQuality: request.timingQuality,
		elapsedActiveSeconds: request.elapsedActiveSeconds,
		receivedAt
	};
	const execution = await executor.write(input);
	return interpretVersionedCompletionWrite(input, execution);
}

export type PlayerStatsCursor =
	| { version: 2; group: 0; bestTimeSeconds: number; puzzleId: string }
	| { version: 2; group: 1; puzzleId: string }
	| { version: 1; kind: 'composite'; bestTimeSeconds: number; puzzleId: string }
	| { version: 1; kind: 'bare'; bestTimeSeconds: number };

export class InvalidPlayerStatsCursorError extends Error {
	constructor(cursor: string) {
		super(`Invalid player stats cursor: ${cursor}`);
		this.name = 'InvalidPlayerStatsCursorError';
	}
}

const CANONICAL_CURSOR_SECONDS = /^(0|[1-9]\d*)$/u;

function parseCursorSeconds(value: string, cursor: string): number {
	if (!CANONICAL_CURSOR_SECONDS.test(value)) {
		throw new InvalidPlayerStatsCursorError(cursor);
	}
	const seconds = Number(value);
	if (!Number.isSafeInteger(seconds)) {
		throw new InvalidPlayerStatsCursorError(cursor);
	}
	return seconds;
}

export function parsePlayerStatsCursor(cursor: string): PlayerStatsCursor {
	const parts = cursor.split('|');
	if (parts[0] === 'v2') {
		if (parts.length !== 4) {
			throw new InvalidPlayerStatsCursorError(cursor);
		}
		const [, group, bestTimeSeconds, puzzleId] = parts;
		if (puzzleId.length === 0) {
			throw new InvalidPlayerStatsCursorError(cursor);
		}
		if (group === '0') {
			return {
				version: 2,
				group: 0,
				bestTimeSeconds: parseCursorSeconds(bestTimeSeconds, cursor),
				puzzleId
			};
		}
		if (group === '1' && bestTimeSeconds === '') {
			return { version: 2, group: 1, puzzleId };
		}
		throw new InvalidPlayerStatsCursorError(cursor);
	}
	if (parts.length === 2) {
		const [bestTimeSeconds, puzzleId] = parts;
		if (puzzleId.length === 0) {
			throw new InvalidPlayerStatsCursorError(cursor);
		}
		return {
			version: 1,
			kind: 'composite',
			bestTimeSeconds: parseCursorSeconds(bestTimeSeconds, cursor),
			puzzleId
		};
	}
	if (parts.length === 1) {
		return {
			version: 1,
			kind: 'bare',
			bestTimeSeconds: parseCursorSeconds(parts[0], cursor)
		};
	}
	throw new InvalidPlayerStatsCursorError(cursor);
}

export interface PlayerStat {
	playerId: string;
	puzzleId: string;
	puzzleName: string | null;
	bestTimeSeconds: number | null;
	totalCompletions: number;
	firstCompletedAt: number;
	lastCompletedAt: number;
}

interface PlayerStatQueryRow extends PlayerStat {
	sortGroup: number;
}

function playerStatsCtes(playerId: string) {
	return sql`
		ledger_stats AS (
			SELECT
				player_id,
				puzzle_id,
				COUNT(*) AS ledger_count,
				MIN(completed_at) AS ledger_first_completed_at,
				MAX(completed_at) AS ledger_last_completed_at
			FROM puzzle_completion_runs
			WHERE player_id = ${playerId}
			GROUP BY player_id, puzzle_id
		),
		solved_groups AS (
			SELECT puzzle_id
			FROM puzzle_stats
			WHERE player_id = ${playerId}
			UNION
			SELECT puzzle_id
			FROM ledger_stats
		)
	`;
}

function playerStatsCursorPredicate(cursor: PlayerStatsCursor) {
	if (cursor.version === 2 && cursor.group === 1) {
		return sql`"sortGroup" = 1 AND "puzzleId" > ${cursor.puzzleId}`;
	}
	if (cursor.version === 1 && cursor.kind === 'bare') {
		return sql`(
			"sortGroup" = 1
			OR ("sortGroup" = 0 AND "bestTimeSeconds" > ${cursor.bestTimeSeconds})
		)`;
	}
	return sql`(
		"sortGroup" = 1
		OR (
			"sortGroup" = 0
			AND (
				"bestTimeSeconds" > ${cursor.bestTimeSeconds}
				OR (
					"bestTimeSeconds" = ${cursor.bestTimeSeconds}
					AND "puzzleId" > ${cursor.puzzleId}
				)
			)
		)
	)`;
}

function encodePlayerStatsCursor(row: PlayerStat): string {
	return row.bestTimeSeconds === null
		? `v2|1||${row.puzzleId}`
		: `v2|0|${row.bestTimeSeconds}|${row.puzzleId}`;
}

export async function listPlayerStats(
	db: AppDb,
	playerId: string,
	opts: { limit: number; cursor?: string }
): Promise<{ rows: PlayerStat[]; nextCursor?: string }> {
	const limit = Math.floor(Math.min(Math.max(opts.limit, 1), 100));
	const cursor = opts.cursor === undefined ? undefined : parsePlayerStatsCursor(opts.cursor);
	const cursorPredicate = cursor === undefined ? sql`true` : playerStatsCursorPredicate(cursor);
	const all = await db.all<PlayerStatQueryRow>(sql`
		WITH
		${playerStatsCtes(playerId)},
		combined_stats AS (
			SELECT
				${playerId} AS "playerId",
				solved_groups.puzzle_id AS "puzzleId",
				puzzles.name AS "puzzleName",
				puzzle_stats.best_time_seconds AS "bestTimeSeconds",
				(
					COALESCE(puzzle_stats.total_completions, 0)
					+ COALESCE(ledger_stats.ledger_count, 0)
				) AS "totalCompletions",
				CASE
					WHEN puzzle_stats.first_completed_at IS NULL
						THEN ledger_stats.ledger_first_completed_at
					WHEN ledger_stats.ledger_first_completed_at IS NULL
						THEN puzzle_stats.first_completed_at
					WHEN puzzle_stats.first_completed_at < ledger_stats.ledger_first_completed_at
						THEN puzzle_stats.first_completed_at
					ELSE ledger_stats.ledger_first_completed_at
				END AS "firstCompletedAt",
				CASE
					WHEN puzzle_stats.last_completed_at IS NULL
						THEN ledger_stats.ledger_last_completed_at
					WHEN ledger_stats.ledger_last_completed_at IS NULL
						THEN puzzle_stats.last_completed_at
					WHEN puzzle_stats.last_completed_at > ledger_stats.ledger_last_completed_at
						THEN puzzle_stats.last_completed_at
					ELSE ledger_stats.ledger_last_completed_at
				END AS "lastCompletedAt",
				CASE WHEN puzzle_stats.best_time_seconds IS NULL THEN 1 ELSE 0 END
					AS "sortGroup"
			FROM solved_groups
			LEFT JOIN puzzle_stats
				ON puzzle_stats.player_id = ${playerId}
				AND puzzle_stats.puzzle_id = solved_groups.puzzle_id
			LEFT JOIN ledger_stats
				ON ledger_stats.puzzle_id = solved_groups.puzzle_id
			LEFT JOIN puzzles
				ON puzzles.id = solved_groups.puzzle_id
		)
		SELECT
			"playerId",
			"puzzleId",
			"puzzleName",
			"bestTimeSeconds",
			"totalCompletions",
			"firstCompletedAt",
			"lastCompletedAt",
			"sortGroup"
		FROM combined_stats
		WHERE ${cursorPredicate}
		ORDER BY "sortGroup" ASC, "bestTimeSeconds" ASC, "puzzleId" ASC
		LIMIT ${limit + 1}
	`);
	const rows = all
		.slice(0, limit)
		.map(
			({
				playerId: rowPlayerId,
				puzzleId,
				puzzleName,
				bestTimeSeconds,
				totalCompletions,
				firstCompletedAt,
				lastCompletedAt
			}) => ({
				playerId: rowPlayerId,
				puzzleId,
				puzzleName,
				bestTimeSeconds,
				totalCompletions: Number(totalCompletions),
				firstCompletedAt: Number(firstCompletedAt),
				lastCompletedAt: Number(lastCompletedAt)
			})
		);
	const nextCursor =
		all.length > limit ? encodePlayerStatsCursor(rows[rows.length - 1]) : undefined;
	return { rows, nextCursor };
}

export async function getPlayerSummary(
	db: AppDb,
	playerId: string
): Promise<{ puzzlesUploaded: number; puzzlesSolved: number; totalCompletions: number }> {
	const [uploadedRows, solvedRows] = await Promise.all([
		db
			.select({ n: count() })
			.from(puzzles)
			.where(
				and(
					eq(puzzles.ownerId, playerId),
					inArray(puzzles.status, [...VISIBLE_PLAYER_PUZZLE_STATUSES])
				)
			)
			.all(),
		db.all<{ puzzlesSolved: number; totalCompletions: number }>(sql`
			WITH ${playerStatsCtes(playerId)}
			SELECT
				COUNT(*) AS "puzzlesSolved",
				COALESCE(
					SUM(
						COALESCE(puzzle_stats.total_completions, 0)
						+ COALESCE(ledger_stats.ledger_count, 0)
					),
					0
				) AS "totalCompletions"
			FROM solved_groups
			LEFT JOIN puzzle_stats
				ON puzzle_stats.player_id = ${playerId}
				AND puzzle_stats.puzzle_id = solved_groups.puzzle_id
			LEFT JOIN ledger_stats
				ON ledger_stats.puzzle_id = solved_groups.puzzle_id
		`)
	]);
	return {
		puzzlesUploaded: uploadedRows[0]?.n ?? 0,
		puzzlesSolved: Number(solvedRows[0]?.puzzlesSolved ?? 0),
		totalCompletions: Number(solvedRows[0]?.totalCompletions ?? 0)
	};
}
