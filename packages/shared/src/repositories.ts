import { eq, lt, desc, asc, count, sql, and, inArray, type SQL } from 'drizzle-orm';
import type { PuzzleDifficulty, RecordPuzzleCompletionV2, ResultClass } from '@perseus/types';
import type { AppDb, NewPuzzleFamilyRow, PlayerProfileRow } from './types';
import { puzzleFamilies, playerProfiles, playerAchievements } from './schema';
import {
	interpretVersionedCompletionWrite,
	type CompletionMutationFacts,
	type CompletionWriteExecutor,
	type VersionedCompletionResult,
	type VersionedCompletionWrite
} from './completion-writes';
import {
	evaluateAchievements,
	type AchievementId,
	type AchievementSnapshot,
	ACHIEVEMENT_COUNT,
	ACHIEVEMENT_POINTS,
	UNIQUE_CLEAR_POINTS,
	type MasteryBadge
} from './progression';

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

// Linear (non-backtracking) email-shape check — safe on arbitrary-length input
// (CodeQL js/polynomial-redos). Mirrors SIMPLE_EMAIL_PATTERN semantics:
// local@domain.tld with no whitespace and exactly one '@'. Unlike a length-capped
// regex guard, this preserves the privacy contract for over-length email-shaped
// candidates (they are still rejected) without running a backtracking pattern.
function looksLikeEmail(value: string): boolean {
	const at = value.indexOf('@');
	if (at <= 0) return false; // no '@' or empty local part
	if (value.indexOf('@', at + 1) !== -1) return false; // more than one '@'
	if (/\s/u.test(value)) return false; // no whitespace anywhere (linear, no quantifier)
	const dot = value.indexOf('.', at + 1);
	return dot > at + 1 && dot < value.length - 1; // non-empty domain label and TLD
}

export function isPublicSafeDisplayName(name: string): boolean {
	const trimmed = name.trim();
	if (!trimmed) return false;
	if (looksLikeEmail(trimmed)) return false;
	return true;
}

