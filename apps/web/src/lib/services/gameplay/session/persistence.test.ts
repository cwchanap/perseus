// Red tests for PuzzleSession persistence: canonical run IDs and canonical JSON.
import { describe, it, expect, vi } from 'vitest';
import { canonicalJson, sha256Hex, legacyRunId, createBrowserRunIdFactory } from './persistence';
import { isPuzzleRunId } from '@perseus/types';

describe('createBrowserRunIdFactory', () => {
	describe('crypto.randomUUID path', () => {
		it('produces a lowercase UUID v4 accepted by isPuzzleRunId', () => {
			const factory = createBrowserRunIdFactory();
			const id = factory.create();

			expect(isPuzzleRunId(id)).toBe(true);
			expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			expect(id).toBe(id.toLowerCase());
		});

		it('produces unique ids across calls', () => {
			const factory = createBrowserRunIdFactory();
			const ids = new Set(Array.from({ length: 32 }, () => factory.create()));

			expect(ids.size).toBe(32);
		});
	});

	describe('getRandomValues fallback path', () => {
		function makeDeterministicCrypto(bytes: number[]): Crypto {
			let call = 0;
			return {
				getRandomValues: <T extends ArrayBufferView | null>(arr: T): T => {
					if (call > 0) throw new Error('unexpected second getRandomValues call');
					call++;
					const view = arr as unknown as ArrayBufferView;
					const out = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
					for (let i = 0; i < out.length; i++) {
						out[i] = bytes[i] ?? 0;
					}
					return arr;
				}
			} as unknown as Crypto;
		}

		it('formats 16 zero bytes as the canonical nil-ish v4 uuid', () => {
			const factory = createBrowserRunIdFactory(makeDeterministicCrypto(new Array(16).fill(0)));
			expect(factory.create()).toBe('00000000-0000-4000-8000-000000000000');
		});

		it('sets the version nibble to 4 and the variant nibble to 8-b', () => {
			const factory = createBrowserRunIdFactory(makeDeterministicCrypto(new Array(16).fill(0xff)));
			const id = factory.create();

			expect(isPuzzleRunId(id)).toBe(true);
			const parts = id.split('-');
			expect(parts[2][0]).toBe('4');
			expect('89ab').toContain(parts[3][0]);
		});

		it('passes deterministic bytes straight through (never uses Math.random)', () => {
			const bytes = [
				0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
				0x88
			];
			const factory = createBrowserRunIdFactory(makeDeterministicCrypto(bytes));
			// byte6: 0xde -> (0xde & 0x0f) | 0x40 = 0x4e; byte8: 0x11 -> (0x11 & 0x3f) | 0x80 = 0x91
			expect(factory.create()).toBe('12345678-9abc-4ef0-9122-334455667788');
		});

		it('lowercase output is accepted by isPuzzleRunId', () => {
			const factory = createBrowserRunIdFactory(makeDeterministicCrypto(new Array(16).fill(0xab)));
			const id = factory.create();

			expect(id).toBe(id.toLowerCase());
			expect(isPuzzleRunId(id)).toBe(true);
		});

		it('works when crypto.subtle is absent', () => {
			const crypto = makeDeterministicCrypto(new Array(16).fill(0));
			expect((crypto as unknown as { subtle?: unknown }).subtle).toBeUndefined();
			const factory = createBrowserRunIdFactory(crypto);

			expect(isPuzzleRunId(factory.create())).toBe(true);
		});
	});
});

