CREATE INDEX `idx_pbt_family_difficulty_class_time` ON `puzzle_best_times` (`family_id`,`difficulty`,`result_class`,`best_time_seconds`,`achieved_at`,`player_id`);