export async function ensurePublicDisplayName(
	db: AppDb,
	playerId: string,
	candidateName: string | null | undefined
): Promise<void> {
	if (!candidateName || !isPublicSafeDisplayName(candidateName)) return;
	const existing = await getProfileOverride(db, playerId);
	if (existing?.displayName) return;
	const trimmed = candidateName.trim();
	const now = Date.now();
	if (!existing) {
		// onConflictDoNothing: two concurrent first-name claims both read
		// `existing === null`; without the guard the loser would abort on the
		// playerProfiles primary key and surface a 500. Skipping silently
		// preserves whichever name won the race.
		await db
			.insert(playerProfiles)
			.values({ playerId, displayName: trimmed, updatedAt: now })
			.onConflictDoNothing({ target: playerProfiles.playerId })
			.run();
		return;
	}
	await updateProfileDisplayName(db, playerId, trimmed);
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

/** @deprecated puzzles table removed in migration 0006; use ensurePuzzleFamilyOwnership. */
export async function ensurePuzzleOwnership(_db: AppDb, _row: { id: string }): Promise<void> {}

export interface TrustedVariantIdentity {
	familyId: string;
	difficulty: PuzzleDifficulty;
}

export async function readAchievementSnapshot(
	db: AppDb,
	playerId: string
): Promise<AchievementSnapshot> {
	const rows = await db.all<{
		uniqueClears: number;
		hardClears: number;
		hasFullSetOnAnyFamily: number;
		hasHintlessMastery: number;
		hasFlawlessMastery: number;
		hasRotationClearMastery: number;
	}>(sql`
		SELECT
			(
				SELECT COUNT(*) FROM player_difficulty_completions
				WHERE player_id = ${playerId}
			) AS "uniqueClears",
			(
				SELECT COUNT(*) FROM player_difficulty_completions
				WHERE player_id = ${playerId} AND difficulty = 'hard'
			) AS "hardClears",
			(
				SELECT COUNT(*) FROM (
					SELECT family_id FROM player_difficulty_completions
					WHERE player_id = ${playerId}
					GROUP BY family_id
					HAVING COUNT(DISTINCT difficulty) = 3
				)
			) AS "hasFullSetOnAnyFamily",
			(
				SELECT COUNT(*) FROM player_variant_mastery
				WHERE player_id = ${playerId} AND badge = 'hintless'
			) AS "hasHintlessMastery",
			(
				SELECT COUNT(*) FROM player_variant_mastery
				WHERE player_id = ${playerId} AND badge = 'flawless'
			) AS "hasFlawlessMastery",
			(
				SELECT COUNT(*) FROM player_variant_mastery
				WHERE player_id = ${playerId} AND badge = 'rotation_clear'
			) AS "hasRotationClearMastery"
	`);
	const row = rows[0];
	return {
		uniqueClears: Number(row?.uniqueClears ?? 0),
		hardClears: Number(row?.hardClears ?? 0),
		hasFullSetOnAnyFamily: Number(row?.hasFullSetOnAnyFamily ?? 0) > 0,
		hasHintlessMastery: Number(row?.hasHintlessMastery ?? 0) > 0,
		hasFlawlessMastery: Number(row?.hasFlawlessMastery ?? 0) > 0,
		hasRotationClearMastery: Number(row?.hasRotationClearMastery ?? 0) > 0
	};
}

export async function reconcileAchievements(
	db: AppDb,
	playerId: string,
	unlockedAt: number
): Promise<AchievementId[]> {
	const snapshot = await readAchievementSnapshot(db, playerId);
	const candidates = evaluateAchievements(snapshot);
	if (candidates.length === 0) return [];
	const inserted = await db
		.insert(playerAchievements)
		.values(candidates.map((achievementId) => ({ playerId, achievementId, unlockedAt })))
		.onConflictDoNothing({
			target: [playerAchievements.playerId, playerAchievements.achievementId]
		})
		.returning({ achievementId: playerAchievements.achievementId });
	// Returning yields only rows this call actually inserted; derive `awarded`
	// from it (conflict-skipped achievements stay excluded) while preserving
	// the candidates' order for stable award payloads.
	const insertedIds = new Set(inserted.map((row) => row.achievementId));
	return candidates.filter((achievementId) => insertedIds.has(achievementId));
}

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

export class InvalidPlayerPuzzleFamilyCursorError extends Error {
	constructor(cursor: string) {
		super(`Invalid player puzzle family cursor: ${cursor}`);
		this.name = 'InvalidPlayerPuzzleFamilyCursorError';
	}
}

function parsePlayerPuzzleFamilyCursor(cursor: string) {
	const sep = cursor.lastIndexOf('|');
	if (sep <= 0) {
		const ts = Number(cursor);
		if (Number.isFinite(ts)) return lt(puzzleFamilies.createdAt, ts);
		throw new InvalidPlayerPuzzleFamilyCursorError(cursor);
	}
	const createdAtStr = cursor.slice(0, sep);
	const idStr = cursor.slice(sep + 1);
	const createdAt = Number(createdAtStr);
	if (!Number.isFinite(createdAt)) {
		throw new InvalidPlayerPuzzleFamilyCursorError(cursor);
	}
	return sql`(${puzzleFamilies.createdAt} < ${createdAt} OR (${puzzleFamilies.createdAt} = ${createdAt} AND ${puzzleFamilies.id} < ${idStr}))`;
}

export async function recordVersionedCompletion(
	db: AppDb,
	executor: CompletionWriteExecutor,
	playerId: string,
	puzzleId: string,
	request: RecordPuzzleCompletionV2,
	identity: TrustedVariantIdentity,
	receivedAt = Date.now()
): Promise<VersionedCompletionResult & { awards?: CompletionAwardsResult }> {
	const input: VersionedCompletionWrite = {
		playerId,
		puzzleId,
		familyId: identity.familyId,
		difficulty: identity.difficulty,
		runId: request.runId,
		resultClass: request.resultClass,
		elapsedActiveSeconds: request.elapsedActiveSeconds,
		hintsUsed: request.hintsUsed,
		incorrectAttempts: request.incorrectAttempts,
		receivedAt
	};
	const execution = await executor.write(input);
	const result = interpretVersionedCompletionWrite(input, execution);
	let newAchievements: AchievementId[] = [];
	if (result.status === 'recorded' || result.status === 'replayed') {
		newAchievements = await reconcileAchievements(db, playerId, result.completedAt);
	}
	if (result.status === 'recorded' || result.status === 'replayed') {
		const awards = await deriveCompletionAwards(
			db,
			playerId,
			{
				puzzleId,
				familyId: identity.familyId,
				difficulty: identity.difficulty,
				resultClass: request.resultClass,
				completedAt: result.completedAt,
				elapsedActiveSeconds: request.elapsedActiveSeconds
			},
			newAchievements,
			result.status === 'recorded',
			execution.status === 'stored' ? execution.mutations : undefined
		);
		return { ...result, awards };
	}
	return result;
}

export type PlayerStatsCursor =
	| {
			version: 3;
			group: 0;
			standardBestTimeSeconds: number;
			familyId: string;
			difficulty: PuzzleDifficulty;
	  }
	| { version: 3; group: 1; familyId: string; difficulty: PuzzleDifficulty };

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

function parseDifficultyToken(value: string, cursor: string): PuzzleDifficulty {
	if (value === 'easy' || value === 'normal' || value === 'hard') return value;
	throw new InvalidPlayerStatsCursorError(cursor);
}

export function parsePlayerStatsCursor(cursor: string): PlayerStatsCursor {
	const parts = cursor.split('|');
	if (parts[0] === 'v3' && parts.length === 5) {
		const [, group, standardBestTimeSeconds, familyId, difficulty] = parts;
		if (familyId.length === 0) throw new InvalidPlayerStatsCursorError(cursor);
		const parsedDifficulty = parseDifficultyToken(difficulty, cursor);
		if (group === '0') {
			return {
				version: 3,
				group: 0,
				standardBestTimeSeconds: parseCursorSeconds(standardBestTimeSeconds, cursor),
				familyId,
				difficulty: parsedDifficulty
			};
		}
		if (group === '1' && standardBestTimeSeconds === '') {
			return { version: 3, group: 1, familyId, difficulty: parsedDifficulty };
		}
	}
	throw new InvalidPlayerStatsCursorError(cursor);
}

export interface PlayerStat {
	playerId: string;
	familyId: string;
	familyName: string | null;
	difficulty: PuzzleDifficulty;
	standardBestTimeSeconds: number | null;
	rotationBestTimeSeconds: number | null;
	totalCompletions: number;
	firstCompletedAt: number;
	lastCompletedAt: number;
}

interface PlayerStatQueryRow extends PlayerStat {
	sortGroup: number;
}

function playerStatsCursorPredicate(cursor: PlayerStatsCursor) {
	if (cursor.group === 1) {
		return sql`"sortGroup" = 1 AND (
			"familyId" > ${cursor.familyId}
			OR ("familyId" = ${cursor.familyId} AND "difficulty" > ${cursor.difficulty})
		)`;
	}
	return sql`(
		"sortGroup" = 1
		OR (
			"sortGroup" = 0
			AND (
				"standardBestTimeSeconds" > ${cursor.standardBestTimeSeconds}
				OR (
					"standardBestTimeSeconds" = ${cursor.standardBestTimeSeconds}
					AND (
						"familyId" > ${cursor.familyId}
						OR (
							"familyId" = ${cursor.familyId}
							AND "difficulty" > ${cursor.difficulty}
						)
					)
				)
			)
		)
	)`;
}

function encodePlayerStatsCursor(row: PlayerStat): string {
	return row.standardBestTimeSeconds === null
		? `v3|1||${row.familyId}|${row.difficulty}`
		: `v3|0|${row.standardBestTimeSeconds}|${row.familyId}|${row.difficulty}`;
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
		WITH run_stats AS (
			SELECT
				family_id AS "familyId",
				difficulty AS "difficulty",
				COUNT(*) AS "totalCompletions",
				MIN(completed_at) AS "firstCompletedAt",
				MAX(completed_at) AS "lastCompletedAt"
			FROM puzzle_completion_runs
			WHERE player_id = ${playerId}
			GROUP BY family_id, difficulty
		),
		standard_bests AS (
			SELECT family_id AS "familyId", difficulty AS "difficulty",
				MIN(best_time_seconds) AS "standardBestTimeSeconds"
			FROM puzzle_best_times
			WHERE player_id = ${playerId} AND result_class = 'standard_timed'
			GROUP BY family_id, difficulty
		),
		rotation_bests AS (
			SELECT family_id AS "familyId", difficulty AS "difficulty",
				MIN(best_time_seconds) AS "rotationBestTimeSeconds"
			FROM puzzle_best_times
			WHERE player_id = ${playerId} AND result_class = 'rotation_timed'
			GROUP BY family_id, difficulty
		),
		combined_stats AS (
			SELECT
				${playerId} AS "playerId",
				run_stats."familyId",
				puzzle_families.name AS "familyName",
				run_stats."difficulty",
				standard_bests."standardBestTimeSeconds",
				rotation_bests."rotationBestTimeSeconds",
				run_stats."totalCompletions",
				run_stats."firstCompletedAt",
				run_stats."lastCompletedAt",
				CASE WHEN standard_bests."standardBestTimeSeconds" IS NULL THEN 1 ELSE 0 END AS "sortGroup"
			FROM run_stats
			LEFT JOIN puzzle_families ON puzzle_families.id = run_stats."familyId"
			LEFT JOIN standard_bests
				ON standard_bests."familyId" = run_stats."familyId"
				AND standard_bests."difficulty" = run_stats."difficulty"
			LEFT JOIN rotation_bests
				ON rotation_bests."familyId" = run_stats."familyId"
				AND rotation_bests."difficulty" = run_stats."difficulty"
		)
		SELECT *
		FROM combined_stats
		WHERE ${cursorPredicate}
		ORDER BY "sortGroup" ASC, "standardBestTimeSeconds" ASC, "familyId" ASC, "difficulty" ASC
		LIMIT ${limit + 1}
	`);
	const rows = all
		.slice(0, limit)
		.map(
			({
				playerId: rowPlayerId,
				familyId,
				familyName,
				difficulty,
				standardBestTimeSeconds,
				rotationBestTimeSeconds,
				totalCompletions,
				firstCompletedAt,
				lastCompletedAt
			}) => ({
				playerId: rowPlayerId,
				familyId,
				familyName,
				difficulty: difficulty as PuzzleDifficulty,
				standardBestTimeSeconds:
					standardBestTimeSeconds === null ? null : Number(standardBestTimeSeconds),
				rotationBestTimeSeconds:
					rotationBestTimeSeconds === null ? null : Number(rotationBestTimeSeconds),
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
			SELECT
				(
					SELECT COUNT(DISTINCT family_id)
					FROM player_difficulty_completions
					WHERE player_id = ${playerId}
				) AS "puzzlesSolved",
				(
					SELECT COUNT(*)
					FROM puzzle_completion_runs
					WHERE player_id = ${playerId}
				) AS "totalCompletions"
		`)
	]);
	return {
		puzzlesUploaded: uploadedRows[0]?.n ?? 0,
		puzzlesSolved: Number(solvedRows[0]?.puzzlesSolved ?? 0),
		totalCompletions: Number(solvedRows[0]?.totalCompletions ?? 0)
	};
}

