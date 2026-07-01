PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_puzzles` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`piece_count` integer NOT NULL,
	`category` text,
	`status` text DEFAULT 'processing' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "puzzles_status_check" CHECK("status" IN ('processing', 'ready', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_puzzles`("id", "owner_id", "name", "piece_count", "category", "status", "created_at") SELECT "id", "owner_id", "name", "piece_count", "category", "status", "created_at" FROM `puzzles`;--> statement-breakpoint
DROP TABLE `puzzles`;--> statement-breakpoint
ALTER TABLE `__new_puzzles` RENAME TO `puzzles`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_puzzles_owner` ON `puzzles` (`owner_id`,`created_at`);