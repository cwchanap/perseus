import {
	QUICK_PUZZLE_INDEX_KEY,
	QUICK_PUZZLE_KEY_PREFIX,
	QUICK_PUZZLE_MAX_COUNT,
	QUICK_PUZZLE_SCHEMA_VERSION,
	QUICK_PUZZLE_TTL_MS,
	type QuickPuzzleIndex,
	type StoredQuickPuzzle
} from './types';

function isBrowser(): boolean {
	return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readIndexRaw(): QuickPuzzleIndex {
	if (!isBrowser()) return { ids: [], schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION };
	const raw = localStorage.getItem(QUICK_PUZZLE_INDEX_KEY);
	if (!raw) return { ids: [], schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION };

	try {
		const parsed = JSON.parse(raw) as Partial<QuickPuzzleIndex>;
		if (parsed.schemaVersion !== QUICK_PUZZLE_SCHEMA_VERSION) {
			return { ids: [], schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION };
		}
		if (!Array.isArray(parsed.ids)) {
			return { ids: [], schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION };
		}
		return {
			ids: parsed.ids.filter((id): id is string => typeof id === 'string'),
			schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION
		};
	} catch {
		return { ids: [], schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION };
	}
}

function writeIndex(index: QuickPuzzleIndex): void {
	if (!isBrowser()) return;
	localStorage.setItem(QUICK_PUZZLE_INDEX_KEY, JSON.stringify(index));
}

function readEntryRaw(id: string): StoredQuickPuzzle | null {
	if (!isBrowser()) return null;
	const raw = localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}${id}`);
	if (!raw) return null;

	try {
		const parsed = JSON.parse(raw) as StoredQuickPuzzle;
		if (parsed.schemaVersion !== QUICK_PUZZLE_SCHEMA_VERSION) return null;
		if (typeof parsed.id !== 'string' || typeof parsed.createdAt !== 'number') return null;
		return parsed;
	} catch {
		return null;
	}
}

const SAVED_AT_KEY_PREFIX = `${QUICK_PUZZLE_KEY_PREFIX}savedAt:`;

function readSavedAt(id: string): number | null {
	if (!isBrowser()) return null;
	const raw = localStorage.getItem(`${SAVED_AT_KEY_PREFIX}${id}`);
	if (!raw) return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}

function writeSavedAt(id: string, savedAt: number): void {
	if (!isBrowser()) return;
	localStorage.setItem(`${SAVED_AT_KEY_PREFIX}${id}`, String(savedAt));
}

function removeSavedAt(id: string): void {
	if (!isBrowser()) return;
	localStorage.removeItem(`${SAVED_AT_KEY_PREFIX}${id}`);
}

function removeEntry(id: string): void {
	if (!isBrowser()) return;
	localStorage.removeItem(`${QUICK_PUZZLE_KEY_PREFIX}${id}`);
	removeSavedAt(id);
}

/**
 * An entry is expired when the later of its declared createdAt or its actual savedAt,
 * plus TTL, has passed. Using the later of the two prevents fresh saves with an
 * artificially old createdAt from being immediately pruned, while still letting
 * legitimate future-dated createdAt values extend the lifetime.
 */
function isExpired(entry: StoredQuickPuzzle, savedAt: number | null, now: number): boolean {
	const basis = savedAt == null ? entry.createdAt : Math.max(entry.createdAt, savedAt);
	return basis + QUICK_PUZZLE_TTL_MS <= now;
}

/**
 * Read all surviving puzzles, newest-first.
 * Side effects: drops orphaned, expired, and schema-mismatched entries from the index
 * and removes their per-puzzle keys.
 */
export function listQuick(): StoredQuickPuzzle[] {
	if (!isBrowser()) return [];

	const index = readIndexRaw();
	const now = Date.now();
	const survivors: StoredQuickPuzzle[] = [];
	const survivingIds: string[] = [];

	for (const id of index.ids) {
		const entry = readEntryRaw(id);
		if (!entry) continue; // orphan or schema mismatch

		if (isExpired(entry, readSavedAt(id), now)) {
			removeEntry(id);
			continue;
		}

		survivors.push(entry);
		survivingIds.push(id);
	}

	if (survivingIds.length !== index.ids.length) {
		writeIndex({ ids: survivingIds, schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION });
	}

	return survivors;
}

/**
 * Read a single puzzle. Drops it (and its per-puzzle key) if expired or schema-mismatched.
 * Does not modify the index for orphan/expiry of a single id — leave that to listQuick.
 */
export function getQuick(id: string): StoredQuickPuzzle | null {
	if (!isBrowser()) return null;

	const entry = readEntryRaw(id);
	if (!entry) return null;

	if (isExpired(entry, readSavedAt(id), Date.now())) {
		removeEntry(id);
		return null;
	}

	return entry;
}

/**
 * Persist a new puzzle. Evicts oldest entries until index has < QUICK_PUZZLE_MAX_COUNT.
 * Returns { persisted: false } if the per-puzzle write throws QuotaExceededError;
 * the index is left unchanged in that case.
 */
export function saveQuick(stored: StoredQuickPuzzle): { persisted: boolean } {
	if (!isBrowser()) return { persisted: false };

	const index = readIndexRaw();
	// Strip any existing occurrence of stored.id so the prepend below is canonical.
	let ids = index.ids.filter((existing) => existing !== stored.id);
	let evicted = ids.length !== index.ids.length;

	// Evict oldest while at or above cap (we're about to add one).
	while (ids.length >= QUICK_PUZZLE_MAX_COUNT) {
		const evictId = ids[ids.length - 1];
		removeEntry(evictId);
		ids = ids.slice(0, -1);
		evicted = true;
	}

	try {
		localStorage.setItem(`${QUICK_PUZZLE_KEY_PREFIX}${stored.id}`, JSON.stringify(stored));
	} catch {
		// Only reflect evictions if any happened; otherwise leave the index untouched.
		if (evicted) {
			writeIndex({ ids, schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION });
		}
		// QuotaExceededError or other write failure: do not add the failed id to the index.
		return { persisted: false };
	}

	// Record save time in a side-channel so TTL pruning isn't fooled by an
	// artificially old createdAt. Best-effort: if this write fails (e.g. quota),
	// the puzzle is still persisted and listQuick falls back to createdAt.
	try {
		writeSavedAt(stored.id, Date.now());
	} catch {
		// ignore — fallback to createdAt-based TTL
	}

	const newIds = [stored.id, ...ids].slice(0, QUICK_PUZZLE_MAX_COUNT);
	writeIndex({ ids: newIds, schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION });
	return { persisted: true };
}

/**
 * Delete a puzzle and remove it from the index. No-op for unknown ids.
 */
export function deleteQuick(id: string): void {
	if (!isBrowser()) return;

	removeEntry(id);
	const index = readIndexRaw();
	const filtered = index.ids.filter((existing) => existing !== id);
	if (filtered.length !== index.ids.length) {
		writeIndex({ ids: filtered, schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION });
	}
}