export interface LeaderboardIdentityRow {
	id: string;
	name: string;
	avatarUrl: string | null;
}

function fallbackPlayerName(playerId: string): string {
	return `Player ${playerId.slice(0, 8)}`;
}

export async function resolveLeaderboardIdentities(
	db: AppDb,
	playerIds: string[]
): Promise<Map<string, LeaderboardIdentityRow>> {
	const result = new Map<string, LeaderboardIdentityRow>();
	if (playerIds.length === 0) return result;
	for (const playerId of playerIds) {
		result.set(playerId, { id: playerId, name: fallbackPlayerName(playerId), avatarUrl: null });
	}
	for (let i = 0; i < playerIds.length; i += D1_IN_ARRAY_CHUNK_SIZE) {
		const chunk = playerIds.slice(i, i + D1_IN_ARRAY_CHUNK_SIZE);
		const rows = await db
			.select({
				playerId: playerProfiles.playerId,
				displayName: playerProfiles.displayName,
				avatarUrl: playerProfiles.avatarUrl
			})
			.from(playerProfiles)
			.where(inArray(playerProfiles.playerId, chunk))
			.all();
		for (const row of rows) {
			const trimmed = row.displayName?.trim();
			const name =
				trimmed && isPublicSafeDisplayName(trimmed) ? trimmed : fallbackPlayerName(row.playerId);
			result.set(row.playerId, {
				id: row.playerId,
				name,
				avatarUrl: row.avatarUrl ?? null
			});
		}
	}
	return result;
}

