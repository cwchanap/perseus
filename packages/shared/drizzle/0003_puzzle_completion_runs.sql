CREATE TABLE `puzzle_completion_runs` (
	`player_id` text NOT NULL,
	`run_id` text NOT NULL,
	`puzzle_id` text NOT NULL,
	`result_class` text NOT NULL,
	`timing_quality` text NOT NULL,
	`elapsed_active_seconds` integer,
	`completed_at` integer NOT NULL,
	PRIMARY KEY(`player_id`, `run_id`),
	CONSTRAINT "pcr_result_class_check" CHECK("puzzle_completion_runs"."result_class" IN ('standard_timed', 'rotation_timed', 'assisted_timed', 'relaxed')),
	CONSTRAINT "pcr_timing_quality_check" CHECK("puzzle_completion_runs"."timing_quality" IN ('known', 'legacy_unknown')),
	CONSTRAINT "pcr_elapsed_active_seconds_check" CHECK((
				("puzzle_completion_runs"."timing_quality" = 'legacy_unknown' AND "puzzle_completion_runs"."result_class" != 'relaxed' AND "puzzle_completion_runs"."elapsed_active_seconds" IS NULL)
				OR ("puzzle_completion_runs"."timing_quality" = 'known' AND "puzzle_completion_runs"."result_class" = 'relaxed' AND "puzzle_completion_runs"."elapsed_active_seconds" IS NULL)
				OR (
					"puzzle_completion_runs"."timing_quality" = 'known'
					AND "puzzle_completion_runs"."result_class" IN ('standard_timed', 'rotation_timed', 'assisted_timed')
					AND "puzzle_completion_runs"."elapsed_active_seconds" IS NOT NULL
					AND typeof("puzzle_completion_runs"."elapsed_active_seconds") = 'integer'
					AND "puzzle_completion_runs"."elapsed_active_seconds" BETWEEN 1 AND 86400
				)
			))
);
--> statement-breakpoint
CREATE INDEX `idx_pcr_player_puzzle_completed` ON `puzzle_completion_runs` (`player_id`,`puzzle_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `idx_pcr_puzzle` ON `puzzle_completion_runs` (`puzzle_id`);