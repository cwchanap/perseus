import { sqliteTable, text, integer, primaryKey, index, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// D1 ownership/stats tables are a BEST-EFFORT MIRROR of the authoritative
// KV/DO puzzle metadata store. The DO (PuzzleMetadataDO) is the source of
// truth for puzzle status; D1 holds immutable fields (id, ownerId, name,
// pieceCount, category, createdAt) plus a mirrored status column used only
// for the player profile lists/counts. Mirror writes (workflow finalize /
// mark-failed) are best-effort with logged failures — a silent D1 write
// failure leaves D1 stale until the next status change re-mirrors. There is
// no reconciliation job; drift is self-healing on the next mutation and
// rare enough that a periodic reconcile is YAGNI for this app's scale.
//
// No backfill of pre-existing puzzles is required: player puzzle upload
// (added in f7db5dd on main) wrote only to KV/R2 with no D1 ownership row,
// but this D1 database was created fresh in this branch (d5a121d) and no
// player-uploaded puzzles existed in production before this branch deployed.

export const playerProfiles = sqliteTable('player_profiles', {
	playerId: text('player_id').primaryKey(),
	displayName: text('display_name'),
	avatarUrl: text('avatar_url'),
	updatedAt: integer('updated_at').notNull()
});

export const puzzleStats = sqliteTable(
	'puzzle_stats',
	{
		playerId: text('player_id').notNull(),
		puzzleId: text('puzzle_id').notNull(),
		bestTimeSeconds: integer('best_time_seconds').notNull(),
		totalCompletions: integer('total_completions').notNull().default(1),
		firstCompletedAt: integer('first_completed_at').notNull(),
		lastCompletedAt: integer('last_completed_at').notNull()
	},
	(t) => ({
		pk: primaryKey({ columns: [t.playerId, t.puzzleId] }),
		playerIdx: index('idx_ps_player').on(t.playerId)
	})
);

export const puzzles = sqliteTable(
	'puzzles',
	{
		id: text('id').primaryKey(),
		ownerId: text('owner_id').notNull(),
		name: text('name').notNull(),
		pieceCount: integer('piece_count').notNull(),
		category: text('category'),
		status: text('status').notNull().default('processing'),
		createdAt: integer('created_at').notNull()
	},
	(t) => ({
		ownerIdx: index('idx_puzzles_owner').on(t.ownerId, t.createdAt),
		// Defense-in-depth: the application only ever writes 'processing',
		// 'ready', or 'failed'. coercePuzzleStatus() tolerates unexpected
		// values at read time, but this CHECK rejects a bad write at the DB
		// layer so a bug or manual edit can't store an unhandled status.
		statusCheck: check(
			'puzzles_status_check',
			sql`${t.status} IN ('processing', 'ready', 'failed')`
		)
	})
);
