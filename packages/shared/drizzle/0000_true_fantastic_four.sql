CREATE TABLE `player_profiles` (
	`player_id` text PRIMARY KEY NOT NULL,
	`display_name` text,
	`avatar_url` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `puzzle_stats` (
	`player_id` text NOT NULL,
	`puzzle_id` text NOT NULL,
	`best_time_seconds` integer NOT NULL,
	`total_completions` integer DEFAULT 1 NOT NULL,
	`first_completed_at` integer NOT NULL,
	`last_completed_at` integer NOT NULL,
	PRIMARY KEY(`player_id`, `puzzle_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_ps_player` ON `puzzle_stats` (`player_id`);--> statement-breakpoint
CREATE TABLE `puzzles` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`piece_count` integer NOT NULL,
	`category` text,
	`status` text DEFAULT 'processing' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "puzzles_status_check" CHECK("puzzles"."status" IN ('processing', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_puzzles_owner` ON `puzzles` (`owner_id`,`created_at`);