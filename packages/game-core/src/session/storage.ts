// Session persistence adapter generalized over a minimal key-value store.
//
// The three-method SessionKeyValueStore is satisfied by the browser
// localStorage-backed store (web owns the key prefix) or a NativeScript
// application-settings-backed store; the adapter semantics live here, once.
import type {
	SessionLoadResult,
	SessionPersistenceError,
	SessionValidationContext,
	SessionStorageAdapter,
	PersistedPuzzleSessionV1
} from './types';
import { loadPersistedSession, isResumable } from './codec';

export interface SessionKeyValueStore {
	getItem(puzzleId: string): string | null;
	setItem(puzzleId: string, value: string): void;
	removeItem(puzzleId: string): void;
}

export function createSessionStorageAdapter(options: {
	store: SessionKeyValueStore;
	onError?: (error: SessionPersistenceError) => void;
}): SessionStorageAdapter {
	const { store, onError } = options;

	function readSession(puzzleId: string, context: SessionValidationContext): SessionLoadResult {
		try {
			return loadPersistedSession(store.getItem(puzzleId), context);
		} catch (cause) {
			onError?.({ kind: 'read_error', puzzleId, cause });
			return { status: 'missing' };
		}
	}

	return {
		peekSession: readSession,
		loadSession(puzzleId, context) {
			const result = readSession(puzzleId, context);
			if (result.status !== 'invalid') return result;
			try {
				store.removeItem(puzzleId);
			} catch (cause) {
				onError?.({ kind: 'remove_error', puzzleId, cause });
			}
			return { status: 'missing' };
		},
		saveSession(puzzleId, snapshot) {
			try {
				store.setItem(puzzleId, JSON.stringify(snapshot));
			} catch (cause) {
				onError?.({ kind: 'write_error', puzzleId, cause });
			}
		},
		clearSession(puzzleId) {
			try {
				store.removeItem(puzzleId);
			} catch (cause) {
				onError?.({ kind: 'remove_error', puzzleId, cause });
				return false;
			}
			return true;
		},
		isResumable
	};
}
