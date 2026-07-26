import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import type { ResultClass, TimingQuality } from '@perseus/types';
import * as schema from '../schema';
import {
	playerCompletionUsage,
	puzzleCompletionRuns,
	puzzleDeletionTombstones,
	puzzleStats
} from '../schema';
import type {
	CompletionWriteExecutor,
	LegacyCompletionWrite,
	LegacyCompletionWriteExecution,
	StoredCompletionFacts,
	VersionedCompletionWrite,
	VersionedCompletionWriteExecution
} from '../completion-writes';
import { MAX_RETAINED_COMPLETION_RUNS } from '../completion-writes';

interface D1Env {
	DB: D1Database;
}

export type D1AppDb = DrizzleD1Database<typeof schema>;

export function createD1Db(env: D1Env): D1AppDb {
	// Migrations live in packages/shared/drizzle and are applied by:
	//   - CI:  the "Apply D1 migrations" step in deploy-infrastructure.yml
	//          (runs `bun run db:migrate` after Pulumi provisions the DB), or
	//   - manually: `bun run db:migrate` (remote) / `db:migrate:local` (dev).
	return drizzle(env.DB, { schema });
}

const COMPLETION_DEDUPE_WINDOW_MS = 30_000;

function toStoredFacts(row: {
	puzzleId: string;
	resultClass: string;
	timingQuality: string;
	elapsedActiveSeconds: number | null;
	completedAt: number;
}): StoredCompletionFacts {
	return {
		puzzleId: row.puzzleId,
		resultClass: row.resultClass as ResultClass,
		timingQuality: row.timingQuality as TimingQuality,
		elapsedActiveSeconds: row.elapsedActiveSeconds,
		completedAt: row.completedAt
	};
}

