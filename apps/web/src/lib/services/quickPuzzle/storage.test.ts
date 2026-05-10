import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { saveQuick, getQuick, listQuick, deleteQuick } from './storage';
import {
	QUICK_PUZZLE_INDEX_KEY,
	QUICK_PUZZLE_KEY_PREFIX,
	QUICK_PUZZLE_SCHEMA_VERSION,
	QUICK_PUZZLE_TTL_MS,
	type StoredQuickPuzzle
} from './types';

function makePuzzle(overrides: Partial<StoredQuickPuzzle> = {}): StoredQuickPuzzle {
	return {
		id: 'q-test-id',
		name: 'Test',
		pieceCount: 4,
		gridRows: 2,
		gridCols: 2,
		imageWidth: 100,
		imageHeight: 100,
		imageDataUrl: 'data:image/jpeg;base64,/9j/AAAA',
		pieces: [],
		createdAt: Date.now(),
		schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION,
		...overrides
	};
}

describe('saveQuick', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('persists a new puzzle and adds it to the index', () => {
		const puzzle = makePuzzle({ id: 'q-a' });
		const result = saveQuick(puzzle);
		expect(result).toEqual({ persisted: true });
		expect(JSON.parse(localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}q-a`)!)).toEqual(puzzle);
		expect(JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!)).toEqual({
			ids: ['q-a'],
			schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION
		});
	});

	it('prepends new puzzle so list is newest-first', () => {
		saveQuick(makePuzzle({ id: 'q-1', createdAt: 1000 }));
		saveQuick(makePuzzle({ id: 'q-2', createdAt: 2000 }));
		const index = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!);
		expect(index.ids).toEqual(['q-2', 'q-1']);
	});

	it('evicts oldest when index already has 5 entries', () => {
		for (let i = 1; i <= 5; i++) {
			saveQuick(makePuzzle({ id: `q-${i}`, createdAt: i * 1000 }));
		}
		saveQuick(makePuzzle({ id: 'q-6', createdAt: 6000 }));

		const index = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!);
		expect(index.ids).toEqual(['q-6', 'q-5', 'q-4', 'q-3', 'q-2']);
		expect(localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}q-1`)).toBeNull();
	});

	it('returns { persisted: false } and does not mutate index on QuotaExceededError', () => {
		saveQuick(makePuzzle({ id: 'q-existing' }));
		const indexBefore = localStorage.getItem(QUICK_PUZZLE_INDEX_KEY);

		const original = Storage.prototype.setItem;
		const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
			this: Storage,
			key: string,
			value: string
		) {
			if (key.startsWith(QUICK_PUZZLE_KEY_PREFIX) && key !== QUICK_PUZZLE_INDEX_KEY) {
				const err = new DOMException('Quota exceeded', 'QuotaExceededError');
				throw err;
			}
			original.call(this, key, value);
		});

		try {
			const result = saveQuick(makePuzzle({ id: 'q-new' }));
			expect(result).toEqual({ persisted: false });
			expect(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)).toBe(indexBefore);
			expect(localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}q-new`)).toBeNull();
		} finally {
			spy.mockRestore();
		}
	});
});

describe('getQuick', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns null when no entry exists', () => {
		expect(getQuick('q-missing')).toBeNull();
	});

	it('returns the stored puzzle', () => {
		const puzzle = makePuzzle({ id: 'q-foo' });
		saveQuick(puzzle);
		expect(getQuick('q-foo')).toEqual(puzzle);
	});

	it('returns null and removes per-puzzle key when entry is older than 7 days', () => {
		const start = new Date('2026-05-01T00:00:00Z').getTime();
		vi.useFakeTimers();
		vi.setSystemTime(start);
		saveQuick(makePuzzle({ id: 'q-old', createdAt: start }));

		// Advance just past 7 days
		vi.setSystemTime(start + QUICK_PUZZLE_TTL_MS + 1);
		expect(getQuick('q-old')).toBeNull();
		expect(localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}q-old`)).toBeNull();
	});

	it('returns null when stored entry has mismatched schemaVersion', () => {
		const puzzle = makePuzzle({ id: 'q-bad' });
		localStorage.setItem(
			`${QUICK_PUZZLE_KEY_PREFIX}q-bad`,
			JSON.stringify({ ...puzzle, schemaVersion: 99 })
		);
		expect(getQuick('q-bad')).toBeNull();
	});

	it('returns null when stored JSON is malformed', () => {
		localStorage.setItem(`${QUICK_PUZZLE_KEY_PREFIX}q-bad`, '{not json');
		expect(getQuick('q-bad')).toBeNull();
	});
});

describe('listQuick', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns empty array when no index exists', () => {
		expect(listQuick()).toEqual([]);
	});

	it('returns puzzles in newest-first order', () => {
		saveQuick(makePuzzle({ id: 'q-a', createdAt: 1000 }));
		saveQuick(makePuzzle({ id: 'q-b', createdAt: 2000 }));
		const list = listQuick();
		expect(list.map((p) => p.id)).toEqual(['q-b', 'q-a']);
	});

	it('drops entries with mismatched schemaVersion and persists cleaned index', () => {
		saveQuick(makePuzzle({ id: 'q-good' }));
		localStorage.setItem(
			`${QUICK_PUZZLE_KEY_PREFIX}q-bad`,
			JSON.stringify({ ...makePuzzle({ id: 'q-bad' }), schemaVersion: 99 })
		);
		// Manually inject q-bad into the index
		const index = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!);
		index.ids = ['q-bad', ...index.ids];
		localStorage.setItem(QUICK_PUZZLE_INDEX_KEY, JSON.stringify(index));

		const list = listQuick();
		expect(list.map((p) => p.id)).toEqual(['q-good']);
		const indexAfter = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!);
		expect(indexAfter.ids).toEqual(['q-good']);
	});

	it('drops orphaned index entries (per-puzzle key missing)', () => {
		saveQuick(makePuzzle({ id: 'q-keep' }));
		const index = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!);
		index.ids = ['q-orphan', ...index.ids];
		localStorage.setItem(QUICK_PUZZLE_INDEX_KEY, JSON.stringify(index));

		const list = listQuick();
		expect(list.map((p) => p.id)).toEqual(['q-keep']);
	});

	it('drops entries past 7-day TTL', () => {
		const start = new Date('2026-05-01T00:00:00Z').getTime();
		vi.useFakeTimers();
		vi.setSystemTime(start);
		saveQuick(makePuzzle({ id: 'q-old', createdAt: start }));
		saveQuick(makePuzzle({ id: 'q-new', createdAt: start + 1000 }));

		vi.setSystemTime(start + QUICK_PUZZLE_TTL_MS + 1);
		const list = listQuick();
		expect(list.map((p) => p.id)).toEqual(['q-new']);
	});
});

describe('deleteQuick', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('removes per-puzzle key and index entry', () => {
		saveQuick(makePuzzle({ id: 'q-a' }));
		saveQuick(makePuzzle({ id: 'q-b' }));
		deleteQuick('q-a');

		expect(localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}q-a`)).toBeNull();
		const index = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!);
		expect(index.ids).toEqual(['q-b']);
	});

	it('is a no-op for unknown ids', () => {
		expect(() => deleteQuick('q-missing')).not.toThrow();
	});
});