const LEADERBOARD_LIMIT = 50;

type CompetitiveMode = 'standard' | 'rotation';

function competitiveResultClass(mode: CompetitiveMode): ResultClass {
	return mode === 'standard' ? 'standard_timed' : 'rotation_timed';
}

interface RawPuzzleLeaderboardRow {
	playerId: string;
	bestTimeSeconds: number;
	achievedAt: number;
}

export async function listPuzzleLeaderboard(
	db: AppDb,
	opts: {
		familyId: string;
		difficulty: PuzzleDifficulty;
		mode: CompetitiveMode;
		viewerPlayerId?: string;
	}
): Promise<{
	entries: Array<{
		rank: number;
		playerId: string;
		bestTimeSeconds: number;
		achievedAt: number;
	}>;
	me?: { rank: number; playerId: string; bestTimeSeconds: number; achievedAt: number };
}> {
	const resultClass = competitiveResultClass(opts.mode);
	const topRows = await db.all<RawPuzzleLeaderboardRow>(sql`
		SELECT
			player_id AS "playerId",
			best_time_seconds AS "bestTimeSeconds",
			achieved_at AS "achievedAt"
		FROM puzzle_best_times
		WHERE family_id = ${opts.familyId}
			AND difficulty = ${opts.difficulty}
			AND result_class = ${resultClass}
		ORDER BY best_time_seconds ASC, achieved_at ASC, player_id ASC
		LIMIT ${LEADERBOARD_LIMIT}
	`);
	const entries = topRows.map((row, index) => ({
		rank: index + 1,
		playerId: row.playerId,
		bestTimeSeconds: Number(row.bestTimeSeconds),
		achievedAt: Number(row.achievedAt)
	}));
	if (opts.viewerPlayerId === undefined) return { entries };
	const viewerInTop = entries.find((entry) => entry.playerId === opts.viewerPlayerId);
	if (viewerInTop) return { entries, me: viewerInTop };
	const viewerRows = await db.all<RawPuzzleLeaderboardRow>(sql`
		SELECT
			player_id AS "playerId",
			best_time_seconds AS "bestTimeSeconds",
			achieved_at AS "achievedAt"
		FROM puzzle_best_times
		WHERE family_id = ${opts.familyId}
			AND difficulty = ${opts.difficulty}
			AND result_class = ${resultClass}
			AND player_id = ${opts.viewerPlayerId}
		LIMIT 1
	`);
	const viewerRow = viewerRows[0];
	if (!viewerRow) return { entries };
	const rankRows = await db.all<{ rank: number }>(sql`
		SELECT COUNT(*) + 1 AS "rank"
		FROM puzzle_best_times
		WHERE family_id = ${opts.familyId}
			AND difficulty = ${opts.difficulty}
			AND result_class = ${resultClass}
			AND (
				best_time_seconds < ${viewerRow.bestTimeSeconds}
				OR (
					best_time_seconds = ${viewerRow.bestTimeSeconds}
					AND achieved_at < ${viewerRow.achievedAt}
				)
				OR (
					best_time_seconds = ${viewerRow.bestTimeSeconds}
					AND achieved_at = ${viewerRow.achievedAt}
					AND player_id < ${opts.viewerPlayerId}
				)
			)
	`);
	return {
		entries,
		me: {
			rank: Number(rankRows[0]?.rank ?? 1),
			playerId: viewerRow.playerId,
			bestTimeSeconds: Number(viewerRow.bestTimeSeconds),
			achievedAt: Number(viewerRow.achievedAt)
		}
	};
}

