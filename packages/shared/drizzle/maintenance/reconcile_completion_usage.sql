BEGIN;

CREATE TABLE completion_usage_reconcile_guard (
	retained_runs INTEGER NOT NULL
		CHECK (retained_runs BETWEEN 0 AND 100000)
);

INSERT INTO completion_usage_reconcile_guard (retained_runs)
SELECT COUNT(*)
FROM puzzle_completion_runs
GROUP BY player_id;

DELETE FROM player_completion_usage;

INSERT INTO player_completion_usage (player_id, retained_runs)
SELECT player_id, COUNT(*)
FROM puzzle_completion_runs
GROUP BY player_id;

DROP TABLE completion_usage_reconcile_guard;

COMMIT;
