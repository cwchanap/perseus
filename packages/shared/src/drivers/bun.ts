import { Database } from 'bun:sqlite';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../schema';
import { puzzleCompletionRuns, puzzleDeletionTombstones, puzzleStats } from '../schema';
import {
	completionFactsMatch,
	isCanonicalBest,
	type CompletionWriteExecutor,
	type LegacyCompletionWrite,
	type LegacyCompletionWriteExecution,
	type StoredCompletionFacts,
	type VersionedCompletionWrite
} from '../completion-writes';
import type { AppDb } from '../types';

export interface BunDbContext {
	db: AppDb;
	completionWrites: CompletionWriteExecutor;
	close(): void;
}

const COMPLETION_DEDUPE_WINDOW_MS = 30_000;

export function createBunDbContext(dataDir: string): BunDbContext {
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

	const writeCompletion = sqlite.transaction((input: VersionedCompletionWrite) => {
		const inserted = db
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
			.returning({ runId: puzzleCompletionRuns.runId })
			.get();
		const row = db
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
		if (!row) {
			throw new Error('Completion ledger write did not return a stored row');
		}
		const stored: StoredCompletionFacts = {
			puzzleId: row.puzzleId,
			resultClass: row.resultClass as StoredCompletionFacts['resultClass'],
			timingQuality: row.timingQuality as StoredCompletionFacts['timingQuality'],
			elapsedActiveSeconds: row.elapsedActiveSeconds,
			completedAt: row.completedAt
		};
		const bestTimeSeconds = input.elapsedActiveSeconds;

		if (completionFactsMatch(input, stored) && isCanonicalBest(input) && bestTimeSeconds !== null) {
			db.insert(puzzleStats)
				.values({
					playerId: input.playerId,
					puzzleId: stored.puzzleId,
					bestTimeSeconds,
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
			inserted: inserted !== undefined
		};
	});
	const writeLegacyCompletion = sqlite.transaction(
		(input: LegacyCompletionWrite): LegacyCompletionWriteExecution => {
			const tombstone = db
				.select({ puzzleId: puzzleDeletionTombstones.puzzleId })
				.from(puzzleDeletionTombstones)
				.where(eq(puzzleDeletionTombstones.puzzleId, input.puzzleId))
				.get();
			if (tombstone) return { status: 'tombstoned' };

			const result = db
				.insert(puzzleStats)
				.values({
					playerId: input.playerId,
					puzzleId: input.puzzleId,
					bestTimeSeconds: input.timeSeconds,
					totalCompletions: 1,
					firstCompletedAt: input.receivedAt,
					lastCompletedAt: input.receivedAt
				})
				.onConflictDoUpdate({
					target: [puzzleStats.playerId, puzzleStats.puzzleId],
					set: {
						bestTimeSeconds: sql`MIN(${puzzleStats.bestTimeSeconds}, excluded.best_time_seconds)`,
						totalCompletions: sql`CASE WHEN excluded.last_completed_at - ${puzzleStats.lastCompletedAt} >= ${COMPLETION_DEDUPE_WINDOW_MS} THEN ${puzzleStats.totalCompletions} + 1 ELSE ${puzzleStats.totalCompletions} END`,
						lastCompletedAt: sql`CASE WHEN excluded.last_completed_at - ${puzzleStats.lastCompletedAt} >= ${COMPLETION_DEDUPE_WINDOW_MS} THEN excluded.last_completed_at ELSE ${puzzleStats.lastCompletedAt} END`
					}
				})
				.returning({ playerId: puzzleStats.playerId })
				.get();
			if (result) return { status: 'recorded' };
			throw new Error('Legacy completion write changed no rows without tombstone');
		}
	);
	const deletePuzzleCompletionData = sqlite.transaction((puzzleId: string) => {
		db.delete(puzzleStats).where(eq(puzzleStats.puzzleId, puzzleId)).run();
		db.delete(puzzleCompletionRuns).where(eq(puzzleCompletionRuns.puzzleId, puzzleId)).run();
	});
	const completionWrites: CompletionWriteExecutor = {
		async write(input) {
			return writeCompletion(input);
		},

		async writeLegacy(input) {
			return writeLegacyCompletion.immediate(input);
		},

		async deletePuzzleCompletionData(puzzleId) {
			deletePuzzleCompletionData(puzzleId);
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
