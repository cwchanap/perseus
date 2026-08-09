import { Database } from 'bun:sqlite';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../schema';
import {
	playerCompletionUsage,
	puzzleCompletionRuns,
	puzzleDeletionTombstones,
	puzzleStats
} from '../schema';
import {
	completionFactsMatch,
	isCanonicalBest,
	MAX_RETAINED_COMPLETION_RUNS,
	type CompletionWriteExecutor,
	type StoredCompletionFacts,
	type VersionedCompletionWrite,
	type VersionedCompletionWriteExecution
} from '../completion-writes';
import type { AppDb } from '../types';

export interface BunDbContext {
	db: AppDb;
	completionWrites: CompletionWriteExecutor;
	close(): void;
}

export function createBunDbContext(
	dataDir: string,
	retainedRunLimit = MAX_RETAINED_COMPLETION_RUNS
): BunDbContext {
	if (
		!Number.isInteger(retainedRunLimit) ||
		retainedRunLimit <= 0 ||
		retainedRunLimit > MAX_RETAINED_COMPLETION_RUNS
	) {
		throw new RangeError(
			`retainedRunLimit must be a positive integer no greater than ${MAX_RETAINED_COMPLETION_RUNS}`
		);
	}

	mkdirSync(dataDir, { recursive: true });
	const sqlite = new Database(join(dataDir, 'perseus.db'));
	const db = drizzle(sqlite, { schema });
	const here = dirname(fileURLToPath(import.meta.url));
	// Two layouts resolve to the drizzle migrations folder:
	//   - Bundled (apps/api/dist/index.js): build:bun copies migrations to
	//     dist/drizzle, which sits next to the bundle.
	//   - Unbundled dev (this source file): migrations live at
	//     packages/shared/drizzle, two levels up from packages/shared/src/drivers.
	const bundledMigrations = join(here, 'drizzle');
	const sourceMigrations = join(here, '..', '..', 'drizzle');
	const migrationsFolder = existsSync(bundledMigrations) ? bundledMigrations : sourceMigrations;
	migrate(db, { migrationsFolder });

	const writeVersioned = (input: VersionedCompletionWrite): VersionedCompletionWriteExecution => {
		const tombstone = db
			.select({ puzzleId: puzzleDeletionTombstones.puzzleId })
			.from(puzzleDeletionTombstones)
			.where(eq(puzzleDeletionTombstones.puzzleId, input.puzzleId))
			.get();
		if (tombstone) return { status: 'tombstoned' };

		let row = db
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
			.get();
		let inserted = false;
		if (!row) {
			const usage = db
				.select({ retainedRuns: playerCompletionUsage.retainedRuns })
				.from(playerCompletionUsage)
				.where(eq(playerCompletionUsage.playerId, input.playerId))
				.get();
			if ((usage?.retainedRuns ?? 0) >= retainedRunLimit) {
				return { status: 'quota_exceeded' };
			}

			const insertedRow = db
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
				})
				.returning({
					puzzleId: puzzleCompletionRuns.puzzleId,
					resultClass: puzzleCompletionRuns.resultClass,
					timingQuality: puzzleCompletionRuns.timingQuality,
					elapsedActiveSeconds: puzzleCompletionRuns.elapsedActiveSeconds,
					completedAt: puzzleCompletionRuns.completedAt
				})
				.get();
			if (!insertedRow) {
				throw new Error('Completion ledger write did not return a stored row');
			}
			row = insertedRow;
			inserted = true;
		}
		const stored: StoredCompletionFacts = {
			puzzleId: row.puzzleId,
			resultClass: row.resultClass as StoredCompletionFacts['resultClass'],
			timingQuality: row.timingQuality as StoredCompletionFacts['timingQuality'],
			elapsedActiveSeconds: row.elapsedActiveSeconds,
			completedAt: row.completedAt
		};
		if (
			completionFactsMatch(input, stored) &&
			isCanonicalBest(input) &&
			stored.elapsedActiveSeconds !== null
		) {
			db.insert(puzzleStats)
				.values({
					playerId: input.playerId,
					puzzleId: stored.puzzleId,
					bestTimeSeconds: stored.elapsedActiveSeconds,
					totalCompletions: 0,
					firstCompletedAt: stored.completedAt,
					lastCompletedAt: stored.completedAt
				})
				.onConflictDoUpdate({
					target: [puzzleStats.playerId, puzzleStats.puzzleId],
					set: {
						bestTimeSeconds: sql`MIN(${puzzleStats.bestTimeSeconds}, excluded.best_time_seconds)`
					}
				})
				.run();
		}

		return {
			status: 'stored' as const,
			stored,
			inserted
		};
	};
	const writeVersionedTransaction = sqlite.transaction(writeVersioned);
	const finishPuzzleDeletionTransaction = sqlite.transaction((puzzleId: string) => {
		db.delete(puzzleStats).where(eq(puzzleStats.puzzleId, puzzleId)).run();
		db.delete(puzzleCompletionRuns).where(eq(puzzleCompletionRuns.puzzleId, puzzleId)).run();
	});
	const completionWrites: CompletionWriteExecutor = {
		async write(input) {
			return writeVersionedTransaction.immediate(input);
		},
		async beginPuzzleDeletion(puzzleId, deletedAt) {
			db.insert(puzzleDeletionTombstones)
				.values({ puzzleId, deletedAt })
				.onConflictDoNothing({ target: puzzleDeletionTombstones.puzzleId })
				.run();
		},

		async finishPuzzleDeletion(puzzleId) {
			finishPuzzleDeletionTransaction.immediate(puzzleId);
		},

		async isPuzzleTombstoned(puzzleId) {
			return (
				db
					.select({ puzzleId: puzzleDeletionTombstones.puzzleId })
					.from(puzzleDeletionTombstones)
					.where(eq(puzzleDeletionTombstones.puzzleId, puzzleId))
					.get() !== undefined
			);
		}
	};

	return {
		db: db as unknown as AppDb,
		completionWrites,
		close() {
			sqlite.close();
		}
	};
}

export function createBunDb(dataDir: string): AppDb {
	return createBunDbContext(dataDir).db;
}
