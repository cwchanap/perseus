CREATE TABLE `player_completion_usage` (
	`player_id` text PRIMARY KEY NOT NULL,
	`retained_runs` integer NOT NULL,
	CONSTRAINT "pcu_retained_runs_check" CHECK("player_completion_usage"."retained_runs" BETWEEN 0 AND 100000)
);
--> statement-breakpoint
CREATE TABLE `puzzle_deletion_tombstones` (
	`puzzle_id` text PRIMARY KEY NOT NULL,
	`deleted_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO player_completion_usage (player_id, retained_runs)
SELECT player_id, COUNT(*)
FROM puzzle_completion_runs
GROUP BY player_id;
--> statement-breakpoint
CREATE TRIGGER guard_puzzles_not_tombstoned_insert
BEFORE INSERT ON puzzles
WHEN EXISTS (
	SELECT 1
	FROM puzzle_deletion_tombstones
	WHERE puzzle_id = NEW.id
)
BEGIN
	SELECT RAISE(ABORT, 'puzzle_deleted');
END;
--> statement-breakpoint
CREATE TRIGGER guard_puzzles_not_tombstoned_update
BEFORE UPDATE ON puzzles
WHEN EXISTS (
	SELECT 1
	FROM puzzle_deletion_tombstones
	WHERE puzzle_id = NEW.id
)
BEGIN
	SELECT RAISE(ABORT, 'puzzle_deleted');
END;
--> statement-breakpoint
CREATE TRIGGER guard_puzzle_stats_not_tombstoned_insert
BEFORE INSERT ON puzzle_stats
WHEN EXISTS (
	SELECT 1
	FROM puzzle_deletion_tombstones
	WHERE puzzle_id = NEW.puzzle_id
)
BEGIN
	SELECT RAISE(ABORT, 'puzzle_deleted');
END;
--> statement-breakpoint
CREATE TRIGGER guard_puzzle_stats_not_tombstoned_update
BEFORE UPDATE ON puzzle_stats
WHEN EXISTS (
	SELECT 1
	FROM puzzle_deletion_tombstones
	WHERE puzzle_id = NEW.puzzle_id
)
BEGIN
	SELECT RAISE(ABORT, 'puzzle_deleted');
END;
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
	WHERE puzzle_id = NEW.puzzle_id
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
