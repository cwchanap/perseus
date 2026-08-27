import { sqliteTable, text, integer, primaryKey, index, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { MAX_COMPLETION_TIME_SECONDS } from '@perseus/types';

// D1 ownership/stats tables are a BEST-EFFORT MIRROR of the authoritative
// KV/DO puzzle metadata store. The DO (PuzzleMetadataDO) is the source of
// truth for puzzle status; D1 holds immutable fields (id, ownerId, name,
// pieceCount, category, createdAt) plus a mirrored status column used only
// for the player profile lists/counts. Mirror writes (workflow finalize /
// mark-failed) are best-effort with logged failures. For non-terminal
// states (processing → ready/failed), a missed mirror is self-healing: the
// next status change re-mirrors. For TERMINAL states (ready/failed), the
// workflow's last D1 mirror is the final write — if it fails (D1 outage at
// that instant), the row stays 'processing' indefinitely because there is
// no subsequent mutation to re-mirror. There is no reconciliation job;
// this drift is accepted as a rare-edge-case trade-off for this app's scale
// (the gallery reads from KV/DO, so only the profile ownership/stats list
// shows a stale 'processing' status until the puzzle is re-uploaded or
// manually fixed).
//
// No backfill of pre-existing puzzles is required: player puzzle upload
// (added in f7db5dd on main) wrote only to KV/R2 with no D1 ownership row,
// but this D1 database was created fresh in this branch (d5a121d) and no
// player-uploaded puzzles existed in production before this branch deployed.

export const playerProfiles = sqliteTable('player_profiles', {
	playerId: text('player_id').primaryKey(),
	displayName: text('display_name'),
	avatarUrl: text('avatar_url'),
	avatarUpdatedAt: integer('avatar_updated_at'),
	avatarUpdateToken: text('avatar_update_token'),
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

export const puzzleCompletionRuns = sqliteTable(
	'puzzle_completion_runs',
	{
		playerId: text('player_id').notNull(),
		runId: text('run_id').notNull(),
		puzzleId: text('puzzle_id').notNull(),
		resultClass: text('result_class').notNull(),
		timingQuality: text('timing_quality').notNull(),
		elapsedActiveSeconds: integer('elapsed_active_seconds'),
		completedAt: integer('completed_at').notNull()
	},
	(t) => ({
		pk: primaryKey({ columns: [t.playerId, t.runId] }),
		playerPuzzleCompletedIdx: index('idx_pcr_player_puzzle_completed').on(
			t.playerId,
			t.puzzleId,
			t.completedAt
		),
		puzzleIdx: index('idx_pcr_puzzle').on(t.puzzleId),
		resultClassCheck: check(
			'pcr_result_class_check',
			sql`${t.resultClass} IN ('standard_timed', 'rotation_timed', 'assisted_timed', 'relaxed')`
		),
		timingQualityCheck: check(
			'pcr_timing_quality_check',
			sql`${t.timingQuality} IN ('known', 'legacy_unknown')`
		),
		elapsedActiveSecondsCheck: check(
			'pcr_elapsed_active_seconds_check',
			sql`(
				(${t.timingQuality} = 'legacy_unknown' AND ${t.resultClass} != 'relaxed' AND ${t.elapsedActiveSeconds} IS NULL)
				OR (${t.timingQuality} = 'known' AND ${t.resultClass} = 'relaxed' AND ${t.elapsedActiveSeconds} IS NULL)
				OR (
					${t.timingQuality} = 'known'
					AND ${t.resultClass} IN ('standard_timed', 'rotation_timed', 'assisted_timed')
					AND ${t.elapsedActiveSeconds} IS NOT NULL
					AND typeof(${t.elapsedActiveSeconds}) = 'integer'
					AND ${t.elapsedActiveSeconds} BETWEEN 1 AND ${MAX_COMPLETION_TIME_SECONDS}
				)
			)`
		)
	})
);

export const puzzleDeletionTombstones = sqliteTable('puzzle_deletion_tombstones', {
	puzzleId: text('puzzle_id').primaryKey(),
	deletedAt: integer('deleted_at').notNull()
});

export const playerCompletionUsage = sqliteTable(
	'player_completion_usage',
	{
		playerId: text('player_id').primaryKey(),
		retainedRuns: integer('retained_runs').notNull()
	},
	(t) => ({
		retainedRunsCheck: check('pcu_retained_runs_check', sql`${t.retainedRuns} BETWEEN 0 AND 100000`)
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

export const puzzleFamilies = sqliteTable(
	'puzzle_families',
	{
		id: text('id').primaryKey(),
		ownerId: text('owner_id').notNull(),
		name: text('name').notNull(),
		category: text('category'),
		aspectRatio: text('aspect_ratio').notNull(),
		status: text('status').notNull().default('processing'),
		createdAt: integer('created_at').notNull()
	},
	(t) => ({
		ownerIdx: index('idx_puzzle_families_owner').on(t.ownerId, t.createdAt),
		statusCheck: check(
			'puzzle_families_status_check',
			sql`${t.status} IN ('processing', 'ready', 'failed')`
		),
		aspectRatioCheck: check(
			'puzzle_families_aspect_ratio_check',
			sql`${t.aspectRatio} IN ('1:1', '4:3', '3:4')`
		)
	})
);
