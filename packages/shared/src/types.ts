import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type * as schema from './schema';

export type PlayerProfileRow = typeof schema.playerProfiles.$inferSelect;
export type NewPlayerProfileRow = typeof schema.playerProfiles.$inferInsert;
export type PuzzleBestTimeRow = typeof schema.puzzleBestTimes.$inferSelect;
export type NewPuzzleBestTimeRow = typeof schema.puzzleBestTimes.$inferInsert;
export type PuzzleCompletionRunRow = typeof schema.puzzleCompletionRuns.$inferSelect;
export type NewPuzzleCompletionRunRow = typeof schema.puzzleCompletionRuns.$inferInsert;
export type PuzzleFamilyRow = typeof schema.puzzleFamilies.$inferSelect;
export type NewPuzzleFamilyRow = typeof schema.puzzleFamilies.$inferInsert;
export type PlayerDifficultyCompletionRow = typeof schema.playerDifficultyCompletions.$inferSelect;
export type PlayerAchievementRow = typeof schema.playerAchievements.$inferSelect;
export type PlayerVariantMasteryRow = typeof schema.playerVariantMastery.$inferSelect;

/** @deprecated puzzles table removed in migration 0006; retained for route compatibility. */
export interface LegacyPuzzleOwnershipRow {
	id: string;
	ownerId: string;
	name: string;
	pieceCount: number;
	category?: string;
	status: string;
	createdAt: number;
}

/**
 * Cross-runtime Drizzle client. Both `drizzle-orm/d1` (D1Database) and
 * `drizzle-orm/bun-sqlite` (bun:sqlite) produce databases assignable to this
 * base. Repository functions always `await` results, so the sync (bun) vs
 * async (D1) distinction is handled at runtime.
 */
export type AppDb = BaseSQLiteDatabase<'sync' | 'async', unknown, typeof schema>;

/**
 * D1-bound client. Unlike {@link AppDb}, this preserves the D1-specific
 * `batch()` surface that bookmark and completion writes rely on. Aliased here
 * (rather than in `drivers/d1`) so barrel consumers can reference the type
 * without pulling the driver — and its ambient `D1Database` workers type —
 * into their compile graph.
 */
export type D1AppDb = DrizzleD1Database<typeof schema>;

export type { schema };
