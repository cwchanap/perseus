import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	saveQuick,
	getQuick,
	listQuick,
	deleteQuick,
	_resetStorageAvailableCache
} from './storage';
import {
	QUICK_PUZZLE_INDEX_KEY,
	QUICK_PUZZLE_KEY_PREFIX,
	QUICK_PUZZLE_SCHEMA_VERSION,
	QUICK_PUZZLE_TTL_MS,
	type StoredQuickPuzzle
} from './types';

const PROGRESS_KEY_PREFIX = 'puzzle-progress-';
const STATS_KEY_PREFIX = 'puzzle-stats-';

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

function seedCompanionKeys(id: string): void {
	localStorage.setItem(`${PROGRESS_KEY_PREFIX}${id}`, JSON.stringify({ puzzleId: id }));
	localStorage.setItem(`${STATS_KEY_PREFIX}${id}`, JSON.stringify({ puzzleId: id, bestTime: 42 }));
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
		saveQuick(makePuzzle({ id: 'q-1', createdAt: Date.now() - 2000 }));
		saveQuick(makePuzzle({ id: 'q-2', createdAt: Date.now() - 1000 }));
		const index = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!);
		expect(index.ids).toEqual(['q-2', 'q-1']);
	});

	it('evicts oldest when index already has 5 entries', () => {
		const now = Date.now();
		for (let i = 1; i <= 5; i++) {
			saveQuick(makePuzzle({ id: `q-${i}`, createdAt: now - (10 - i) * 1000 }));
		}
		seedCompanionKeys('q-1');
		saveQuick(makePuzzle({ id: 'q-6', createdAt: now }));

		const index = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!);
		expect(index.ids).toEqual(['q-6', 'q-5', 'q-4', 'q-3', 'q-2']);
		expect(localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}q-1`)).toBeNull();
		expect(localStorage.getItem(`${PROGRESS_KEY_PREFIX}q-1`)).toBeNull();
		expect(localStorage.getItem(`${STATS_KEY_PREFIX}q-1`)).toBeNull();
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

	it('persists eviction but not failed id when QuotaExceededError fires after eviction', () => {
		// Pre-fill index with the 5-puzzle cap, ascending createdAt.
		const now = Date.now();
		for (let i = 1; i <= 5; i++) {
			saveQuick(makePuzzle({ id: `q-${i}`, createdAt: now - (10 - i) * 1000 }));
		}
		expect(
			(JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!) as { ids: string[] }).ids
		).toEqual(['q-5', 'q-4', 'q-3', 'q-2', 'q-1']);

		// Throw only on the new puzzle's per-puzzle write; allow index writes and existing
		// keys to pass through (eviction uses removeItem, not setItem, so unaffected).
		const original = Storage.prototype.setItem;
		const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
			this: Storage,
			key: string,
			value: string
		) {
			if (key === `${QUICK_PUZZLE_KEY_PREFIX}q-new`) {
				throw new DOMException('Quota exceeded', 'QuotaExceededError');
			}
			original.call(this, key, value);
		});

		try {
			const result = saveQuick(makePuzzle({ id: 'q-new', createdAt: now }));
			expect(result).toEqual({ persisted: false });

			// q-1 (oldest) should have been evicted before the failing setItem.
			expect(localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}q-1`)).toBeNull();
			// Index should reflect the eviction but NOT include q-new.
			const indexAfter = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!) as {
				ids: string[];
			};
			expect(indexAfter.ids).toEqual(['q-5', 'q-4', 'q-3', 'q-2']);
			expect(indexAfter.ids).not.toContain('q-new');
			// q-new's per-puzzle key was not created.
			expect(localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}q-new`)).toBeNull();
		} finally {
			spy.mockRestore();
		}
	});

	it('rethrows unexpected storage write errors', () => {
		const error = new TypeError('bad write');
		const original = Storage.prototype.setItem;
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
			this: Storage,
			key: string,
			value: string
		) {
			if (key === `${QUICK_PUZZLE_KEY_PREFIX}q-new`) {
				throw error;
			}
			original.call(this, key, value);
		});

		try {
			expect(() => saveQuick(makePuzzle({ id: 'q-new' }))).toThrow('bad write');
			expect(consoleSpy).toHaveBeenCalledWith('Failed to save quick puzzle to localStorage', {
				id: 'q-new',
				keyPrefix: QUICK_PUZZLE_KEY_PREFIX,
				error
			});
		} finally {
			spy.mockRestore();
			consoleSpy.mockRestore();
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
		seedCompanionKeys('q-old');

		// Advance just past 7 days
		vi.setSystemTime(start + QUICK_PUZZLE_TTL_MS + 1);
		expect(getQuick('q-old')).toBeNull();
		expect(localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}q-old`)).toBeNull();
		expect(localStorage.getItem(`${PROGRESS_KEY_PREFIX}q-old`)).toBeNull();
		expect(localStorage.getItem(`${STATS_KEY_PREFIX}q-old`)).toBeNull();
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
		saveQuick(makePuzzle({ id: 'q-a', createdAt: Date.now() - 2000 }));
		saveQuick(makePuzzle({ id: 'q-b', createdAt: Date.now() - 1000 }));
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
		// Corrupt per-puzzle key must also be removed to free localStorage quota
		expect(localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}q-bad`)).toBeNull();
	});

	it('drops orphaned index entries (per-puzzle key missing)', () => {
		saveQuick(makePuzzle({ id: 'q-keep' }));
		const index = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!);
		index.ids = ['q-orphan', ...index.ids];
		localStorage.setItem(QUICK_PUZZLE_INDEX_KEY, JSON.stringify(index));

		const list = listQuick();
		expect(list.map((p) => p.id)).toEqual(['q-keep']);
	});

	it('removes per-puzzle key when entry has corrupt JSON', () => {
		saveQuick(makePuzzle({ id: 'q-keep' }));
		// Write corrupt data that will fail JSON.parse
		localStorage.setItem(`${QUICK_PUZZLE_KEY_PREFIX}q-corrupt`, '{not json');
		const index = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!);
		index.ids = ['q-corrupt', ...index.ids];
		localStorage.setItem(QUICK_PUZZLE_INDEX_KEY, JSON.stringify(index));

		const list = listQuick();
		expect(list.map((p) => p.id)).toEqual(['q-keep']);
		// Corrupt per-puzzle key must be removed to free localStorage quota
		expect(localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}q-corrupt`)).toBeNull();
	});

	it('drops entries past 7-day TTL', () => {
		const start = new Date('2026-05-01T00:00:00Z').getTime();
		vi.useFakeTimers();
		vi.setSystemTime(start);
		saveQuick(makePuzzle({ id: 'q-old', createdAt: start }));
		saveQuick(makePuzzle({ id: 'q-new', createdAt: start + 1000 }));
		seedCompanionKeys('q-old');

		vi.setSystemTime(start + QUICK_PUZZLE_TTL_MS + 1);
		const list = listQuick();
		expect(list.map((p) => p.id)).toEqual(['q-new']);
		expect(localStorage.getItem(`${PROGRESS_KEY_PREFIX}q-old`)).toBeNull();
		expect(localStorage.getItem(`${STATS_KEY_PREFIX}q-old`)).toBeNull();
	});
});

