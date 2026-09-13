CREATE TABLE `player_bookmarks` (
	`player_id` text NOT NULL,
	`family_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`player_id`, `family_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_player_bookmarks_player_created` ON `player_bookmarks` (`player_id`,`created_at`);
