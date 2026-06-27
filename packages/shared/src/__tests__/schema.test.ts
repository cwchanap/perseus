import { describe, it, expect } from 'vitest';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq } from 'drizzle-orm';
import { playerProfiles, puzzleStats, puzzles } from '../schema';

describe('schema tables', () => {
	function makeDb() {
		const sqlite = new Database(':memory:');
		const db = drizzle(sqlite);
		migrate(db, { migrationsFolder: './drizzle' });
		return { db, sqlite };
	}

	it('creates all three tables', () => {
		const { db, sqlite } = makeDb();
		// Insert + read one row per table to confirm shape.
		db.insert(playerProfiles).values({ playerId: 'p1', displayName: 'P', updatedAt: 1 }).run();
		db.insert(puzzles)
			.values({
				id: 'pz1',
				ownerId: 'p1',
				name: 'Cat',
				pieceCount: 4,
				status: 'processing',
				createdAt: 1
			})
			.run();
		db.insert(puzzleStats)
			.values({
				playerId: 'p1',
				puzzleId: 'pz1',
				bestTimeSeconds: 90,
				totalCompletions: 1,
				firstCompletedAt: 1,
				lastCompletedAt: 1
			})
			.run();

		const profile = db.select().from(playerProfiles).where(eq(playerProfiles.playerId, 'p1')).get();
		expect(profile?.displayName).toBe('P');

		const owned = db.select().from(puzzles).where(eq(puzzles.ownerId, 'p1')).all();
		expect(owned).toHaveLength(1);

		const stats = db.select().from(puzzleStats).where(eq(puzzleStats.playerId, 'p1')).all();
		expect(stats).toHaveLength(1);
		sqlite.close();
	});
});
