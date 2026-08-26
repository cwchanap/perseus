// Generic peek/load/save/clear/error semantics of the session persistence
// adapter over the three-method SessionKeyValueStore, moved from web
// persistence.test.ts / persistence.validation-storage.test.ts. The browser
// key-prefix and Storage enumeration tests stay web-local.
import { describe, it, expect } from 'vitest';
import { createSessionStorageAdapter, type SessionKeyValueStore } from './storage';
import { context, validSnapshot } from './codec.test-fixtures';
import type { SessionPersistenceError } from './types';

const ctx = context;

function memoryStore(map: Record<string, string> = {}): SessionKeyValueStore {
	return {
		getItem: (key) => (key in map ? map[key]! : null),
		setItem: (key, value) => {
			map[key] = value;
		},
		removeItem: (key) => {
			delete map[key];
		}
	};
}

describe('createSessionStorageAdapter', () => {
	it('clears unversioned stored state and reports missing', () => {
		const map: Record<string, string> = {};
		const store = memoryStore(map);
		store.setItem('pz1', JSON.stringify({ puzzleId: 'pz1', placedPieces: [], lastUpdated: 10 }));
		const adapter = createSessionStorageAdapter({ store });

		expect(adapter.loadSession('pz1', ctx)).toEqual({ status: 'missing' });
		expect(store.getItem('pz1')).toBeNull();
	});

	it('clears a different schema version and reports missing', () => {
		const map: Record<string, string> = {};
		const store = memoryStore(map);
		store.setItem('pz1', JSON.stringify({ schemaVersion: 2, puzzleId: 'pz1' }));
		const adapter = createSessionStorageAdapter({ store });

		expect(adapter.loadSession('pz1', ctx)).toEqual({ status: 'missing' });
		expect(store.getItem('pz1')).toBeNull();
	});

	it('round-trips a snapshot through storage and reports loaded', () => {
		const map: Record<string, string> = {};
		const store = memoryStore(map);
		const adapter = createSessionStorageAdapter({ store });

		adapter.saveSession('pz1', validSnapshot());

		const result = adapter.loadSession('pz1', ctx);
		expect(result.status).toBe('loaded');
		expect(map['pz1']).toBeDefined();
	});

	it('reports missing when no key exists', () => {
		const adapter = createSessionStorageAdapter({ store: memoryStore() });
		expect(adapter.loadSession('pz1', ctx).status).toBe('missing');
	});

	it('clear removes the key', () => {
		const map: Record<string, string> = {};
		const store = memoryStore(map);
		const adapter = createSessionStorageAdapter({ store });
		adapter.saveSession('pz1', validSnapshot());
		expect(adapter.clearSession('pz1')).toBe(true);
		expect(map['pz1']).toBeUndefined();
	});

	it('reports write errors through onError without throwing', () => {
		const errors: string[] = [];
		const store = memoryStore({});
		store.setItem = () => {
			throw new Error('quota');
		};
		const adapter = createSessionStorageAdapter({ store, onError: (e) => errors.push(e.kind) });

		expect(() => adapter.saveSession('pz1', validSnapshot())).not.toThrow();
		expect(errors).toContain('write_error');
	});

	it('reports read errors through onError and loads as missing', () => {
		const errors: string[] = [];
		const store = memoryStore({});
		store.getItem = () => {
			throw new Error('read denied');
		};
		const adapter = createSessionStorageAdapter({ store, onError: (e) => errors.push(e.kind) });

		expect(adapter.loadSession('pz1', ctx).status).toBe('missing');
		expect(errors).toContain('read_error');
	});

	it('reports remove errors through onError without throwing', () => {
		const errors: string[] = [];
		const store = memoryStore({});
		store.removeItem = () => {
			throw new Error('remove denied');
		};
		const adapter = createSessionStorageAdapter({ store, onError: (e) => errors.push(e.kind) });

		expect(() => adapter.clearSession('pz1')).not.toThrow();
		expect(adapter.clearSession('pz1')).toBe(false);
		expect(errors).toContain('remove_error');
	});

	it('peekSession reports invalid data without removing it', () => {
		const snapshot = validSnapshot();
		const raw = JSON.stringify({ ...snapshot, schemaVersion: 999 });
		const map = { pz1: raw };
		const adapter = createSessionStorageAdapter({ store: memoryStore(map) });

		expect(adapter.peekSession('pz1', ctx)).toEqual({
			status: 'invalid',
			reason: 'unsupported_schema_version'
		});
		expect(map['pz1']).toBe(raw);
	});

	it('loadSession still removes invalid data', () => {
		const snapshot = validSnapshot();
		const map = { pz1: JSON.stringify({ ...snapshot, schemaVersion: 999 }) };
		const adapter = createSessionStorageAdapter({ store: memoryStore(map) });

		expect(adapter.loadSession('pz1', ctx)).toEqual({ status: 'missing' });
		expect(map['pz1']).toBeUndefined();
	});

	it('reports storage read and remove failures', () => {
		const errors: SessionPersistenceError[] = [];
		const store = memoryStore({});
		store.getItem = () => {
			throw new Error('read failed');
		};
		store.removeItem = () => {
			throw new Error('remove failed');
		};
		const adapter = createSessionStorageAdapter({
			store,
			onError: (error) => errors.push(error)
		});

		expect(adapter.loadSession('pz1', ctx).status).toBe('missing');
		expect(adapter.clearSession('pz1')).toBe(false);
		expect(errors.map((error) => error.kind)).toEqual(['read_error', 'remove_error']);
	});
});

describe('createSessionStorageAdapter error paths without onError', () => {
	it('swallows read errors silently when no onError is provided', () => {
		const store = memoryStore({});
		store.getItem = () => {
			throw new Error('read denied');
		};
		const adapter = createSessionStorageAdapter({ store });

		expect(adapter.loadSession('pz1', ctx).status).toBe('missing');
	});

	it('swallows write errors silently when no onError is provided', () => {
		const store = memoryStore({});
		store.setItem = () => {
			throw new Error('quota');
		};
		const adapter = createSessionStorageAdapter({ store });

		expect(() => adapter.saveSession('pz1', validSnapshot())).not.toThrow();
	});

	it('swallows remove errors silently when no onError is provided', () => {
		const store = memoryStore({});
		store.removeItem = () => {
			throw new Error('remove denied');
		};
		const adapter = createSessionStorageAdapter({ store });

		expect(() => adapter.clearSession('pz1')).not.toThrow();
		expect(adapter.clearSession('pz1')).toBe(false);
	});
});
