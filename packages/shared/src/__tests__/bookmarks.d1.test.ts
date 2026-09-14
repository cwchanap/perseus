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
	listPlayerBookmarks,
	removePlayerBookmark
} from '../bookmarks';
import { completeFamilyDeletionCleanup, insertFamilyDeletionTombstone } from '../repositories';

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
 * Inserts a puzzle_families ownership row for tests that need the mirror
 * present. The bookmark fence does not read this table — the row exists only
 * so deletion-cleanup tests can verify it gets removed.
 */
async function seedOwnership(...familyIds: string[]) {
	const stmt =
		'INSERT OR IGNORE INTO puzzle_families ' +
		'(id, owner_id, name, aspect_ratio, status, created_at) VALUES (?, ?, ?, ?, ?, ?)';
	await d1.batch(
		familyIds.map((id, i) =>
			d1.prepare(stmt).bind(id, 'system', `family ${id}`, '4:3', 'ready', i + 1)
		)
	);
}

/** Reads the family's tombstone row, if the deletion fence has written one. */
async function readFamilyTombstone(familyId: string) {
	return d1
		.prepare('SELECT family_id, deleted_at FROM family_deletion_tombstones WHERE family_id = ?')
		.bind(familyId)
		.first();
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

	it('sweeps the ownership row and every bookmark row, and writes the tombstone', async () => {
		await seedOwnership('family-gone', 'family-kept');
		await addPlayerBookmark(db, 'df-1', 'family-gone', 1);
		await addPlayerBookmark(db, 'df-2', 'family-gone', 2);
		await addPlayerBookmark(db, 'df-1', 'family-kept', 3);

		await completeFamilyDeletionCleanup(db, 'family-gone', 42);

		expect(await listPlayerBookmarks(db, 'df-1')).toEqual([
			{ familyId: 'family-kept', createdAt: 3 }
		]);
		expect(await listPlayerBookmarks(db, 'df-2')).toEqual([]);
		expect(await readFamilyTombstone('family-gone')).toEqual({
			family_id: 'family-gone',
			deleted_at: 42
		});
		const ownershipRows = await d1
			.prepare('SELECT id FROM puzzle_families WHERE id IN (?, ?) ORDER BY id')
			.bind('family-gone', 'family-kept')
			.all();
		expect(ownershipRows.results).toEqual([{ id: 'family-kept' }]);
		// Idempotent: the fenced deletion path retries this on partial failure.
		await expect(completeFamilyDeletionCleanup(db, 'family-gone', 43)).resolves.toBeUndefined();
		// The original tombstone survives the retry (onConflictDoNothing).
		expect(await readFamilyTombstone('family-gone')).toEqual({
			family_id: 'family-gone',
			deleted_at: 42
		});
	});

	it('frees cap slots held by bookmarks for a deleted family', async () => {
		await seedBookmarks('cap-deleted', MAX_PLAYER_BOOKMARKS);
		expect(await addPlayerBookmark(db, 'cap-deleted', 'family-new')).toBe('limit_reached');

		await completeFamilyDeletionCleanup(db, 'seeded-0');

		expect(await addPlayerBookmark(db, 'cap-deleted', 'family-new')).toBe('added');
	});

	it('never lists more than MAX_PLAYER_BOOKMARKS rows', async () => {
		await seedBookmarks('cap-3', MAX_PLAYER_BOOKMARKS + 10);
		const rows = await listPlayerBookmarks(db, 'cap-3');
		expect(rows.length).toBeLessThanOrEqual(MAX_PLAYER_BOOKMARKS);
	});

	it('adds a bookmark for a live family whose ownership mirror is missing', async () => {
		// Regression: the admin publish path writes the puzzle_families row
		// best-effort, so a family can be KV-ready and playable with no D1
		// ownership row. The tombstone fence — not the mirror — must decide.
		expect(await addPlayerBookmark(db, 'p-unmirrored', 'never-mirrored', 1)).toBe('added');
		expect(await listPlayerBookmarks(db, 'p-unmirrored')).toEqual([
			{ familyId: 'never-mirrored', createdAt: 1 }
		]);
	});

	it('returns family_missing and writes nothing once the family tombstone exists', async () => {
		await insertFamilyDeletionTombstone(db, 'family-deleted', 1);
		expect(await addPlayerBookmark(db, 'p-gone', 'family-deleted', 2)).toBe('family_missing');
		expect(await listPlayerBookmarks(db, 'p-gone')).toEqual([]);
	});

	it('prefers existing over family_missing for a persisted row', async () => {
		// A bookmark row that outlives its family's tombstone (swept
		// asynchronously, or a pre-fence straggler) still reports 'existing' —
		// the add is a no-op and stays idempotent rather than surfacing a
		// spurious error.
		await addPlayerBookmark(db, 'p-orphan', 'family-orphaned', 1);
		await insertFamilyDeletionTombstone(db, 'family-orphaned', 2);
		expect(await addPlayerBookmark(db, 'p-orphan', 'family-orphaned', 3)).toBe('existing');
	});

	it('returns family_missing over limit_reached for a tombstoned family at the cap', async () => {
		await seedBookmarks('cap-tombstoned', MAX_PLAYER_BOOKMARKS);
		await insertFamilyDeletionTombstone(db, 'family-capped-gone', 1);
		expect(await addPlayerBookmark(db, 'cap-tombstoned', 'family-capped-gone', 2)).toBe(
			'family_missing'
		);
	});

	it('cannot resurrect a bookmark after family deletion cleanup ran', async () => {
		// Pins the PUT-vs-deletion race: the route's KV readiness check can pass
		// (or read stale KV) while the family's deletion cleanup commits the
		// tombstone + ownership delete + bookmark sweep in one batch. An insert
		// ordered after that batch is refused by the tombstone instead of
		// leaving an invisible row that counts toward the cap.
		expect(await addPlayerBookmark(db, 'p-race', 'family-race', 1)).toBe('added');

		await completeFamilyDeletionCleanup(db, 'family-race');

		expect(await addPlayerBookmark(db, 'p-race', 'family-race', 2)).toBe('family_missing');
		expect(await listPlayerBookmarks(db, 'p-race')).toEqual([]);
	});

	it('refuses inserts once the fence-time tombstone lands, even before the sweep', async () => {
		// ensureWorkerPuzzleDeletionFence writes the tombstone at the start of
		// deletion; the row sweep only happens when the cleanup completes. An
		// insert between those points is refused, and the earlier row is swept
		// normally when the cleanup batch commits.
		await addPlayerBookmark(db, 'p-window-early', 'family-window', 1);

		await insertFamilyDeletionTombstone(db, 'family-window', 2);
		expect(await addPlayerBookmark(db, 'p-window-late', 'family-window', 3)).toBe('family_missing');
		expect(await listPlayerBookmarks(db, 'p-window-early')).toEqual([
			{ familyId: 'family-window', createdAt: 1 }
		]);

		await completeFamilyDeletionCleanup(db, 'family-window');
		expect(await listPlayerBookmarks(db, 'p-window-early')).toEqual([]);
		expect(await listPlayerBookmarks(db, 'p-window-late')).toEqual([]);
	});
});
