CREATE TABLE `puzzle_families` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text,
	`aspect_ratio` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "puzzle_families_status_check" CHECK("puzzle_families"."status" IN ('processing', 'ready', 'failed')),
	CONSTRAINT "puzzle_families_aspect_ratio_check" CHECK("puzzle_families"."aspect_ratio" IN ('1:1', '4:3', '3:4'))
);
--> statement-breakpoint
CREATE INDEX `idx_puzzle_families_owner` ON `puzzle_families` (`owner_id`,`created_at`);
