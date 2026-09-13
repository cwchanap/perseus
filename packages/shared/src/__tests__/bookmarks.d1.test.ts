import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Miniflare } from 'miniflare';
import { createMiniflareD1, D1_HARNESS_WORKER_SOURCE } from './miniflare-d1';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createD1Db, type D1AppDb } from '../drivers/d1';
import {
	MAX_PLAYER_BOOKMARKS,
	addPlayerBookmark,
	deletePlayerBookmarksByFamily,
	listPlayerBookmarks,
	removePlayerBookmark
} from '../bookmarks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../drizzle');
const migrationSql = readdirSync(migrationsDir)
	.filter((f) => /^\d{4}_.*\.sql$/u.test(f))
	.sort()
	.map((f) => readFileSync(join(migrationsDir, f), 'utf-8'))
	.join('\n');

let mf: Miniflare;
let db: D1AppDb;
let d1: D1Database;

beforeAll(async () => {
	mf = new Miniflare({
		modules: [{ type: 'ESModule', path: 'index.js', contents: D1_HARNESS_WORKER_SOURCE }],
		d1Databases: ['DB'],
		compatibilityDate: '2024-12-30'
	});
	d1 = createMiniflareD1(mf);
	for (const stmt of migrationSql.split('--> statement-breakpoint')) {
		const trimmed = stmt.trim();
		if (trimmed) await d1.prepare(trimmed).run();
	}
	db = createD1Db({ DB: d1 });
}, 30_000);

afterAll(async () => {
	await mf.dispose();
});

/** Fills one player's bookmarks up to `count` rows via one batched INSERT set. */
async function seedBookmarks(playerId: string, count: number) {
	const stmt = 'INSERT INTO player_bookmarks (player_id, family_id, created_at) VALUES (?, ?, ?)';
	await d1.batch(
		Array.from({ length: count }, (_, i) => d1.prepare(stmt).bind(playerId, `seeded-${i}`, i + 1))
	);
}

describe('player bookmarks (D1)', () => {
	it('adds a bookmark and lists it back', async () => {
		expect(await addPlayerBookmark(db, 'p1', 'family-a', 100)).toBe('added');
		expect(await listPlayerBookmarks(db, 'p1')).toEqual([{ familyId: 'family-a', createdAt: 100 }]);
	});

	it('returns existing and keeps a single row on repeated adds', async () => {
		expect(await addPlayerBookmark(db, 'p6', 'family-a', 100)).toBe('added');
		expect(await addPlayerBookmark(db, 'p6', 'family-a', 200)).toBe('existing');
		const rows = await listPlayerBookmarks(db, 'p6');
		expect(rows).toHaveLength(1);
		expect(rows[0].createdAt).toBe(100);
	});

	it('lists newest-first regardless of insertion order', async () => {
		await addPlayerBookmark(db, 'p2', 'family-old', 10);
		await addPlayerBookmark(db, 'p2', 'family-mid', 20);
		await addPlayerBookmark(db, 'p2', 'family-new', 30);
		expect(await listPlayerBookmarks(db, 'p2')).toEqual([
			{ familyId: 'family-new', createdAt: 30 },
			{ familyId: 'family-mid', createdAt: 20 },
			{ familyId: 'family-old', createdAt: 10 }
		]);
	});

	it('breaks same-timestamp ties deterministically by family id', async () => {
		await addPlayerBookmark(db, 'p6b', 'family-b', 100);
		await addPlayerBookmark(db, 'p6b', 'family-a', 100);
		await addPlayerBookmark(db, 'p6b', 'family-c', 100);
		expect(await listPlayerBookmarks(db, 'p6b')).toEqual([
			{ familyId: 'family-c', createdAt: 100 },
			{ familyId: 'family-b', createdAt: 100 },
			{ familyId: 'family-a', createdAt: 100 }
		]);
	});

	it('removes idempotently', async () => {
		await addPlayerBookmark(db, 'p3', 'family-a', 1);
		await removePlayerBookmark(db, 'p3', 'family-a');
		expect(await listPlayerBookmarks(db, 'p3')).toEqual([]);
		await expect(removePlayerBookmark(db, 'p3', 'family-a')).resolves.toBeUndefined();
	});

	it('isolates bookmarks per player', async () => {
		await addPlayerBookmark(db, 'p4', 'family-shared', 1);
		expect(await listPlayerBookmarks(db, 'p5')).toEqual([]);
		expect(await addPlayerBookmark(db, 'p5', 'family-shared', 2)).toBe('added');
		expect(await listPlayerBookmarks(db, 'p4')).toEqual([
			{ familyId: 'family-shared', createdAt: 1 }
		]);
	});

	it('accepts the 200th distinct bookmark but rejects the 201st', async () => {
		await seedBookmarks('cap-1', MAX_PLAYER_BOOKMARKS - 1);
		expect(await addPlayerBookmark(db, 'cap-1', 'family-200th')).toBe('added');
		expect(await addPlayerBookmark(db, 'cap-1', 'family-201st')).toBe('limit_reached');
		const families = (await listPlayerBookmarks(db, 'cap-1')).map((row) => row.familyId);
		expect(families).toHaveLength(MAX_PLAYER_BOOKMARKS);
		expect(families).not.toContain('family-201st');
	});

	it('still returns existing for a bookmarked family at the cap', async () => {
		await seedBookmarks('cap-2', MAX_PLAYER_BOOKMARKS);
		expect(await addPlayerBookmark(db, 'cap-2', 'seeded-0')).toBe('existing');
		expect(await listPlayerBookmarks(db, 'cap-2')).toHaveLength(MAX_PLAYER_BOOKMARKS);
	});

	it('deletes every player row for a family and leaves other families intact', async () => {
		await addPlayerBookmark(db, 'df-1', 'family-gone', 1);
		await addPlayerBookmark(db, 'df-2', 'family-gone', 2);
		await addPlayerBookmark(db, 'df-1', 'family-kept', 3);

		await deletePlayerBookmarksByFamily(db, 'family-gone');

		expect(await listPlayerBookmarks(db, 'df-1')).toEqual([
			{ familyId: 'family-kept', createdAt: 3 }
		]);
		expect(await listPlayerBookmarks(db, 'df-2')).toEqual([]);
		// Idempotent: the fenced deletion path retries this on partial failure.
		await expect(deletePlayerBookmarksByFamily(db, 'family-gone')).resolves.toBeUndefined();
	});

	it('frees cap slots held by bookmarks for a deleted family', async () => {
		await seedBookmarks('cap-deleted', MAX_PLAYER_BOOKMARKS);
		expect(await addPlayerBookmark(db, 'cap-deleted', 'family-new')).toBe('limit_reached');

		await deletePlayerBookmarksByFamily(db, 'seeded-0');

		expect(await addPlayerBookmark(db, 'cap-deleted', 'family-new')).toBe('added');
	});

	it('never lists more than MAX_PLAYER_BOOKMARKS rows', async () => {
		await seedBookmarks('cap-3', MAX_PLAYER_BOOKMARKS + 10);
		const rows = await listPlayerBookmarks(db, 'cap-3');
		expect(rows.length).toBeLessThanOrEqual(MAX_PLAYER_BOOKMARKS);
	});
});
