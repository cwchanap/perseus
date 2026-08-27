import { and, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import type { ResultClass } from '@perseus/types';
import * as schema from '../schema';
import {
	playerCompletionUsage,
	playerDifficultyCompletions,
	playerVariantMastery,
	puzzleBestTimes,
	puzzleCompletionRuns,
	puzzleDeletionTombstones
} from '../schema';
import type {
	CompletionWriteExecutor,
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

function toStoredFacts(row: {
	puzzleId: string;
	familyId: string;
	difficulty: string;
	resultClass: string;
	elapsedActiveSeconds: number | null;
	hintsUsed: number;
	incorrectAttempts: number;
	completedAt: number;
}): StoredCompletionFacts {
	return {
		puzzleId: row.puzzleId,
		familyId: row.familyId,
		difficulty: row.difficulty as StoredCompletionFacts['difficulty'],
		resultClass: row.resultClass as ResultClass,
		elapsedActiveSeconds: row.elapsedActiveSeconds,
		hintsUsed: row.hintsUsed,
		incorrectAttempts: row.incorrectAttempts,
		completedAt: row.completedAt
	};
}

function runFactsMatchWhere(input: VersionedCompletionWrite): SQL {
	const elapsedMatches =
		input.elapsedActiveSeconds === null
			? isNull(puzzleCompletionRuns.elapsedActiveSeconds)
			: eq(puzzleCompletionRuns.elapsedActiveSeconds, input.elapsedActiveSeconds);
	return and(
		eq(puzzleCompletionRuns.playerId, input.playerId),
		eq(puzzleCompletionRuns.runId, input.runId),
		eq(puzzleCompletionRuns.puzzleId, input.puzzleId),
		eq(puzzleCompletionRuns.familyId, input.familyId),
		eq(puzzleCompletionRuns.difficulty, input.difficulty),
		eq(puzzleCompletionRuns.resultClass, input.resultClass),
		elapsedMatches,
		eq(puzzleCompletionRuns.hintsUsed, input.hintsUsed),
		eq(puzzleCompletionRuns.incorrectAttempts, input.incorrectAttempts),
		sql`NOT EXISTS (
			SELECT 1 FROM puzzle_deletion_tombstones
			WHERE puzzle_id = ${input.puzzleId}
		)`
	)!;
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
			const insertRun = db
				.insert(puzzleCompletionRuns)
				.select(
					db
						.select({
							playerId: sql<string>`${input.playerId}`.as('player_id'),
							runId: sql<string>`${input.runId}`.as('run_id'),
							puzzleId: sql<string>`${input.puzzleId}`.as('puzzle_id'),
							familyId: sql<string>`${input.familyId}`.as('family_id'),
							difficulty: sql<string>`${input.difficulty}`.as('difficulty'),
							resultClass: sql<ResultClass>`${input.resultClass}`.as('result_class'),
							elapsedActiveSeconds:
								input.elapsedActiveSeconds === null
									? sql<null>`NULL`.as('elapsed_active_seconds')
									: sql<number>`${input.elapsedActiveSeconds}`.as('elapsed_active_seconds'),
							hintsUsed: sql<number>`${input.hintsUsed}`.as('hints_used'),
							incorrectAttempts: sql<number>`${input.incorrectAttempts}`.as('incorrect_attempts'),
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
					familyId: puzzleCompletionRuns.familyId,
					difficulty: puzzleCompletionRuns.difficulty,
					resultClass: puzzleCompletionRuns.resultClass,
					elapsedActiveSeconds: puzzleCompletionRuns.elapsedActiveSeconds,
					hintsUsed: puzzleCompletionRuns.hintsUsed,
					incorrectAttempts: puzzleCompletionRuns.incorrectAttempts,
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
			const insertFirstClear = db
				.insert(playerDifficultyCompletions)
				.select(
					db
						.select({
							playerId: puzzleCompletionRuns.playerId,
							familyId: puzzleCompletionRuns.familyId,
							difficulty: puzzleCompletionRuns.difficulty,
							firstCompletedAt: puzzleCompletionRuns.completedAt
						})
						.from(puzzleCompletionRuns)
						.where(runFactsMatchWhere(input))
				)
				.onConflictDoNothing({
					target: [
						playerDifficultyCompletions.playerId,
						playerDifficultyCompletions.familyId,
						playerDifficultyCompletions.difficulty
					]
				});
			const upsertStandardBest = db
				.insert(puzzleBestTimes)
				.select(
					db
						.select({
							playerId: puzzleCompletionRuns.playerId,
							puzzleId: puzzleCompletionRuns.puzzleId,
							familyId: puzzleCompletionRuns.familyId,
							difficulty: puzzleCompletionRuns.difficulty,
							resultClass: sql<'standard_timed'>`'standard_timed'`.as('result_class'),
							bestTimeSeconds: sql<number>`${puzzleCompletionRuns.elapsedActiveSeconds}`.as(
								'best_time_seconds'
							),
							achievedAt: puzzleCompletionRuns.completedAt
						})
						.from(puzzleCompletionRuns)
						.where(
							and(
								runFactsMatchWhere(input),
								eq(puzzleCompletionRuns.resultClass, 'standard_timed'),
								isNotNull(puzzleCompletionRuns.elapsedActiveSeconds)
							)
						)
				)
				.onConflictDoUpdate({
					target: [puzzleBestTimes.playerId, puzzleBestTimes.puzzleId, puzzleBestTimes.resultClass],
					set: {
						bestTimeSeconds: sql`MIN(${puzzleBestTimes.bestTimeSeconds}, excluded.best_time_seconds)`,
						achievedAt: sql`CASE
							WHEN excluded.best_time_seconds < ${puzzleBestTimes.bestTimeSeconds}
								THEN excluded.achieved_at
							ELSE ${puzzleBestTimes.achievedAt}
						END`
					},
					setWhere: sql`excluded.best_time_seconds < ${puzzleBestTimes.bestTimeSeconds}`
				});
			const upsertRotationBest = db
				.insert(puzzleBestTimes)
				.select(
					db
						.select({
							playerId: puzzleCompletionRuns.playerId,
							puzzleId: puzzleCompletionRuns.puzzleId,
							familyId: puzzleCompletionRuns.familyId,
							difficulty: puzzleCompletionRuns.difficulty,
							resultClass: sql<'rotation_timed'>`'rotation_timed'`.as('result_class'),
							bestTimeSeconds: sql<number>`${puzzleCompletionRuns.elapsedActiveSeconds}`.as(
								'best_time_seconds'
							),
							achievedAt: puzzleCompletionRuns.completedAt
						})
						.from(puzzleCompletionRuns)
						.where(
							and(
								runFactsMatchWhere(input),
								eq(puzzleCompletionRuns.resultClass, 'rotation_timed'),
								isNotNull(puzzleCompletionRuns.elapsedActiveSeconds)
							)
						)
				)
				.onConflictDoUpdate({
					target: [puzzleBestTimes.playerId, puzzleBestTimes.puzzleId, puzzleBestTimes.resultClass],
					set: {
						bestTimeSeconds: sql`MIN(${puzzleBestTimes.bestTimeSeconds}, excluded.best_time_seconds)`,
						achievedAt: sql`CASE
							WHEN excluded.best_time_seconds < ${puzzleBestTimes.bestTimeSeconds}
								THEN excluded.achieved_at
							ELSE ${puzzleBestTimes.achievedAt}
						END`
					},
					setWhere: sql`excluded.best_time_seconds < ${puzzleBestTimes.bestTimeSeconds}`
				});
			const insertHintlessMastery = db
				.insert(playerVariantMastery)
				.select(
					db
						.select({
							playerId: puzzleCompletionRuns.playerId,
							puzzleId: puzzleCompletionRuns.puzzleId,
							badge: sql<'hintless'>`'hintless'`.as('badge'),
							earnedAt: puzzleCompletionRuns.completedAt
						})
						.from(puzzleCompletionRuns)
						.where(and(runFactsMatchWhere(input), eq(puzzleCompletionRuns.hintsUsed, 0)))
				)
				.onConflictDoNothing({
					target: [
						playerVariantMastery.playerId,
						playerVariantMastery.puzzleId,
						playerVariantMastery.badge
					]
				});
			const insertFlawlessMastery = db
				.insert(playerVariantMastery)
				.select(
					db
						.select({
							playerId: puzzleCompletionRuns.playerId,
							puzzleId: puzzleCompletionRuns.puzzleId,
							badge: sql<'flawless'>`'flawless'`.as('badge'),
							earnedAt: puzzleCompletionRuns.completedAt
						})
						.from(puzzleCompletionRuns)
						.where(and(runFactsMatchWhere(input), eq(puzzleCompletionRuns.incorrectAttempts, 0)))
				)
				.onConflictDoNothing({
					target: [
						playerVariantMastery.playerId,
						playerVariantMastery.puzzleId,
						playerVariantMastery.badge
					]
				});
			const insertRotationClearMastery = db
				.insert(playerVariantMastery)
				.select(
					db
						.select({
							playerId: puzzleCompletionRuns.playerId,
							puzzleId: puzzleCompletionRuns.puzzleId,
							badge: sql<'rotation_clear'>`'rotation_clear'`.as('badge'),
							earnedAt: puzzleCompletionRuns.completedAt
						})
						.from(puzzleCompletionRuns)
						.where(
							and(runFactsMatchWhere(input), eq(puzzleCompletionRuns.resultClass, 'rotation_timed'))
						)
				)
				.onConflictDoNothing({
					target: [
						playerVariantMastery.playerId,
						playerVariantMastery.puzzleId,
						playerVariantMastery.badge
					]
				});

			const [
				insertResult,
				tombstoneRows,
				storedRows,
				usageRows,
				firstClearResult,
				standardBestResult,
				rotationBestResult,
				hintlessMasteryResult,
				flawlessMasteryResult,
				rotationClearMasteryResult
			] = await db.batch([
				insertRun,
				readTombstone,
				readStored,
				readUsage,
				insertFirstClear,
				upsertStandardBest,
				upsertRotationBest,
				insertHintlessMastery,
				insertFlawlessMastery,
				insertRotationClearMastery
			]);
			if (tombstoneRows.length > 0) return { status: 'tombstoned' };
			if (storedRows[0]) {
				const masteryInserted: Array<'hintless' | 'flawless' | 'rotation_clear'> = [];
				if (hintlessMasteryResult.meta.changes > 0) masteryInserted.push('hintless');
				if (flawlessMasteryResult.meta.changes > 0) masteryInserted.push('flawless');
				if (rotationClearMasteryResult.meta.changes > 0) {
					masteryInserted.push('rotation_clear');
				}
				return {
					status: 'stored',
					stored: toStoredFacts(storedRows[0]),
					inserted: insertResult.meta.changes > 0,
					mutations: {
						firstClearInserted: firstClearResult.meta.changes > 0,
						masteryInserted,
						personalBestImproved: {
							standard: standardBestResult.meta.changes > 0,
							rotation: rotationBestResult.meta.changes > 0
						}
					}
				};
			}
			if ((usageRows[0]?.retainedRuns ?? 0) >= retainedRunLimit) {
				return { status: 'quota_exceeded' };
			}
			throw new Error('Completion ledger write returned no stored row without tombstone or quota');
		},

		async beginPuzzleDeletion(puzzleId: string, deletedAt: number) {
			await db
				.insert(puzzleDeletionTombstones)
				.values({ puzzleId, deletedAt })
				.onConflictDoNothing({ target: puzzleDeletionTombstones.puzzleId })
				.run();
		},

		async finishPuzzleDeletion(puzzleId: string) {
			await db.batch([
				db.delete(puzzleBestTimes).where(eq(puzzleBestTimes.puzzleId, puzzleId)),
				db.delete(playerVariantMastery).where(eq(playerVariantMastery.puzzleId, puzzleId)),
				db.delete(puzzleCompletionRuns).where(eq(puzzleCompletionRuns.puzzleId, puzzleId))
			]);
		},

		async finishFamilyFirstClears(familyId: string) {
			await db
				.delete(playerDifficultyCompletions)
				.where(eq(playerDifficultyCompletions.familyId, familyId));
		},

		async isPuzzleTombstoned(puzzleId: string) {
			const row = await db
				.select({ puzzleId: puzzleDeletionTombstones.puzzleId })
				.from(puzzleDeletionTombstones)
				.where(eq(puzzleDeletionTombstones.puzzleId, puzzleId))
				.limit(1);
			return row.length > 0;
		}
	};
}