interface RawOverallScoreRow {
	playerId: string;
	score: number;
	easyClears: number;
	normalClears: number;
	hardClears: number;
	scoreReachedAt: number;
}

function overallAchievementCaseSql(): string {
	return Object.entries(ACHIEVEMENT_POINTS)
		.map(([id, points]) => `WHEN '${id}' THEN ${points}`)
		.join('\n');
}

const OVERALL_SCORE_ORDER_BY = sql`
	score DESC,
	hard_clears DESC,
	normal_clears DESC,
	easy_clears DESC,
	score_reached_at ASC,
	player_id ASC
`;

function overallRankAheadCondition(cAlias: string, vAlias: string): string {
	return `(
		${cAlias}.score > ${vAlias}.score
		OR (
			${cAlias}.score = ${vAlias}.score
			AND ${cAlias}.hard_clears > ${vAlias}.hard_clears
		)
		OR (
			${cAlias}.score = ${vAlias}.score
			AND ${cAlias}.hard_clears = ${vAlias}.hard_clears
			AND ${cAlias}.normal_clears > ${vAlias}.normal_clears
		)
		OR (
			${cAlias}.score = ${vAlias}.score
			AND ${cAlias}.hard_clears = ${vAlias}.hard_clears
			AND ${cAlias}.normal_clears = ${vAlias}.normal_clears
			AND ${cAlias}.easy_clears > ${vAlias}.easy_clears
		)
		OR (
			${cAlias}.score = ${vAlias}.score
			AND ${cAlias}.hard_clears = ${vAlias}.hard_clears
			AND ${cAlias}.normal_clears = ${vAlias}.normal_clears
			AND ${cAlias}.easy_clears = ${vAlias}.easy_clears
			AND ${cAlias}.score_reached_at < ${vAlias}.score_reached_at
		)
		OR (
			${cAlias}.score = ${vAlias}.score
			AND ${cAlias}.hard_clears = ${vAlias}.hard_clears
			AND ${cAlias}.normal_clears = ${vAlias}.normal_clears
			AND ${cAlias}.easy_clears = ${vAlias}.easy_clears
			AND ${cAlias}.score_reached_at = ${vAlias}.score_reached_at
			AND ${cAlias}.player_id < ${vAlias}.player_id
		)
	)`;
}