describe('canonicalJson', () => {
	it('recursively sorts object keys at every depth', () => {
		expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
	});

	it('sorts deeply nested object keys', () => {
		expect(canonicalJson({ z: { y: { x: 1 } }, a: 2 })).toBe('{"a":2,"z":{"y":{"x":1}}}');
	});

	it('preserves array order', () => {
		expect(canonicalJson({ order: [3, 1, 2] })).toBe('{"order":[3,1,2]}');
	});

	it('sorts keys inside array elements but keeps element order', () => {
		expect(
			canonicalJson({
				items: [
					{ b: 1, a: 2 },
					{ d: 4, c: 3 }
				]
			})
		).toBe('{"items":[{"a":2,"b":1},{"c":3,"d":4}]}');
	});

	it('omits undefined object properties', () => {
		expect(canonicalJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
	});

	it('omits undefined nested object properties', () => {
		expect(canonicalJson({ a: { x: undefined, y: 1 } })).toBe('{"a":{"y":1}}');
	});

	it('keeps null values', () => {
		expect(canonicalJson({ a: null, b: 1 })).toBe('{"a":null,"b":1}');
	});

	it('preserves the original lastUpdated value in the serialized form', () => {
		const legacy = { puzzleId: 'p1', placedPieces: [], lastUpdated: '2024-01-01T00:00:00.000Z' };
		expect(canonicalJson(legacy)).toBe(
			'{"lastUpdated":"2024-01-01T00:00:00.000Z","placedPieces":[],"puzzleId":"p1"}'
		);
	});

	it('serializes primitives', () => {
		expect(canonicalJson('abc')).toBe('"abc"');
		expect(canonicalJson(42)).toBe('42');
		expect(canonicalJson(true)).toBe('true');
		expect(canonicalJson(null)).toBe('null');
	});
});

describe('sha256Hex', () => {
	it('matches the known vector for the empty string', () => {
		expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});

	it('matches the known vector for "abc"', () => {
		expect(sha256Hex('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});
});

describe('legacyRunId', () => {
	it('is legacy- followed by 64 lowercase hex characters', () => {
		const id = legacyRunId({ puzzleId: 'p1', placedPieces: [{ pieceId: 0, x: 0, y: 0 }] });
		expect(id).toMatch(/^legacy-[0-9a-f]{64}$/);
	});

	it('equals legacy- + sha256Hex(canonicalJson(value))', () => {
		const value = { b: 2, a: 1, lastUpdated: '2024-01-01T00:00:00.000Z' };
		expect(legacyRunId(value)).toBe(`legacy-${sha256Hex(canonicalJson(value))}`);
	});

	it('is deterministic regardless of object key insertion order', () => {
		expect(legacyRunId({ b: 2, a: 1 })).toBe(legacyRunId({ a: 1, b: 2 }));
	});

	it('ignores undefined properties when hashing', () => {
		expect(legacyRunId({ a: 1, b: undefined })).toBe(legacyRunId({ a: 1 }));
	});

	it('includes the original lastUpdated in the hashed payload', () => {
		const early = legacyRunId({ puzzleId: 'p1', lastUpdated: '2024-01-01T00:00:00.000Z' });
		const later = legacyRunId({ puzzleId: 'p1', lastUpdated: '2024-02-02T00:00:00.000Z' });
		expect(early).not.toBe(later);
	});

	it('hashes before migration normalizes fields (raw input is canonicalized as-is)', () => {
		// A raw legacy payload with extra/unknown fields is hashed verbatim (canonicalized),
		// so changing any field changes the id.
		const a = legacyRunId({ puzzleId: 'p1', placedPieces: [] });
		const b = legacyRunId({ puzzleId: 'p1', placedPieces: [], extra: true });
		expect(a).not.toBe(b);
	});
});

// --- Task 6: versioned codec, legacy migration, storage adapter ---------------

import {
	serializeSession,
	loadPersistedSession,
	isResumable,
	createSessionStorageAdapter,
	noopThrowingStorage,
	fnv1aUtf8,
	mulberry32,
	deterministicLegacyTrayOrder
} from './persistence';
import { memoryStorage, load } from './persistence.test-fixtures';
import type {
	PuzzleSessionState,
	PersistedPuzzleSessionV1,
	SessionValidationContext
} from './types';

function makeState(overrides: Partial<PuzzleSessionState> = {}): PuzzleSessionState {
	return {
		puzzleId: 'pz1',
		source: 'api',
		runId: '11111111-1111-4111-8111-111111111111',
		origin: 'new',
		lifecycle: 'active',
		mode: 'timed',
		timingQuality: 'known',
		elapsedActiveSeconds: 5,
		timerStarted: true,
		pieceCount: 4,
		gridCols: 2,
		gridRows: 2,
		placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
		trayOrder: [0, 1, 2, 3],
		rotationEnabled: false,
		pieceRotations: {},
		selectedPieceId: null,
		activeReferenceMode: null,
		organization: null,
		counters: { incorrectAttempts: 1, hintsUsed: 0, referenceActivations: 0 },
		facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
		hasUserActivity: true,
		resultClass: 'standard_timed',
		sealedCompletion: null,
		canUndo: true,
		canRedo: false,
		...overrides
	};
}

const ctx: SessionValidationContext = {
	puzzleId: 'pz1',
	source: 'api',
	pieceIds: [0, 1, 2, 3],
	gridCols: 2,
	gridRows: 2,
	pieceCount: 4
};

describe('serializeSession', () => {
	it('round-trips a schema v1 snapshot', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;

		const reloaded = loadPersistedSession(JSON.stringify(snapshot), ctx);

		expect(reloaded.status).toBe('loaded');
		if (reloaded.status === 'loaded') {
			expect(reloaded.snapshot).toEqual({ ...snapshot, lastUpdated: 1_000 });
		}
	});

	it('excludes transient runtime fields from the projection', () => {
		const snapshot = serializeSession(
			makeState({ selectedPieceId: 2, activeReferenceMode: 'hold', canUndo: true, canRedo: true }),
			1_000
		);

		expect(snapshot).not.toHaveProperty('selectedPieceId');
		expect(snapshot).not.toHaveProperty('activeReferenceMode');
		expect(snapshot).not.toHaveProperty('canUndo');
		expect(snapshot).not.toHaveProperty('canRedo');
		expect(snapshot).not.toHaveProperty('pieceCount');
	});

	it('returns null for a disposed session', () => {
		expect(serializeSession(makeState({ lifecycle: 'disposed' }), 1_000)).toBeNull();
	});

	it('omits organization when null', () => {
		const snapshot = serializeSession(makeState({ organization: null }), 1_000)!;
		expect(snapshot.organization).toBeUndefined();
	});
});

describe('loadPersistedSession validation', () => {
	it('returns missing for a null raw value', () => {
		expect(loadPersistedSession(null, ctx).status).toBe('missing');
	});

	it('returns invalid for malformed JSON', () => {
		expect(loadPersistedSession('{not json', ctx).status).toBe('invalid');
	});

	it('returns incompatible for a future schema version', () => {
		const future = JSON.stringify({ schemaVersion: 99, puzzleId: 'pz1' });
		const result = loadPersistedSession(future, ctx);
		expect(result.status).toBe('incompatible');
	});

	it('rejects a puzzle id mismatch', () => {
		const snapshot = serializeSession(makeState(), 1_000);
		const result = loadPersistedSession(JSON.stringify(snapshot), { ...ctx, puzzleId: 'other' });
		expect(result).toEqual({ status: 'invalid', reason: 'cross_field_violation' });
	});

	it('rejects a persisted disposed lifecycle', () => {
		const snapshot = serializeSession(makeState(), 1_000);
		const tampered = { ...snapshot, lifecycle: 'disposed' };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});
});

describe('legacy v0 migration', () => {
	it('migrates an unversioned progress record to legacy_unknown with null elapsed', () => {
		const legacy = {
			puzzleId: 'pz1',
			placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
			rotationEnabled: false,
			pieceRotations: {},
			lastUpdated: '2024-01-01T00:00:00.000Z'
		};

		const result = loadPersistedSession(JSON.stringify(legacy), ctx);

		expect(result.status).toBe('migrated');
		if (result.status === 'migrated') {
			const snap = result.snapshot;
			expect(snap.schemaVersion).toBe(1);
			expect(snap.mode).toBe('timed');
			expect(snap.origin).toBe('resumed');
			expect(snap.timingQuality).toBe('legacy_unknown');
			expect(snap.elapsedActiveSeconds).toBeNull();
			expect(snap.timerStarted).toBe(false);
			expect(snap.runId).toMatch(/^legacy-[0-9a-f]{64}$/);
			expect(snap.hasUserActivity).toBe(true);
			expect(snap.lifecycle).toBe('active');
			expect(snap.lastUpdated).toBe(Date.parse('2024-01-01T00:00:00.000Z'));
		}
	});

	it('produces a completed lifecycle when every unique piece is placed', () => {
		const legacy = {
			puzzleId: 'pz1',
			placedPieces: [
				{ pieceId: 0, x: 0, y: 0 },
				{ pieceId: 1, x: 1, y: 0 },
				{ pieceId: 2, x: 0, y: 1 },
				{ pieceId: 3, x: 1, y: 1 }
			],
			rotationEnabled: false,
			pieceRotations: {},
			lastUpdated: '2024-01-01T00:00:00.000Z'
		};

		const result = loadPersistedSession(JSON.stringify(legacy), ctx);

		expect(result.status).toBe('migrated');
		if (result.status === 'migrated') {
			expect(result.snapshot.lifecycle).toBe('completed');
		}
	});

	it('produces a deterministic tray order seeded by the puzzle id', () => {
		const legacy = { puzzleId: 'pz1', placedPieces: [], lastUpdated: '2024-01-01T00:00:00.000Z' };
		const expected = deterministicLegacyTrayOrder([0, 1, 2, 3], 'pz1');

		const result = loadPersistedSession(JSON.stringify(legacy), ctx);

		expect(result.status).toBe('migrated');
		if (result.status === 'migrated') {
			expect(result.snapshot.trayOrder).toEqual(expected);
			expect(new Set(result.snapshot.trayOrder)).toEqual(new Set([0, 1, 2, 3]));
		}
	});

	it('uses the same legacy run id on retry (deterministic)', () => {
		const legacy = { puzzleId: 'pz1', placedPieces: [], lastUpdated: '2024-01-01T00:00:00.000Z' };
		const a = loadPersistedSession(JSON.stringify(legacy), ctx);
		const b = loadPersistedSession(JSON.stringify(legacy), ctx);

		expect(a.status).toBe('migrated');
		expect(b.status).toBe('migrated');
		if (a.status === 'migrated' && b.status === 'migrated') {
			expect(a.snapshot.runId).toBe(b.snapshot.runId);
		}
	});

	it('marks hasUserActivity false for an empty legacy record', () => {
		const legacy = {
			puzzleId: 'pz1',
			placedPieces: [],
			rotationEnabled: false,
			pieceRotations: {},
			lastUpdated: ''
		};

		const result = loadPersistedSession(JSON.stringify(legacy), ctx);

		expect(result.status).toBe('migrated');
		if (result.status === 'migrated') {
			expect(result.snapshot.hasUserActivity).toBe(false);
		}
	});

	it('maps a rotation-enabled legacy record to rotation_timed', () => {
		const legacy = {
			puzzleId: 'pz1',
			placedPieces: [],
			rotationEnabled: true,
			pieceRotations: { 0: 90 },
			lastUpdated: ''
		};

		const result = loadPersistedSession(JSON.stringify(legacy), ctx);

		expect(result.status).toBe('migrated');
		if (result.status === 'migrated') {
			expect(result.snapshot.resultClass).toBe('rotation_timed');
			expect(result.snapshot.facts.rotationUsed).toBe(true);
		}
	});
});

describe('deterministic tray-order helpers', () => {
	it('fnv1aUtf8 is deterministic for the same input', () => {
		expect(fnv1aUtf8('pz1')).toBe(fnv1aUtf8('pz1'));
		expect(fnv1aUtf8('pz1')).not.toBe(fnv1aUtf8('pz2'));
	});

	it('mulberry32 produces a deterministic sequence for a seed', () => {
		const a = mulberry32(42);
		const b = mulberry32(42);
		const seqA = [a(), a(), a()];
		const seqB = [b(), b(), b()];
		expect(seqA).toEqual(seqB);
	});

	it('deterministicLegacyTrayOrder contains every piece exactly once', () => {
		const order = deterministicLegacyTrayOrder([0, 1, 2, 3, 4], 'pz1');
		expect(order.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);
	});
});

describe('isResumable', () => {
	it('is true for active + activity + no seal', () => {
		const snap = serializeSession(
			makeState({ lifecycle: 'active', hasUserActivity: true, sealedCompletion: null }),
			1
		)!;
		expect(isResumable(snap)).toBe(true);
	});

	it('is false for a sealed completion', () => {
		const seal: PersistedPuzzleSessionV1['sealedCompletion'] = {
			runId: 'r',
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 5,
			completedAt: 1,
			localStats: { status: 'succeeded' },
			serverSubmission: { status: 'succeeded' }
		};
		const snap = serializeSession(
			makeState({ lifecycle: 'completed', sealedCompletion: seal }),
			1
		)!;
		expect(isResumable(snap)).toBe(false);
	});

	it('is false without user activity', () => {
		const snap = serializeSession(makeState({ hasUserActivity: false }), 1)!;
		expect(isResumable(snap)).toBe(false);
	});
});

describe('createSessionStorageAdapter', () => {
	it('round-trips a snapshot through storage and reports loaded', () => {
		const store: Record<string, string> = {};
		const storage = memoryStorage(store);
		const adapter = createSessionStorageAdapter({ storage });

		const snapshot = serializeSession(makeState(), 1_000)!;
		adapter.saveSession('pz1', snapshot);

		const result = adapter.loadSession('pz1', ctx);
		expect(result.status).toBe('loaded');
		expect(store['puzzle-progress-pz1']).toBeDefined();
	});

	it('reports missing when no key exists', () => {
		const adapter = createSessionStorageAdapter({ storage: memoryStorage({}) });
		expect(adapter.loadSession('pz1', ctx).status).toBe('missing');
	});

	it('clear removes the key', () => {
		const store: Record<string, string> = {};
		const adapter = createSessionStorageAdapter({ storage: memoryStorage(store) });
		adapter.saveSession('pz1', serializeSession(makeState(), 1)!);
		adapter.clearSession('pz1');
		expect(store['puzzle-progress-pz1']).toBeUndefined();
	});

	it('reports write errors through onError without throwing', () => {
		const errors: string[] = [];
		const storage = memoryStorage({});
		storage.setItem = () => {
			throw new Error('quota');
		};
		const adapter = createSessionStorageAdapter({ storage, onError: (e) => errors.push(e.kind) });

		expect(() => adapter.saveSession('pz1', serializeSession(makeState(), 1)!)).not.toThrow();
		expect(errors).toContain('write_error');
	});

	it('reports read errors through onError and loads as missing', () => {
		const errors: string[] = [];
		const storage = memoryStorage({});
		storage.getItem = () => {
			throw new Error('read denied');
		};
		const adapter = createSessionStorageAdapter({ storage, onError: (e) => errors.push(e.kind) });

		expect(adapter.loadSession('pz1', ctx).status).toBe('missing');
		expect(errors).toContain('read_error');
	});

	it('reports remove errors through onError without throwing', () => {
		const errors: string[] = [];
		const storage = memoryStorage({});
		storage.removeItem = () => {
			throw new Error('remove denied');
		};
		const adapter = createSessionStorageAdapter({ storage, onError: (e) => errors.push(e.kind) });

		expect(() => adapter.clearSession('pz1')).not.toThrow();
		expect(errors).toContain('remove_error');
	});
});

describe('isResumable sealed-active guard', () => {
	it('is false for an active session carrying a sealed completion', () => {
		const seal: PersistedPuzzleSessionV1['sealedCompletion'] = {
			runId: 'r',
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 5,
			completedAt: 1,
			localStats: { status: 'succeeded' },
			serverSubmission: { status: 'succeeded' }
		};
		const snap = serializeSession(
			makeState({ lifecycle: 'active', hasUserActivity: true, sealedCompletion: seal }),
			1
		)!;

		expect(isResumable(snap)).toBe(false);
	});
});

// --- Patch coverage: validation branches, storage adapter error handling --------

describe('serializeSession with organization', () => {
	it('includes a cloned organization when present', () => {
		const org = {
			filter: 'edges' as const,
			activeTray: 'group-a',
			membership: { 0: 'group-a' },
			names: { 'group-a': 'Edges' }
		};
		const snapshot = serializeSession(makeState({ organization: org }), 1_000)!;
		expect(snapshot.organization).toEqual(org);
		// Mutating the source state after serialization must not affect the snapshot.
		org.names['group-a'] = 'Mutated';
		expect(snapshot.organization?.names['group-a']).toBe('Edges');
	});
});

describe('loadPersistedSession additional validation branches', () => {
	it('returns invalid:not_object for a JSON primitive', () => {
		expect(loadPersistedSession('42', ctx)).toEqual({ status: 'invalid', reason: 'not_object' });
	});

	it('returns invalid:bad_schema_version when schemaVersion is not an integer', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = { ...snapshot, schemaVersion: 1.5 };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'bad_schema_version'
		});
	});

	it('returns invalid:unsupported_schema_version for a past non-zero version', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = { ...snapshot, schemaVersion: 0 };
		// Version 0 is not > CURRENT (1), not === CURRENT (1), so falls through to
		// unsupported_schema_version rather than legacy v0 (which has no schemaVersion key).
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'unsupported_schema_version'
		});
	});

	it('returns invalid:legacy_migration_failed when a legacy record has bad placements', () => {
		const legacy = {
			puzzleId: 'pz1',
			placedPieces: [{ pieceId: 999, x: 0, y: 0 }],
			lastUpdated: '2024-01-01T00:00:00.000Z'
		};
		expect(loadPersistedSession(JSON.stringify(legacy), ctx)).toEqual({
			status: 'invalid',
			reason: 'legacy_migration_failed'
		});
	});

	it('rejects a relaxed mode record with non-null elapsed', () => {
		const snapshot = serializeSession(
			makeState({ mode: 'relaxed', elapsedActiveSeconds: null }),
			1_000
		)!;
		const tampered = { ...snapshot, elapsedActiveSeconds: 10 };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a record with a non-integer lastUpdated', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = { ...snapshot, lastUpdated: 1.5 };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a record with invalid facts (missing boolean field)', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = { ...snapshot, facts: { rotationUsed: true, hintUsed: false } };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a standard_timed record with hintUsed: true (should be assisted_timed)', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			facts: { rotationUsed: false, hintUsed: true, ghostReferenceUsed: false },
			resultClass: 'standard_timed'
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a standard_timed record with ghostReferenceUsed: true (should be assisted_timed)', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: true },
			resultClass: 'standard_timed'
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a standard_timed record with rotationUsed: true (should be rotation_timed)', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			facts: { rotationUsed: true, hintUsed: false, ghostReferenceUsed: false },
			resultClass: 'standard_timed'
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a rotation_timed record with hintUsed: true (should be assisted_timed)', () => {
		const snapshot = serializeSession(
			makeState({
				rotationEnabled: true,
				facts: { rotationUsed: true, hintUsed: false, ghostReferenceUsed: false },
				resultClass: 'rotation_timed'
			}),
			1_000
		)!;
		const tampered = {
			...snapshot,
			facts: { rotationUsed: true, hintUsed: true, ghostReferenceUsed: false },
			resultClass: 'rotation_timed'
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a non-relaxed record with relaxed mode (should be relaxed)', () => {
		const snapshot = serializeSession(
			makeState({ mode: 'relaxed', resultClass: 'relaxed', elapsedActiveSeconds: null }),
			1_000
		)!;
		const tampered = {
			...snapshot,
			resultClass: 'standard_timed'
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('accepts a record whose resultClass matches the monotonic facts', () => {
		const snapshot = serializeSession(
			makeState({
				facts: { rotationUsed: false, hintUsed: true, ghostReferenceUsed: false },
				resultClass: 'assisted_timed'
			}),
			1_000
		)!;
		const result = loadPersistedSession(JSON.stringify(snapshot), ctx);
		expect(result.status).toBe('loaded');
	});

	it('rejects a record with invalid counters (negative incorrectAttempts)', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			counters: { incorrectAttempts: -1, hintsUsed: 0, referenceActivations: 0 }
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a record with non-integer hintsUsed', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			counters: { incorrectAttempts: 0, hintsUsed: 1.5, referenceActivations: 0 }
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a record with negative referenceActivations', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: -2 }
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a seal with a pending localStats state', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 5,
				completedAt: 1_000,
				localStats: { status: 'bogus' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a seal with a failed state missing code', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 5,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'failed', retryable: true }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a seal with a non-finite completedAt', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 5,
				completedAt: Infinity,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a seal with a negative elapsedActiveSeconds', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: -1,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a known timed seal with elapsed 0 (server requires positive)', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 0,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a known timed seal with fractional elapsed (server requires integer)', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 1.5,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a known timed seal with null elapsed (server requires a number)', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: null,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a relaxed seal with a numeric elapsed (server requires null)', () => {
		const snapshot = serializeSession(
			makeState({ mode: 'relaxed', resultClass: 'relaxed', elapsedActiveSeconds: null }),
			1_000
		)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'relaxed',
				timingQuality: 'known',
				elapsedActiveSeconds: 5,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a legacy_unknown seal with a numeric elapsed (server requires null)', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'standard_timed',
				timingQuality: 'legacy_unknown',
				elapsedActiveSeconds: 5,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a seal with a negative completedAt', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 5,
				completedAt: -1,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a seal with a runId mismatch', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: 'different-run-id',
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 5,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a completed lifecycle without a seal', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = { ...snapshot, lifecycle: 'completed', sealedCompletion: null };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects an organization with an invalid filter', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			organization: { filter: 'bogus', activeTray: 'main', membership: {}, names: {} }
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects an organization with a non-string activeTray', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			organization: { filter: 'all', activeTray: 123, membership: {}, names: {} }
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects an organization with a non-object membership', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			organization: { filter: 'all', activeTray: 'main', membership: 'not-object', names: {} }
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects an organization with a non-object names', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			organization: { filter: 'all', activeTray: 'main', membership: {}, names: [] }
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('accepts a valid organization with explicit fields', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			organization: {
				filter: 'corners',
				activeTray: 'main',
				membership: { 0: 'g1' },
				names: { g1: 'Corners' }
			}
		};
		const result = loadPersistedSession(JSON.stringify(tampered), ctx);
		expect(result.status).toBe('loaded');
		if (result.status === 'loaded') {
			expect(result.snapshot.organization?.filter).toBe('corners');
			expect(result.snapshot.organization?.membership[0]).toBe('g1');
		}
	});

	it('rejects a record with a non-numeric elapsedActiveSeconds', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = { ...snapshot, elapsedActiveSeconds: 'not-a-number' };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a record with a negative elapsedActiveSeconds', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = { ...snapshot, elapsedActiveSeconds: -5 };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a record with a non-integer elapsedActiveSeconds', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = { ...snapshot, elapsedActiveSeconds: 1.5 };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('round-trips a completed snapshot with a valid sealed completion', () => {
		const seal: PersistedPuzzleSessionV1['sealedCompletion'] = {
			runId: '11111111-1111-4111-8111-111111111111',
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 42,
			completedAt: 1_000,
			localStats: { status: 'succeeded' },
			serverSubmission: { status: 'failed', code: 'network_error', retryable: true }
		};
		const snapshot = serializeSession(
			makeState({ lifecycle: 'completed', sealedCompletion: seal }),
			1_000
		)!;
		const result = loadPersistedSession(JSON.stringify(snapshot), ctx);
		expect(result.status).toBe('loaded');
		if (result.status === 'loaded') {
			expect(result.snapshot.sealedCompletion).not.toBeNull();
			expect(result.snapshot.sealedCompletion?.serverSubmission.status).toBe('failed');
		}
	});

	it('round-trips a completed local snapshot with a not_applicable server submission', () => {
		// not_applicable server submission is valid only for local puzzles;
		// for an API puzzle it would suppress the server submission.
		const localCtx: SessionValidationContext = { ...ctx, source: 'local' };
		const seal: PersistedPuzzleSessionV1['sealedCompletion'] = {
			runId: '11111111-1111-4111-8111-111111111111',
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 42,
			completedAt: 1_000,
			localStats: { status: 'succeeded' },
			serverSubmission: { status: 'not_applicable' }
		};
		const snapshot = serializeSession(
			makeState({ lifecycle: 'completed', sealedCompletion: seal, source: 'local' }),
			1_000
		)!;
		const result = loadPersistedSession(JSON.stringify(snapshot), localCtx);
		expect(result.status).toBe('loaded');
		if (result.status === 'loaded') {
			expect(result.snapshot.sealedCompletion?.serverSubmission.status).toBe('not_applicable');
		}
	});

	it('rejects a not_applicable server submission for an API puzzle', () => {
		const seal: PersistedPuzzleSessionV1['sealedCompletion'] = {
			runId: '11111111-1111-4111-8111-111111111111',
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 42,
			completedAt: 1_000,
			localStats: { status: 'succeeded' },
			serverSubmission: { status: 'not_applicable' }
		};
		const snapshot = serializeSession(
			makeState({ lifecycle: 'completed', sealedCompletion: seal }),
			1_000
		)!;
		const result = loadPersistedSession(JSON.stringify(snapshot), ctx);
		expect(result.status).toBe('invalid');
	});
});

// --- Patch coverage: test-fixture helpers, noop storage, crypto edges -----------

describe('memoryStorage fixture', () => {
	it('reports length and key index for stored entries', () => {
		const store: Record<string, string> = { a: '1', b: '2' };
		const storage = memoryStorage(store);

		expect(storage.length).toBe(2);
		expect(storage.key(0)).toBe('a');
		expect(storage.key(1)).toBe('b');
		expect(storage.key(2)).toBeNull();
	});

	it('clear removes all entries', () => {
		const store: Record<string, string> = { a: '1', b: '2' };
		const storage = memoryStorage(store);

		storage.clear();

		expect(storage.length).toBe(0);
		expect(storage.getItem('a')).toBeNull();
	});
});

describe('load fixture helper', () => {
	it('returns missing when JSON.stringify yields undefined (e.g. undefined input)', () => {
		// JSON.stringify(undefined) === undefined, so `?? null` passes null to
		// loadPersistedSession which reports 'missing'.
		expect(load(undefined as unknown).status).toBe('missing');
	});
});

describe('noopThrowingStorage', () => {
	it('reports zero length and null key without throwing', () => {
		expect(noopThrowingStorage.length).toBe(0);
		expect(noopThrowingStorage.key(0)).toBeNull();
	});

	it('returns null for getItem and throws for setItem', () => {
		expect(noopThrowingStorage.getItem('anything')).toBeNull();
		expect(() => noopThrowingStorage.setItem('k', 'v')).toThrow('storage_unavailable');
	});

	it('removeItem and clear are silent no-ops', () => {
		expect(() => {
			noopThrowingStorage.removeItem('k');
			noopThrowingStorage.clear();
		}).not.toThrow();
	});
});

describe('createBrowserRunIdFactory crypto-unavailable edge', () => {
	it('falls to the undefined branch when global crypto is absent', () => {
		vi.stubGlobal('crypto', undefined);
		try {
			const factory = createBrowserRunIdFactory();
			// With no crypto anywhere, fallbackUuidV4 dereferences undefined and throws.
			expect(() => factory.create()).toThrow();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('uses the fallback path when crypto lacks randomUUID', () => {
		// A crypto with getRandomValues but no randomUUID exercises the
		// fallbackUuidV4(source) path where source is the provided crypto.
		const stub = {
			getRandomValues: <T extends ArrayBufferView | null>(arr: T): T => {
				const out = new Uint8Array((arr as unknown as ArrayBufferView).buffer);
				out.fill(0);
				return arr;
			}
		} as unknown as Crypto;
		const factory = createBrowserRunIdFactory(stub);
		expect(isPuzzleRunId(factory.create())).toBe(true);
	});
});

describe('createSessionStorageAdapter error paths without onError', () => {
	it('swallows read errors silently when no onError is provided', () => {
		const storage = memoryStorage({});
		storage.getItem = () => {
			throw new Error('read denied');
		};
		const adapter = createSessionStorageAdapter({ storage });

		expect(adapter.loadSession('pz1', ctx).status).toBe('missing');
	});

	it('swallows write errors silently when no onError is provided', () => {
		const storage = memoryStorage({});
		storage.setItem = () => {
			throw new Error('quota');
		};
		const adapter = createSessionStorageAdapter({ storage });

		expect(() => adapter.saveSession('pz1', serializeSession(makeState(), 1)!)).not.toThrow();
	});

	it('swallows remove errors silently when no onError is provided', () => {
		const storage = memoryStorage({});
		storage.removeItem = () => {
			throw new Error('remove denied');
		};
		const adapter = createSessionStorageAdapter({ storage });

		expect(() => adapter.clearSession('pz1')).not.toThrow();
	});
});
