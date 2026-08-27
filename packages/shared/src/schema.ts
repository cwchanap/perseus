import { sqliteTable, text, integer, primaryKey, index, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { MAX_COMPLETION_TIME_SECONDS, PUZZLE_DIFFICULTIES } from '@perseus/types';

export const playerProfiles = sqliteTable('player_profiles', {
	playerId: text('player_id').primaryKey(),
	displayName: text('display_name'),
	avatarUrl: text('avatar_url'),
	avatarUpdatedAt: integer('avatar_updated_at'),
	avatarUpdateToken: text('avatar_update_token'),
	updatedAt: integer('updated_at').notNull()
});

export const puzzleCompletionRuns = sqliteTable(
	'puzzle_completion_runs',
	{
		playerId: text('player_id').notNull(),
		runId: text('run_id').notNull(),
		puzzleId: text('puzzle_id').notNull(),
		familyId: text('family_id').notNull(),
		difficulty: text('difficulty').notNull(),
		resultClass: text('result_class').notNull(),
		elapsedActiveSeconds: integer('elapsed_active_seconds'),
		hintsUsed: integer('hints_used').notNull(),
		incorrectAttempts: integer('incorrect_attempts').notNull(),
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
		familyIdx: index('idx_pcr_family').on(t.familyId),
		resultClassCheck: check(
			'pcr_result_class_check',
			sql`${t.resultClass} IN ('standard_timed', 'rotation_timed', 'assisted_timed', 'relaxed')`
		),
		difficultyCheck: check(
			'pcr_difficulty_check',
			sql`${t.difficulty} IN (${sql.raw(PUZZLE_DIFFICULTIES.map((d) => `'${d}'`).join(', '))})`
		),
		hintsUsedCheck: check('pcr_hints_used_check', sql`${t.hintsUsed} >= 0`),
		incorrectAttemptsCheck: check('pcr_incorrect_attempts_check', sql`${t.incorrectAttempts} >= 0`),
		elapsedActiveSecondsCheck: check(
			'pcr_elapsed_active_seconds_check',
			sql`(
				(${t.resultClass} = 'relaxed' AND ${t.elapsedActiveSeconds} IS NULL)
				OR (
					${t.resultClass} IN ('standard_timed', 'rotation_timed', 'assisted_timed')
					AND ${t.elapsedActiveSeconds} IS NOT NULL
					AND typeof(${t.elapsedActiveSeconds}) = 'integer'
					AND ${t.elapsedActiveSeconds} BETWEEN 1 AND ${sql.raw(String(MAX_COMPLETION_TIME_SECONDS))}
				)
			)`
		)
	})
);

export const puzzleBestTimes = sqliteTable(
	'puzzle_best_times',
	{
		playerId: text('player_id').notNull(),
		puzzleId: text('puzzle_id').notNull(),
		familyId: text('family_id').notNull(),
		difficulty: text('difficulty').notNull(),
		resultClass: text('result_class').notNull(),
		bestTimeSeconds: integer('best_time_seconds').notNull(),
		achievedAt: integer('achieved_at').notNull()
	},
	(t) => ({
		pk: primaryKey({ columns: [t.playerId, t.puzzleId, t.resultClass] }),
		playerIdx: index('idx_pbt_player').on(t.playerId),
		familyIdx: index('idx_pbt_family').on(t.familyId),
		resultClassCheck: check(
			'pbt_result_class_check',
			sql`${t.resultClass} IN ('standard_timed', 'rotation_timed')`
		),
		difficultyCheck: check(
			'pbt_difficulty_check',
			sql`${t.difficulty} IN (${sql.raw(PUZZLE_DIFFICULTIES.map((d) => `'${d}'`).join(', '))})`
		),
		bestTimeSecondsCheck: check(
			'pbt_best_time_seconds_check',
			sql`${t.bestTimeSeconds} BETWEEN 1 AND ${sql.raw(String(MAX_COMPLETION_TIME_SECONDS))}`
		)
	})
);

export const playerDifficultyCompletions = sqliteTable(
	'player_difficulty_completions',
	{
		playerId: text('player_id').notNull(),
		familyId: text('family_id').notNull(),
		difficulty: text('difficulty').notNull(),
		firstCompletedAt: integer('first_completed_at').notNull()
	},
	(t) => ({
		pk: primaryKey({ columns: [t.playerId, t.familyId, t.difficulty] }),
		playerIdx: index('idx_pdc_player').on(t.playerId),
		difficultyCheck: check(
			'pdc_difficulty_check',
			sql`${t.difficulty} IN (${sql.raw(PUZZLE_DIFFICULTIES.map((d) => `'${d}'`).join(', '))})`
		)
	})
);

export const playerAchievements = sqliteTable(
	'player_achievements',
	{
		playerId: text('player_id').notNull(),
		achievementId: text('achievement_id').notNull(),
		unlockedAt: integer('unlocked_at').notNull()
	},
	(t) => ({
		pk: primaryKey({ columns: [t.playerId, t.achievementId] }),
		playerIdx: index('idx_pa_player').on(t.playerId)
	})
);

export const playerVariantMastery = sqliteTable(
	'player_variant_mastery',
	{
		playerId: text('player_id').notNull(),
		puzzleId: text('puzzle_id').notNull(),
		badge: text('badge').notNull(),
		earnedAt: integer('earned_at').notNull()
	},
	(t) => ({
		pk: primaryKey({ columns: [t.playerId, t.puzzleId, t.badge] }),
		playerIdx: index('idx_pvm_player').on(t.playerId),
		puzzleIdx: index('idx_pvm_puzzle').on(t.puzzleId)
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
