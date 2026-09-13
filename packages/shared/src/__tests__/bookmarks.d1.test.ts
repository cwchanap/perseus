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
import { deletePuzzleFamilyOwnership } from '../repositories';

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

/**
 * Inserts the puzzle_families ownership row addPlayerBookmark's deletion fence
 * requires. Mirrors the player-upload write: the row exists from upload until
 * deletePuzzleFamilyOwnership removes it.
 */
async function seedFamily(...familyIds: string[]) {
	const stmt =
		'INSERT OR IGNORE INTO puzzle_families ' +
		'(id, owner_id, name, aspect_ratio, status, created_at) VALUES (?, ?, ?, ?, ?, ?)';
	await d1.batch(
		familyIds.map((id, i) =>
			d1.prepare(stmt).bind(id, 'system', `family ${id}`, '4:3', 'ready', i + 1)
		)
	);
}

describe('player bookmarks (D1)', () => {
	it('adds a bookmark and lists it back', async () => {
		await seedFamily('family-a');
		expect(await addPlayerBookmark(db, 'p1', 'family-a', 100)).toBe('added');
		expect(await listPlayerBookmarks(db, 'p1')).toEqual([{ familyId: 'family-a', createdAt: 100 }]);
	});

	it('returns existing and keeps a single row on repeated adds', async () => {
		await seedFamily('family-a');
		expect(await addPlayerBookmark(db, 'p6', 'family-a', 100)).toBe('added');
		expect(await addPlayerBookmark(db, 'p6', 'family-a', 200)).toBe('existing');
		const rows = await listPlayerBookmarks(db, 'p6');
		expect(rows).toHaveLength(1);
		expect(rows[0].createdAt).toBe(100);
	});

	it('lists newest-first regardless of insertion order', async () => {
		await seedFamily('family-old', 'family-mid', 'family-new');
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
		await seedFamily('family-b', 'family-a', 'family-c');
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
		await seedFamily('family-a');
		await addPlayerBookmark(db, 'p3', 'family-a', 1);
		await removePlayerBookmark(db, 'p3', 'family-a');
		expect(await listPlayerBookmarks(db, 'p3')).toEqual([]);
		await expect(removePlayerBookmark(db, 'p3', 'family-a')).resolves.toBeUndefined();
	});

	it('isolates bookmarks per player', async () => {
		await seedFamily('family-shared');
		await addPlayerBookmark(db, 'p4', 'family-shared', 1);
		expect(await listPlayerBookmarks(db, 'p5')).toEqual([]);
		expect(await addPlayerBookmark(db, 'p5', 'family-shared', 2)).toBe('added');
		expect(await listPlayerBookmarks(db, 'p4')).toEqual([
			{ familyId: 'family-shared', createdAt: 1 }
		]);
	});

	it('accepts the 200th distinct bookmark but rejects the 201st', async () => {
		await seedFamily('family-200th', 'family-201st');
		await seedBookmarks('cap-1', MAX_PLAYER_BOOKMARKS - 1);
		expect(await addPlayerBookmark(db, 'cap-1', 'family-200th')).toBe('added');
		expect(await addPlayerBookmark(db, 'cap-1', 'family-201st')).toBe('limit_reached');
		const families = (await listPlayerBookmarks(db, 'cap-1')).map((row) => row.familyId);
		expect(families).toHaveLength(MAX_PLAYER_BOOKMARKS);
		expect(families).not.toContain('family-201st');
	});

	it('still returns existing for a bookmarked family at the cap', async () => {
		await seedFamily('seeded-0');
		await seedBookmarks('cap-2', MAX_PLAYER_BOOKMARKS);
		expect(await addPlayerBookmark(db, 'cap-2', 'seeded-0')).toBe('existing');
		expect(await listPlayerBookmarks(db, 'cap-2')).toHaveLength(MAX_PLAYER_BOOKMARKS);
	});

	it('deletes every player row for a family and leaves other families intact', async () => {
		await seedFamily('family-gone', 'family-kept');
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
		await seedFamily('family-new');
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

	it('returns family_missing and writes nothing for a family with no ownership row', async () => {
		expect(await addPlayerBookmark(db, 'p-unmirrored', 'never-mirrored', 1)).toBe('family_missing');
		expect(await listPlayerBookmarks(db, 'p-unmirrored')).toEqual([]);
	});

	it('prefers existing over family_missing for a persisted row', async () => {
		// A bookmark row that outlives its family (swept asynchronously, or a
		// pre-fence straggler) still reports 'existing' — the add is a no-op and
		// stays idempotent rather than surfacing a spurious error.
		await seedFamily('family-orphaned');
		await addPlayerBookmark(db, 'p-orphan', 'family-orphaned', 1);
		await deletePuzzleFamilyOwnership(db, 'family-orphaned');
		expect(await addPlayerBookmark(db, 'p-orphan', 'family-orphaned', 2)).toBe('existing');
	});

	it('cannot resurrect a bookmark after family deletion cleanup ran', async () => {
		// Pins the PUT-vs-deletion race: the route's KV readiness check can pass
		// (or read stale KV) before completeWorkerPuzzleDeletion removes the
		// ownership row + bookmark rows. The insert is gated on the ownership
		// row in the same D1 batch, so a late insert is refused instead of
		// leaving an invisible row that counts toward the cap.
		await seedFamily('family-race');
		expect(await addPlayerBookmark(db, 'p-race', 'family-race', 1)).toBe('added');

		// completeWorkerPuzzleDeletion order: ownership row first, then the
		// family's bookmark rows.
		await deletePuzzleFamilyOwnership(db, 'family-race');
		await deletePlayerBookmarksByFamily(db, 'family-race');

		expect(await addPlayerBookmark(db, 'p-race', 'family-race', 2)).toBe('family_missing');
		expect(await listPlayerBookmarks(db, 'p-race')).toEqual([]);
	});

	it('refuses an insert that lands between ownership delete and bookmark sweep', async () => {
		// Same race, narrower window: the insert arrives after the ownership
		// row is gone but before deletePlayerBookmarksByFamily runs. The fence
		// still rejects it — the earlier bookmark rows are swept normally.
		await seedFamily('family-window');
		await addPlayerBookmark(db, 'p-window-early', 'family-window', 1);

		await deletePuzzleFamilyOwnership(db, 'family-window');
		expect(await addPlayerBookmark(db, 'p-window-late', 'family-window', 2)).toBe('family_missing');

		await deletePlayerBookmarksByFamily(db, 'family-window');
		expect(await listPlayerBookmarks(db, 'p-window-early')).toEqual([]);
		expect(await listPlayerBookmarks(db, 'p-window-late')).toEqual([]);
	});
});
