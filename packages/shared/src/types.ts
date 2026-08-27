import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type * as schema from './schema';

export type PlayerProfileRow = typeof schema.playerProfiles.$inferSelect;
export type NewPlayerProfileRow = typeof schema.playerProfiles.$inferInsert;
export type PuzzleStatRow = typeof schema.puzzleStats.$inferSelect;
export type NewPuzzleStatRow = typeof schema.puzzleStats.$inferInsert;
export type PuzzleCompletionRunRow = typeof schema.puzzleCompletionRuns.$inferSelect;
export type NewPuzzleCompletionRunRow = typeof schema.puzzleCompletionRuns.$inferInsert;
export type PuzzleRow = typeof schema.puzzles.$inferSelect;
export type NewPuzzleRow = typeof schema.puzzles.$inferInsert;
export type PuzzleFamilyRow = typeof schema.puzzleFamilies.$inferSelect;
export type NewPuzzleFamilyRow = typeof schema.puzzleFamilies.$inferInsert;

/**
 * Cross-runtime Drizzle client. Both `drizzle-orm/d1` (D1Database) and
 * `drizzle-orm/bun-sqlite` (bun:sqlite) produce databases assignable to this
 * base. Repository functions always `await` results, so the sync (bun) vs
 * async (D1) distinction is handled at runtime.
 */
export type AppDb = BaseSQLiteDatabase<'sync' | 'async', unknown, typeof schema>;

export type { schema };