/**
 * Shared WITH clause computing each player's overall score (unique-clear
 * points + achievement points), clear counts, and score_reached_at. Used
 * by the top-N, viewer-row, and rank-count queries so the score
 * definition cannot drift between them.
 */
function overallScoreCte(): SQL {
	return sql`
	WITH clear_stats AS (
		SELECT
			player_id,
			SUM(CASE difficulty
				WHEN 'easy' THEN ${UNIQUE_CLEAR_POINTS.easy}
				WHEN 'normal' THEN ${UNIQUE_CLEAR_POINTS.normal}
				WHEN 'hard' THEN ${UNIQUE_CLEAR_POINTS.hard}
				ELSE 0
			END) AS clear_score,
			SUM(CASE WHEN difficulty = 'easy' THEN 1 ELSE 0 END) AS easy_clears,
			SUM(CASE WHEN difficulty = 'normal' THEN 1 ELSE 0 END) AS normal_clears,
			SUM(CASE WHEN difficulty = 'hard' THEN 1 ELSE 0 END) AS hard_clears,
			MAX(first_completed_at) AS latest_clear_at
		FROM player_difficulty_completions
		GROUP BY player_id
	),
	achievement_stats AS (
		SELECT
			player_id,
			SUM(CASE achievement_id
				${sql.raw(overallAchievementCaseSql())}
				ELSE 0
			END) AS achievement_score,
			MAX(unlocked_at) AS latest_achievement_at
		FROM player_achievements
		GROUP BY player_id
	),
	all_players AS (
		SELECT player_id FROM clear_stats
		UNION
		SELECT player_id FROM achievement_stats
	),
	combined AS (
		SELECT
			all_players.player_id AS player_id,
			COALESCE(clear_stats.clear_score, 0) + COALESCE(achievement_stats.achievement_score, 0) AS score,
			COALESCE(clear_stats.easy_clears, 0) AS easy_clears,
			COALESCE(clear_stats.normal_clears, 0) AS normal_clears,
			COALESCE(clear_stats.hard_clears, 0) AS hard_clears,
			MAX(
				COALESCE(clear_stats.latest_clear_at, 0),
				COALESCE(achievement_stats.latest_achievement_at, 0)
			) AS score_reached_at
		FROM all_players
		LEFT JOIN clear_stats ON clear_stats.player_id = all_players.player_id
		LEFT JOIN achievement_stats ON achievement_stats.player_id = all_players.player_id
		GROUP BY all_players.player_id
		HAVING score > 0
	)
	`;
}

