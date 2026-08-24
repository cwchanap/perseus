// Browser session persistence: the web-owned storage namespace and global
// resolution wrapped around the shared game-core session semantics.
//
// Web-local here: the `puzzle-progress-` key prefix, localStorage resolution
// with a throwing fallback, browser-global crypto resolution, and resumable
// candidate enumeration. The session codec (serialize/load/validate/resume)
// and the adapter semantics live in @perseus/game-core and are never
// re-implemented here.
import {
	CURRENT_SESSION_SCHEMA_VERSION,
	createRunIdFactory,
	createSessionStorageAdapter as createPortableSessionStorageAdapter,
	isResumable,
	type PersistedPuzzleSessionV1,
	type RunIdCrypto,
	type RunIdFactory,
	type SessionKeyValueStore,
	type SessionPersistenceError,
	type SessionStorageAdapter
} from '@perseus/game-core';

/**
 * Factory for fresh canonical lowercase UUID v4 run ids. Resolves the
 * browser-global `crypto` exactly as before (injected source wins, then
 * `globalThis.crypto`) and delegates formatting to the portable game-core
 * factory. When no crypto source is available anywhere, construction still
 * succeeds and `create()` throws on use — the legacy browser behavior.
 */
export function createBrowserRunIdFactory(cryptoSource?: Crypto): RunIdFactory {
	const source =
		cryptoSource ??
		(typeof crypto !== 'undefined'
			? (globalThis as unknown as { crypto: Crypto }).crypto
			: undefined);
	// A structurally-absent source is passed through: the portable factory
	// dereferences it only inside create(), preserving the throw-on-use
	// behavior covered by the crypto-unavailable edge tests.
	return createRunIdFactory(source as RunIdCrypto);
}

const PROGRESS_KEY_PREFIX = 'puzzle-progress-';

function progressKey(puzzleId: string): string {
	return `${PROGRESS_KEY_PREFIX}${puzzleId}`;
}

function resolveSessionStorage(storage?: Storage): Storage {
	return (
		storage ??
		(typeof localStorage !== 'undefined' ? localStorage : undefined) ??
		noopThrowingStorage
	);
}

export function listResumableSessionCandidateIds(storage?: Storage): string[] {
	const resolved = resolveSessionStorage(storage);
	const ids = new Set<string>();

	try {
		for (let index = 0; index < resolved.length; index += 1) {
			const key = resolved.key(index);
			if (!key?.startsWith(PROGRESS_KEY_PREFIX)) continue;
			const puzzleId = key.slice(PROGRESS_KEY_PREFIX.length);
			if (!puzzleId) continue;

			const raw = resolved.getItem(key);
			if (raw === null) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				continue;
			}
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
			const record = parsed as Record<string, unknown>;
			if (record.schemaVersion !== CURRENT_SESSION_SCHEMA_VERSION) continue;
			if (record.puzzleId !== puzzleId) continue;
			// The portable codec owns the resumable predicate. It reads only the
			// lifecycle/sealedCompletion/hasUserActivity fields, so the raw
			// (schema- and id-checked) record is a safe structural stand-in for
			// the snapshot type.
			if (!isResumable(record as unknown as PersistedPuzzleSessionV1)) continue;
			ids.add(puzzleId);
		}
	} catch {
		return [];
	}

	return [...ids];
}

export function createSessionStorageAdapter(options?: {
	storage?: Storage;
	onError?: (error: SessionPersistenceError) => void;
}): SessionStorageAdapter {
	const storage = resolveSessionStorage(options?.storage);
	const store: SessionKeyValueStore = {
		getItem: (puzzleId) => storage.getItem(progressKey(puzzleId)),
		setItem: (puzzleId, value) => storage.setItem(progressKey(puzzleId), value),
		removeItem: (puzzleId) => storage.removeItem(progressKey(puzzleId))
	};
	return createPortableSessionStorageAdapter({ store, onError: options?.onError });
}

/** Storage stub used when no localStorage is available. Exported for tests. */
export const noopThrowingStorage: Storage = {
	get length() {
		return 0;
	},
	key: () => null,
	getItem: () => null,
	setItem: () => {
		throw new Error('storage_unavailable');
	},
	removeItem: () => {},
	clear: () => {}
};
