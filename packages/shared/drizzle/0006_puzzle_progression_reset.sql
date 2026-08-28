DROP TRIGGER IF EXISTS `guard_puzzles_not_tombstoned_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `guard_puzzles_not_tombstoned_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `guard_puzzle_stats_not_tombstoned_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `guard_puzzle_stats_not_tombstoned_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `guard_puzzle_completion_runs_not_tombstoned_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `guard_puzzle_completion_runs_not_tombstoned_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `guard_puzzle_completion_run_quota`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `increment_player_completion_usage`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `decrement_player_completion_usage`;
--> statement-breakpoint
DELETE FROM `player_completion_usage`;
--> statement-breakpoint
DROP TABLE IF EXISTS `puzzles`;
--> statement-breakpoint
DROP TABLE IF EXISTS `puzzle_stats`;
--> statement-breakpoint
DROP TABLE `puzzle_completion_runs`;
--> statement-breakpoint
CREATE TABLE `puzzle_completion_runs` (
	`player_id` text NOT NULL,
	`run_id` text NOT NULL,
	`puzzle_id` text NOT NULL,
	`family_id` text NOT NULL,
	`difficulty` text NOT NULL,
	`result_class` text NOT NULL,
	`elapsed_active_seconds` integer,
	`hints_used` integer NOT NULL,
	`incorrect_attempts` integer NOT NULL,
	`completed_at` integer NOT NULL,
	PRIMARY KEY(`player_id`, `run_id`),
	CONSTRAINT "pcr_result_class_check" CHECK("puzzle_completion_runs"."result_class" IN ('standard_timed', 'rotation_timed', 'assisted_timed', 'relaxed')),
	CONSTRAINT "pcr_difficulty_check" CHECK("puzzle_completion_runs"."difficulty" IN ('easy', 'normal', 'hard')),
	CONSTRAINT "pcr_hints_used_check" CHECK("puzzle_completion_runs"."hints_used" >= 0),
	CONSTRAINT "pcr_incorrect_attempts_check" CHECK("puzzle_completion_runs"."incorrect_attempts" >= 0),
	CONSTRAINT "pcr_elapsed_active_seconds_check" CHECK(
		("puzzle_completion_runs"."result_class" = 'relaxed' AND "puzzle_completion_runs"."elapsed_active_seconds" IS NULL)
		OR (
			"puzzle_completion_runs"."result_class" IN ('standard_timed', 'rotation_timed', 'assisted_timed')
			AND "puzzle_completion_runs"."elapsed_active_seconds" IS NOT NULL
			AND typeof("puzzle_completion_runs"."elapsed_active_seconds") = 'integer'
			AND "puzzle_completion_runs"."elapsed_active_seconds" BETWEEN 1 AND 86400
		)
	)
);
--> statement-breakpoint
CREATE INDEX `idx_pcr_player_puzzle_completed` ON `puzzle_completion_runs` (`player_id`,`puzzle_id`,`completed_at`);
--> statement-breakpoint
CREATE INDEX `idx_pcr_puzzle` ON `puzzle_completion_runs` (`puzzle_id`);
--> statement-breakpoint
CREATE INDEX `idx_pcr_family` ON `puzzle_completion_runs` (`family_id`);
--> statement-breakpoint
CREATE TABLE `puzzle_best_times` (
	`player_id` text NOT NULL,
	`puzzle_id` text NOT NULL,
	`family_id` text NOT NULL,
	`difficulty` text NOT NULL,
	`result_class` text NOT NULL,
	`best_time_seconds` integer NOT NULL,
	`achieved_at` integer NOT NULL,
	PRIMARY KEY(`player_id`, `puzzle_id`, `result_class`),
	CONSTRAINT "pbt_result_class_check" CHECK("puzzle_best_times"."result_class" IN ('standard_timed', 'rotation_timed')),
	CONSTRAINT "pbt_difficulty_check" CHECK("puzzle_best_times"."difficulty" IN ('easy', 'normal', 'hard')),
	CONSTRAINT "pbt_best_time_seconds_check" CHECK("puzzle_best_times"."best_time_seconds" BETWEEN 1 AND 86400)
);
--> statement-breakpoint
CREATE INDEX `idx_pbt_player` ON `puzzle_best_times` (`player_id`);
--> statement-breakpoint
CREATE INDEX `idx_pbt_family` ON `puzzle_best_times` (`family_id`);
--> statement-breakpoint
CREATE TABLE `player_difficulty_completions` (
	`player_id` text NOT NULL,
	`family_id` text NOT NULL,
	`difficulty` text NOT NULL,
	`first_completed_at` integer NOT NULL,
	PRIMARY KEY(`player_id`, `family_id`, `difficulty`),
	CONSTRAINT "pdc_difficulty_check" CHECK("player_difficulty_completions"."difficulty" IN ('easy', 'normal', 'hard'))
);
--> statement-breakpoint
CREATE INDEX `idx_pdc_player` ON `player_difficulty_completions` (`player_id`);
--> statement-breakpoint
CREATE TABLE `player_achievements` (
	`player_id` text NOT NULL,
	`achievement_id` text NOT NULL,
	`unlocked_at` integer NOT NULL,
	PRIMARY KEY(`player_id`, `achievement_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_pa_player` ON `player_achievements` (`player_id`);
--> statement-breakpoint
CREATE TABLE `player_variant_mastery` (
	`player_id` text NOT NULL,
	`puzzle_id` text NOT NULL,
	`badge` text NOT NULL,
	`earned_at` integer NOT NULL,
	PRIMARY KEY(`player_id`, `puzzle_id`, `badge`)
);
--> statement-breakpoint
CREATE INDEX `idx_pvm_player` ON `player_variant_mastery` (`player_id`);
--> statement-breakpoint
CREATE INDEX `idx_pvm_puzzle` ON `player_variant_mastery` (`puzzle_id`);
--> statement-breakpoint
CREATE TRIGGER guard_puzzle_completion_runs_not_tombstoned_insert
BEFORE INSERT ON puzzle_completion_runs
WHEN EXISTS (
	SELECT 1
	FROM puzzle_deletion_tombstones
	WHERE puzzle_id = NEW.puzzle_id
)
BEGIN
	SELECT RAISE(ABORT, 'puzzle_deleted');
END;
--> statement-breakpoint
CREATE TRIGGER guard_puzzle_completion_runs_not_tombstoned_update
BEFORE UPDATE ON puzzle_completion_runs
WHEN EXISTS (
	SELECT 1
	FROM puzzle_deletion_tombstones
	WHERE puzzle_id = OLD.puzzle_id OR puzzle_id = NEW.puzzle_id
)
BEGIN
	SELECT RAISE(ABORT, 'puzzle_deleted');
END;
--> statement-breakpoint
CREATE TRIGGER guard_puzzle_best_times_not_tombstoned_insert
BEFORE INSERT ON puzzle_best_times
WHEN EXISTS (
	SELECT 1
	FROM puzzle_deletion_tombstones
	WHERE puzzle_id = NEW.puzzle_id
)
BEGIN
	SELECT RAISE(ABORT, 'puzzle_deleted');
END;
--> statement-breakpoint
CREATE TRIGGER guard_puzzle_best_times_not_tombstoned_update
BEFORE UPDATE ON puzzle_best_times
WHEN EXISTS (
	SELECT 1
	FROM puzzle_deletion_tombstones
	WHERE puzzle_id = OLD.puzzle_id OR puzzle_id = NEW.puzzle_id
)
BEGIN
	SELECT RAISE(ABORT, 'puzzle_deleted');
END;
--> statement-breakpoint
CREATE TRIGGER guard_player_variant_mastery_not_tombstoned_insert
BEFORE INSERT ON player_variant_mastery
WHEN EXISTS (
	SELECT 1
	FROM puzzle_deletion_tombstones
	WHERE puzzle_id = NEW.puzzle_id
)
BEGIN
	SELECT RAISE(ABORT, 'puzzle_deleted');
END;
--> statement-breakpoint
CREATE TRIGGER guard_player_variant_mastery_not_tombstoned_update
BEFORE UPDATE ON player_variant_mastery
WHEN EXISTS (
	SELECT 1
	FROM puzzle_deletion_tombstones
	WHERE puzzle_id = OLD.puzzle_id OR puzzle_id = NEW.puzzle_id
)
BEGIN
	SELECT RAISE(ABORT, 'puzzle_deleted');
END;
--> statement-breakpoint
CREATE TRIGGER guard_puzzle_completion_run_quota
BEFORE INSERT ON puzzle_completion_runs
WHEN NOT EXISTS (
	SELECT 1
	FROM puzzle_completion_runs
	WHERE player_id = NEW.player_id
		AND run_id = NEW.run_id
)
AND COALESCE(
	(
		SELECT retained_runs
		FROM player_completion_usage
		WHERE player_id = NEW.player_id
	),
	0
) >= 100000
BEGIN
	SELECT RAISE(ABORT, 'completion_quota_exceeded');
END;
--> statement-breakpoint
CREATE TRIGGER increment_player_completion_usage
AFTER INSERT ON puzzle_completion_runs
BEGIN
	INSERT INTO player_completion_usage (player_id, retained_runs)
	VALUES (NEW.player_id, 1)
	ON CONFLICT (player_id) DO UPDATE
	SET retained_runs = retained_runs + 1;
END;
--> statement-breakpoint
CREATE TRIGGER decrement_player_completion_usage
AFTER DELETE ON puzzle_completion_runs
BEGIN
	UPDATE player_completion_usage
	SET retained_runs = retained_runs - 1
	WHERE player_id = OLD.player_id
		AND retained_runs > 0;

	DELETE FROM player_completion_usage
	WHERE player_id = OLD.player_id
		AND retained_runs = 0;
END;