async function queryTopOverallScoreRows(db: AppDb, limit: number): Promise<RawOverallScoreRow[]> {
	return db.all<RawOverallScoreRow>(sql`
		${overallScoreCte()}
		SELECT
			player_id AS "playerId",
			score AS "score",
			easy_clears AS "easyClears",
			normal_clears AS "normalClears",
			hard_clears AS "hardClears",
			score_reached_at AS "scoreReachedAt"
		FROM combined
		ORDER BY ${OVERALL_SCORE_ORDER_BY}
		LIMIT ${limit}
	`);
}

async function queryOverallScoreRowForPlayer(
	db: AppDb,
	playerId: string
): Promise<RawOverallScoreRow | null> {
	const rows = await db.all<RawOverallScoreRow>(sql`
		${overallScoreCte()}
		SELECT
			player_id AS "playerId",
			score AS "score",
			easy_clears AS "easyClears",
			normal_clears AS "normalClears",
			hard_clears AS "hardClears",
			score_reached_at AS "scoreReachedAt"
		FROM combined
		WHERE player_id = ${playerId}
		LIMIT 1
	`);
	return rows[0] ?? null;
}

async function countOverallRankForPlayer(db: AppDb, playerId: string): Promise<number> {
	const rankAhead = overallRankAheadCondition('c', 'v');
	const rankRows = await db.all<{ rank: number }>(sql`
		${overallScoreCte()}
		SELECT COUNT(*) + 1 AS "rank"
		FROM combined c, combined v
		WHERE v.player_id = ${playerId}
			AND ${sql.raw(rankAhead)}
	`);
	return Number(rankRows[0]?.rank ?? 1);
}

export async function listOverallLeaderboard(
	db: AppDb,
	opts: { viewerPlayerId?: string }
): Promise<{
	entries: Array<{
		rank: number;
		playerId: string;
		score: number;
		easyClears: number;
		normalClears: number;
		hardClears: number;
	}>;
	me?: {
		rank: number;
		playerId: string;
		score: number;
		easyClears: number;
		normalClears: number;
		hardClears: number;
	};
}> {
	const topRows = await queryTopOverallScoreRows(db, LEADERBOARD_LIMIT);
	const entries = topRows.map((row, index) => ({
		rank: index + 1,
		playerId: row.playerId,
		score: Number(row.score),
		easyClears: Number(row.easyClears),
		normalClears: Number(row.normalClears),
		hardClears: Number(row.hardClears)
	}));
	if (opts.viewerPlayerId === undefined) return { entries };
	const viewerInTop = entries.find((entry) => entry.playerId === opts.viewerPlayerId);
	if (viewerInTop) return { entries, me: viewerInTop };
	const viewerRow = await queryOverallScoreRowForPlayer(db, opts.viewerPlayerId);
	if (!viewerRow) return { entries };
	const rank = await countOverallRankForPlayer(db, opts.viewerPlayerId);
	return {
		entries,
		me: {
			rank,
			playerId: viewerRow.playerId,
			score: Number(viewerRow.score),
			easyClears: Number(viewerRow.easyClears),
			normalClears: Number(viewerRow.normalClears),
			hardClears: Number(viewerRow.hardClears)
		}
	};
}

