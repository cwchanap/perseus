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

function removeEntry(id: string): void {
	if (!isBrowser()) return;
	localStorage.removeItem(`${QUICK_PUZZLE_KEY_PREFIX}${id}`);
}

function isExpired(entry: StoredQuickPuzzle, now: number): boolean {
	return entry.createdAt + QUICK_PUZZLE_TTL_MS <= now;
}

function isQuotaExceededError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const { name } = error as { name?: unknown };
	return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
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
		if (!entry) {
			removeEntry(id); // remove orphaned/corrupt per-puzzle key to free quota
			continue;
		}

		if (isExpired(entry, now)) {
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

	if (isExpired(entry, Date.now())) {
		removeEntry(id);
		return null;
	}

	return entry;
}

/**
 * Persist a new puzzle. Evicts oldest entries until index has < QUICK_PUZZLE_MAX_COUNT.
 * Returns { persisted: false } if the per-puzzle write throws QuotaExceededError;
 * any evicted entries are removed from the index (and their per-puzzle keys deleted)
 * even when the new puzzle fails to persist — the freed space may allow a retry.
 * Non-quota errors are rethrown.
 */
export function saveQuick(stored: StoredQuickPuzzle): { persisted: boolean } {
	if (!isBrowser()) return { persisted: false };

	// listQuick prunes expired/orphaned entries first, freeing space.
	const survivors = listQuick();
	let ids = survivors.map((p) => p.id);

	// Evict oldest while at or above cap (we're about to add one).
	while (ids.length >= QUICK_PUZZLE_MAX_COUNT) {
		const evictId = ids[ids.length - 1];
		removeEntry(evictId);
		ids = ids.slice(0, -1);
	}

	try {
		localStorage.setItem(`${QUICK_PUZZLE_KEY_PREFIX}${stored.id}`, JSON.stringify(stored));
	} catch (error) {
		if (!isQuotaExceededError(error)) {
			console.error('Failed to save quick puzzle to localStorage', {
				id: stored.id,
				keyPrefix: QUICK_PUZZLE_KEY_PREFIX,
				error
			});
			throw error;
		}
		// Reflect any mid-flight eviction back to the index, but do NOT add the failed id.
		writeIndex({ ids, schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION });
		return { persisted: false };
	}

	const dedupedIds = [stored.id, ...ids.filter((id) => id !== stored.id)].slice(
		0,
		QUICK_PUZZLE_MAX_COUNT
	);
	writeIndex({ ids: dedupedIds, schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION });
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
