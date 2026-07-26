import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import type { ResultClass, TimingQuality } from '@perseus/types';
import * as schema from '../schema';
import { puzzleCompletionRuns, puzzleStats } from '../schema';
import type {
	CompletionWriteExecutor,
	StoredCompletionFacts,
	VersionedCompletionWrite
} from '../completion-writes';

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

export function createD1CompletionWriteExecutor(db: D1AppDb): CompletionWriteExecutor {
	return {
		async write(input: VersionedCompletionWrite) {
			const elapsedMatches =
				input.elapsedActiveSeconds === null
					? isNull(puzzleCompletionRuns.elapsedActiveSeconds)
					: eq(puzzleCompletionRuns.elapsedActiveSeconds, input.elapsedActiveSeconds);
			const insertRun = db
				.insert(puzzleCompletionRuns)
				.values({
					playerId: input.playerId,
					runId: input.runId,
					puzzleId: input.puzzleId,
					resultClass: input.resultClass,
					timingQuality: input.timingQuality,
					elapsedActiveSeconds: input.elapsedActiveSeconds,
					completedAt: input.receivedAt
				})
				.onConflictDoNothing({
					target: [puzzleCompletionRuns.playerId, puzzleCompletionRuns.runId]
				});
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
								isNotNull(puzzleCompletionRuns.elapsedActiveSeconds)
							)
						)
				)
				.onConflictDoUpdate({
					target: [puzzleStats.playerId, puzzleStats.puzzleId],
					set: {
						bestTimeSeconds: sql`MIN(${puzzleStats.bestTimeSeconds}, excluded.best_time_seconds)`
					}
				});

			const [insertResult, storedRows] = await db.batch([insertRun, readStored, upsertBest]);
			const row = storedRows[0];
			if (!row) {
				throw new Error('Completion ledger write did not return a stored row');
			}
			const stored: StoredCompletionFacts = {
				puzzleId: row.puzzleId,
				resultClass: row.resultClass as ResultClass,
				timingQuality: row.timingQuality as TimingQuality,
				elapsedActiveSeconds: row.elapsedActiveSeconds,
				completedAt: row.completedAt
			};
			return {
				stored,
				inserted: insertResult.meta.changes === 1
			};
		},

		async deletePuzzleCompletionData(puzzleId: string) {
			await db.batch([
				db.delete(puzzleStats).where(eq(puzzleStats.puzzleId, puzzleId)),
				db.delete(puzzleCompletionRuns).where(eq(puzzleCompletionRuns.puzzleId, puzzleId))
			]);
		}
	};
}