export async function getPlayerProgressionSummary(
	db: AppDb,
	playerId: string
): Promise<{
	score: number;
	rank: number | null;
	easyClears: number;
	normalClears: number;
	hardClears: number;
	achievementsUnlocked: number;
	achievementsTotal: number;
	masteryEarned: number;
}> {
	const scoredRow = await queryOverallScoreRowForPlayer(db, playerId);
	// Score and clear counts come from the shared overall-score CTE so the
	// progression summary cannot drift from the leaderboard's score definition.
	// The CTE's HAVING score > 0 means scoredRow is null exactly when the
	// player has no score — which also gates the rank query below.
	const counts = await db.all<{ achievementsUnlocked: number; masteryEarned: number }>(sql`
		SELECT
			(
				SELECT COUNT(*) FROM player_achievements
				WHERE player_id = ${playerId}
			) AS "achievementsUnlocked",
			(
				SELECT COUNT(*) FROM player_variant_mastery
				WHERE player_id = ${playerId}
			) AS "masteryEarned"
	`);
	const row = counts[0];
	return {
		score: Number(scoredRow?.score ?? 0),
		rank: scoredRow ? await countOverallRankForPlayer(db, playerId) : null,
		easyClears: Number(scoredRow?.easyClears ?? 0),
		normalClears: Number(scoredRow?.normalClears ?? 0),
		hardClears: Number(scoredRow?.hardClears ?? 0),
		achievementsUnlocked: Number(row?.achievementsUnlocked ?? 0),
		achievementsTotal: ACHIEVEMENT_COUNT,
		masteryEarned: Number(row?.masteryEarned ?? 0)
	};
}

export interface CompletionAwardsResult {
	clearPoints?: number;
	achievements?: AchievementId[];
	mastery?: MasteryBadge[];
	personalBest?: { bestTimeSeconds: number; isNew: boolean };
	puzzleRank?: number;
}

export async function deriveCompletionAwards(
	db: AppDb,
	playerId: string,
	input: {
		puzzleId: string;
		familyId: string;
		difficulty: PuzzleDifficulty;
		resultClass: ResultClass;
		completedAt: number;
		elapsedActiveSeconds: number | null;
	},
	newAchievements: AchievementId[],
	wasRecorded: boolean,
	mutations?: CompletionMutationFacts
): Promise<CompletionAwardsResult> {
	if (!wasRecorded) {
		const awards: CompletionAwardsResult = {};
		if (newAchievements.length > 0) awards.achievements = newAchievements;
		return awards;
	}
	const awards: CompletionAwardsResult = {};
	if (mutations?.firstClearInserted) {
		awards.clearPoints = UNIQUE_CLEAR_POINTS[input.difficulty];
	}
	if (newAchievements.length > 0) awards.achievements = newAchievements;
	if (mutations && mutations.masteryInserted.length > 0) {
		awards.mastery = mutations.masteryInserted;
	}
	const improvedStandard =
		input.resultClass === 'standard_timed' && mutations?.personalBestImproved.standard;
	const improvedRotation =
		input.resultClass === 'rotation_timed' && mutations?.personalBestImproved.rotation;
	if ((improvedStandard || improvedRotation) && input.elapsedActiveSeconds !== null) {
		const mode: CompetitiveMode = input.resultClass === 'standard_timed' ? 'standard' : 'rotation';
		awards.personalBest = {
			bestTimeSeconds: input.elapsedActiveSeconds,
			isNew: true
		};
		const board = await listPuzzleLeaderboard(db, {
			familyId: input.familyId,
			difficulty: input.difficulty,
			mode,
			viewerPlayerId: playerId
		});
		if (board.me) awards.puzzleRank = board.me.rank;
	}
	return awards;
}