export function createD1CompletionWriteExecutor(
	db: D1AppDb,
	retainedRunLimit = MAX_RETAINED_COMPLETION_RUNS
): CompletionWriteExecutor {
	if (
		!Number.isInteger(retainedRunLimit) ||
		retainedRunLimit <= 0 ||
		retainedRunLimit > MAX_RETAINED_COMPLETION_RUNS
	) {
		throw new RangeError(
			`retainedRunLimit must be a positive integer no greater than ${MAX_RETAINED_COMPLETION_RUNS}`
		);
	}

	return {
		async write(input: VersionedCompletionWrite): Promise<VersionedCompletionWriteExecution> {
			const elapsedMatches =
				input.elapsedActiveSeconds === null
					? isNull(puzzleCompletionRuns.elapsedActiveSeconds)
					: eq(puzzleCompletionRuns.elapsedActiveSeconds, input.elapsedActiveSeconds);
			const insertRun = db
				.insert(puzzleCompletionRuns)
				.select(
					db
						.select({
							playerId: sql<string>`${input.playerId}`.as('player_id'),
							runId: sql<string>`${input.runId}`.as('run_id'),
							puzzleId: sql<string>`${input.puzzleId}`.as('puzzle_id'),
							resultClass: sql<ResultClass>`${input.resultClass}`.as('result_class'),
							timingQuality: sql<TimingQuality>`${input.timingQuality}`.as('timing_quality'),
							elapsedActiveSeconds:
								input.elapsedActiveSeconds === null
									? sql<null>`NULL`.as('elapsed_active_seconds')
									: sql<number>`${input.elapsedActiveSeconds}`.as('elapsed_active_seconds'),
							completedAt: sql<number>`${input.receivedAt}`.as('completed_at')
						})
						.from(sql`(SELECT 1)`).where(sql`
							NOT EXISTS (
								SELECT 1 FROM puzzle_deletion_tombstones WHERE puzzle_id = ${input.puzzleId}
							)
							AND (
								EXISTS (
									SELECT 1 FROM puzzle_completion_runs
									WHERE player_id = ${input.playerId} AND run_id = ${input.runId}
								)
								OR COALESCE(
									(
										SELECT retained_runs FROM player_completion_usage
										WHERE player_id = ${input.playerId}
									),
									0
								) < ${retainedRunLimit}
							)
						`)
				)
				.onConflictDoNothing({
					target: [puzzleCompletionRuns.playerId, puzzleCompletionRuns.runId]
				});
			const readTombstone = db
				.select({ puzzleId: puzzleDeletionTombstones.puzzleId })
				.from(puzzleDeletionTombstones)
				.where(eq(puzzleDeletionTombstones.puzzleId, input.puzzleId))
				.limit(1);
			const readStored = db
				.select({
					puzzleId: puzzleCompletionRuns.puzzleId,
					resultClass: puzzleCompletionRuns.resultClass,
					timingQuality: puzzleCompletionRuns.timingQuality,
					elapsedActiveSeconds: puzzleCompletionRuns.elapsedActiveSeconds,
					completedAt: puzzleCompletionRuns.completedAt
				})
				.from(puzzleCompletionRuns)
				.where(
					and(
						eq(puzzleCompletionRuns.playerId, input.playerId),
						eq(puzzleCompletionRuns.runId, input.runId)
					)
				)
				.limit(1);
			const readUsage = db
				.select({ retainedRuns: playerCompletionUsage.retainedRuns })
				.from(playerCompletionUsage)
				.where(eq(playerCompletionUsage.playerId, input.playerId))
				.limit(1);
			const upsertBest = db
				.insert(puzzleStats)
				.select(
					db
						.select({
							playerId: puzzleCompletionRuns.playerId,
							puzzleId: puzzleCompletionRuns.puzzleId,
							bestTimeSeconds: sql<number>`${puzzleCompletionRuns.elapsedActiveSeconds}`.as(
								'best_time_seconds'
							),
							totalCompletions: sql<number>`0`.as('total_completions'),
							firstCompletedAt: puzzleCompletionRuns.completedAt,
							lastCompletedAt: puzzleCompletionRuns.completedAt
						})
						.from(puzzleCompletionRuns)
						.where(
							and(
								eq(puzzleCompletionRuns.playerId, input.playerId),
								eq(puzzleCompletionRuns.runId, input.runId),
								eq(puzzleCompletionRuns.puzzleId, input.puzzleId),
								eq(puzzleCompletionRuns.resultClass, input.resultClass),
								eq(puzzleCompletionRuns.timingQuality, input.timingQuality),
								elapsedMatches,
								eq(puzzleCompletionRuns.resultClass, 'standard_timed'),
								eq(puzzleCompletionRuns.timingQuality, 'known'),
								isNotNull(puzzleCompletionRuns.elapsedActiveSeconds),
								sql`NOT EXISTS (
									SELECT 1 FROM puzzle_deletion_tombstones
									WHERE puzzle_id = ${input.puzzleId}
								)`
							)
						)
				)
				.onConflictDoUpdate({
					target: [puzzleStats.playerId, puzzleStats.puzzleId],
					set: {
						bestTimeSeconds: sql`MIN(${puzzleStats.bestTimeSeconds}, excluded.best_time_seconds)`
					}
				});

			const [insertResult, tombstoneRows, storedRows, usageRows] = await db.batch([
				insertRun,
				readTombstone,
				readStored,
				readUsage,
				upsertBest
			]);
			if (tombstoneRows.length > 0) return { status: 'tombstoned' };
			if (storedRows[0]) {
				return {
					status: 'stored',
					stored: toStoredFacts(storedRows[0]),
					inserted: insertResult.meta.changes > 0
				};
			}
			if ((usageRows[0]?.retainedRuns ?? 0) >= retainedRunLimit) {
				return { status: 'quota_exceeded' };
			}
			throw new Error('Completion ledger write returned no stored row without tombstone or quota');
		},

		async writeLegacy(input: LegacyCompletionWrite): Promise<LegacyCompletionWriteExecution> {
			const upsertStats = db
				.insert(puzzleStats)
				.select(
					db
						.select({
							playerId: sql<string>`${input.playerId}`.as('player_id'),
							puzzleId: sql<string>`${input.puzzleId}`.as('puzzle_id'),
							bestTimeSeconds: sql<number>`${input.timeSeconds}`.as('best_time_seconds'),
							totalCompletions: sql<number>`1`.as('total_completions'),
							firstCompletedAt: sql<number>`${input.receivedAt}`.as('first_completed_at'),
							lastCompletedAt: sql<number>`${input.receivedAt}`.as('last_completed_at')
						})
						.from(sql`(SELECT 1)`).where(sql`
							NOT EXISTS (
								SELECT 1 FROM puzzle_deletion_tombstones WHERE puzzle_id = ${input.puzzleId}
							)
						`)
				)
				.onConflictDoUpdate({
					target: [puzzleStats.playerId, puzzleStats.puzzleId],
					set: {
						bestTimeSeconds: sql`MIN(${puzzleStats.bestTimeSeconds}, excluded.best_time_seconds)`,
						totalCompletions: sql`CASE WHEN excluded.last_completed_at - ${puzzleStats.lastCompletedAt} >= ${COMPLETION_DEDUPE_WINDOW_MS} THEN ${puzzleStats.totalCompletions} + 1 ELSE ${puzzleStats.totalCompletions} END`,
						lastCompletedAt: sql`CASE WHEN excluded.last_completed_at - ${puzzleStats.lastCompletedAt} >= ${COMPLETION_DEDUPE_WINDOW_MS} THEN excluded.last_completed_at ELSE ${puzzleStats.lastCompletedAt} END`
					}
				});
			const readTombstone = db
				.select({ puzzleId: puzzleDeletionTombstones.puzzleId })
				.from(puzzleDeletionTombstones)
				.where(eq(puzzleDeletionTombstones.puzzleId, input.puzzleId))
				.limit(1);

			const [upsertResult, tombstoneRows] = await db.batch([upsertStats, readTombstone]);
			if (tombstoneRows.length > 0) return { status: 'tombstoned' };
			if (upsertResult.meta.changes === 1) return { status: 'recorded' };
			throw new Error('Legacy completion write changed no rows without tombstone');
		},

		async deletePuzzleCompletionData(puzzleId: string) {
			await db.batch([
				db.delete(puzzleStats).where(eq(puzzleStats.puzzleId, puzzleId)),
				db.delete(puzzleCompletionRuns).where(eq(puzzleCompletionRuns.puzzleId, puzzleId))
			]);
		}
	};
}