describe('deleteQuick', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('removes per-puzzle key and index entry', () => {
		saveQuick(makePuzzle({ id: 'q-a' }));
		saveQuick(makePuzzle({ id: 'q-b' }));
		seedCompanionKeys('q-a');
		deleteQuick('q-a');

		expect(localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}q-a`)).toBeNull();
		expect(localStorage.getItem(`${PROGRESS_KEY_PREFIX}q-a`)).toBeNull();
		expect(localStorage.getItem(`${STATS_KEY_PREFIX}q-a`)).toBeNull();
		const index = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!);
		expect(index.ids).toEqual(['q-b']);
	});

	it('is a no-op for unknown ids', () => {
		expect(() => deleteQuick('q-missing')).not.toThrow();
	});
});

describe('blocked localStorage (SecurityError)', () => {
	// Simulate blocked site storage by making all localStorage methods throw.
	function blockLocalStorage() {
		const spies = [
			vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
				throw new DOMException('The operation is insecure.', 'SecurityError');
			}),
			vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
				throw new DOMException('The operation is insecure.', 'SecurityError');
			}),
			vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
				throw new DOMException('The operation is insecure.', 'SecurityError');
			})
		];
		return spies;
	}

	beforeEach(() => {
		_resetStorageAvailableCache();
	});

	afterEach(() => {
		_resetStorageAvailableCache();
		vi.restoreAllMocks();
	});

	it('saveQuick returns { persisted: false } without throwing', () => {
		const spies = blockLocalStorage();
		const result = saveQuick(makePuzzle({ id: 'q-blocked' }));
		expect(result).toEqual({ persisted: false });
		spies.forEach((s) => s.mockRestore());
	});

	it('getQuick returns null without throwing', () => {
		const spies = blockLocalStorage();
		expect(getQuick('q-blocked')).toBeNull();
		spies.forEach((s) => s.mockRestore());
	});

	it('listQuick returns empty array without throwing', () => {
		const spies = blockLocalStorage();
		expect(listQuick()).toEqual([]);
		spies.forEach((s) => s.mockRestore());
	});

	it('deleteQuick does not throw', () => {
		const spies = blockLocalStorage();
		expect(() => deleteQuick('q-blocked')).not.toThrow();
		spies.forEach((s) => s.mockRestore());
	});
});
