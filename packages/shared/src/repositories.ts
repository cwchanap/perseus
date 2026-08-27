import { eq, lt, desc, asc, count, sql, and, inArray } from 'drizzle-orm';
import type { RecordPuzzleCompletionV1 } from '@perseus/types';
import type {
	AppDb,
	LegacyPuzzleOwnershipRow,
	NewPuzzleFamilyRow,
	PlayerProfileRow
} from './types';
import { puzzleFamilies, playerProfiles } from './schema';
import {
	interpretVersionedCompletionWrite,
	type CompletionWriteExecutor,
	type VersionedCompletionResult,
	type VersionedCompletionWrite
} from './completion-writes';

const VISIBLE_PLAYER_PUZZLE_FAMILY_STATUSES = ['ready', 'failed', 'processing'] as const;

// Sentinel ownerId for admin-created puzzles, which have no player owner.
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

const D1_IN_ARRAY_CHUNK_SIZE = 90;

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

/** @deprecated puzzles table removed in migration 0006; no-op until Task 11. */
export async function ensurePuzzleOwnership(
	_db: AppDb,
	_row: LegacyPuzzleOwnershipRow
): Promise<void> {}

export async function deletePuzzleStats(
	executor: CompletionWriteExecutor,
	puzzleId: string
): Promise<void> {
	await executor.finishPuzzleDeletion(puzzleId);
}

export async function insertPuzzleFamilyOwnership(
	db: AppDb,
	row: NewPuzzleFamilyRow
): Promise<void> {
	await db.insert(puzzleFamilies).values(row).run();
}

export async function ensurePuzzleFamilyOwnership(
	db: AppDb,
	row: NewPuzzleFamilyRow
): Promise<void> {
	await db
		.insert(puzzleFamilies)
		.values(row)
		.onConflictDoNothing({ target: puzzleFamilies.id })
		.run();
}

export async function deletePuzzleFamilyOwnership(db: AppDb, id: string): Promise<void> {
	await db.delete(puzzleFamilies).where(eq(puzzleFamilies.id, id)).run();
}

export async function setPuzzleFamilyStatus(db: AppDb, id: string, status: string): Promise<void> {
	await db.update(puzzleFamilies).set({ status }).where(eq(puzzleFamilies.id, id)).run();
}

export async function listPlayerPuzzleFamilies(
	db: AppDb,
	playerId: string,
	opts: { limit: number; cursor?: string }
): Promise<{ rows: (typeof puzzleFamilies.$inferSelect)[]; nextCursor?: string }> {
	const limit = Math.floor(
		Math.min(Math.max(Number.isFinite(opts.limit) ? opts.limit : 1, 1), 100)
	);
	const ownerCond = and(
		eq(puzzleFamilies.ownerId, playerId),
		inArray(puzzleFamilies.status, [...VISIBLE_PLAYER_PUZZLE_FAMILY_STATUSES])
	);
	const cond =
		opts.cursor !== undefined
			? and(ownerCond, parsePlayerPuzzleFamilyCursor(opts.cursor))
			: ownerCond;
	const all = await db
		.select()
		.from(puzzleFamilies)
		.where(cond)
		.orderBy(desc(puzzleFamilies.createdAt), desc(puzzleFamilies.id))
		.limit(limit + 1)
		.all();
	const rows = all.slice(0, limit);
	const nextCursor =
		all.length > limit ? encodePlayerPuzzleFamilyCursor(rows[rows.length - 1]) : undefined;
	return { rows, nextCursor };
}

function encodePlayerPuzzleFamilyCursor(row: { createdAt: number; id: string }): string {
	return `${row.createdAt}|${row.id}`;
}

function parsePlayerPuzzleFamilyCursor(cursor: string) {
	const sep = cursor.lastIndexOf('|');
	if (sep <= 0) {
		const ts = Number(cursor);
		return Number.isFinite(ts) ? lt(puzzleFamilies.createdAt, ts) : sql`false`;
	}
	const createdAtStr = cursor.slice(0, sep);
	const idStr = cursor.slice(sep + 1);
	const createdAt = Number(createdAtStr);
	if (!Number.isFinite(createdAt)) return sql`false`;
	return sql`(${puzzleFamilies.createdAt} < ${createdAt} OR (${puzzleFamilies.createdAt} = ${createdAt} AND ${puzzleFamilies.id} < ${idStr}))`;
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
	const limit = Math.floor(
		Math.min(Math.max(Number.isFinite(opts.limit) ? opts.limit : 1, 1), 100)
	);
	const cursor = opts.cursor === undefined ? undefined : parsePlayerStatsCursor(opts.cursor);
	const cursorPredicate = cursor === undefined ? sql`true` : playerStatsCursorPredicate(cursor);
	const all = await db.all<PlayerStatQueryRow>(sql`
		WITH
		${playerStatsCtes(playerId)},
		combined_stats AS (
			SELECT
				${playerId} AS "playerId",
				solved_groups.puzzle_id AS "puzzleId",
				NULL AS "puzzleName",
				standard_best.best_time_seconds AS "bestTimeSeconds",
				ledger_stats.ledger_count AS "totalCompletions",
				ledger_stats.ledger_first_completed_at AS "firstCompletedAt",
				ledger_stats.ledger_last_completed_at AS "lastCompletedAt",
				CASE WHEN standard_best.best_time_seconds IS NULL THEN 1 ELSE 0 END AS "sortGroup"
			FROM solved_groups
			LEFT JOIN ledger_stats
				ON ledger_stats.puzzle_id = solved_groups.puzzle_id
			LEFT JOIN puzzle_best_times standard_best
				ON standard_best.player_id = ${playerId}
				AND standard_best.puzzle_id = solved_groups.puzzle_id
				AND standard_best.result_class = 'standard_timed'
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
			.from(puzzleFamilies)
			.where(
				and(
					eq(puzzleFamilies.ownerId, playerId),
					inArray(puzzleFamilies.status, [...VISIBLE_PLAYER_PUZZLE_FAMILY_STATUSES])
				)
			)
			.all(),
		db.all<{ puzzlesSolved: number; totalCompletions: number }>(sql`
			WITH ${playerStatsCtes(playerId)}
			SELECT
				COUNT(*) AS "puzzlesSolved",
				COALESCE(SUM(ledger_stats.ledger_count), 0) AS "totalCompletions"
			FROM solved_groups
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
