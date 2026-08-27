// Tests for the web-local browser persistence wrapper: browser crypto
// resolution, the `puzzle-progress-` key namespace, Storage fallback, and
// resumable candidate enumeration. Codec validation and generic adapter
// semantics are owned and tested by @perseus/game-core.
import { describe, it, expect, vi } from 'vitest';
import { createBrowserRunIdFactory } from './persistence';
import { isPuzzleRunId } from '@perseus/types';
import { serializeSession, type PuzzleSessionState } from '@perseus/game-core';

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

	describe('crypto-unavailable edge', () => {
		it('falls to the undefined branch when global crypto is absent', () => {
			vi.stubGlobal('crypto', undefined);
			try {
				const factory = createBrowserRunIdFactory();
				// With no crypto anywhere, the fallback dereferences undefined and throws.
				expect(() => factory.create()).toThrow();
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it('uses the fallback path when crypto lacks randomUUID', () => {
			// A crypto with getRandomValues but no randomUUID exercises the
			// byte-formatting fallback path with the provided crypto source.
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
});

// --- Browser storage namespace wrapper ----------------------------------------

import {
	createSessionStorageAdapter,
	listResumableSessionCandidateIds,
	noopThrowingStorage
} from './persistence';
import {
	context,
	memoryStorage,
	validSnapshot,
	fullBoardPlacements,
	seal
} from './persistence.test-fixtures';

function makeState(overrides: Partial<PuzzleSessionState> = {}): PuzzleSessionState {
	return {
		puzzleId: 'pz1',
		source: 'api',
		runId: '11111111-1111-4111-8111-111111111111',
		origin: 'new',
		lifecycle: 'active',
		mode: 'timed',
		elapsedActiveSeconds: 5,
		timerStarted: true,
		pieceCount: 4,
		gridCols: 2,
		gridRows: 2,
		// Partial board: an in-progress active session. A full board without a
		// sealed completion is a dead state and must be rejected by the loader.
		placedPieces: [
			{ pieceId: 0, x: 0, y: 0 },
			{ pieceId: 1, x: 1, y: 0 }
		],
		trayOrder: [0, 1, 2, 3],
		rotationEnabled: false,
		pieceRotations: {},
		selectedPieceId: null,
		activeReferenceMode: null,
		organization: null,
		viewport: null,
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

describe('createSessionStorageAdapter', () => {
	it('clears unversioned stored state and reports missing', () => {
		const store: Record<string, string> = {};
		const storage = memoryStorage(store);
		storage.setItem(
			'puzzle-progress-pz1',
			JSON.stringify({ puzzleId: 'pz1', placedPieces: [], lastUpdated: 10 })
		);
		const adapter = createSessionStorageAdapter({ storage });

		expect(adapter.loadSession('pz1', context)).toEqual({ status: 'missing' });
		expect(storage.getItem('puzzle-progress-pz1')).toBe(
			'{"puzzleId":"pz1","placedPieces":[],"lastUpdated":10}'
		);
	});

	it('ignores legacy server keys without v2 prefix during enumeration', () => {
		const active = { ...validSnapshot(), puzzleId: 'legacy' };
		const storage = memoryStorage({
			'puzzle-progress-legacy': JSON.stringify(active)
		});

		expect(listResumableSessionCandidateIds(storage)).toEqual([]);
	});

	it('enumerates v2 server variant keys and quick puzzle keys', () => {
		const serverActive = { ...validSnapshot(), puzzleId: 'variant-1' };
		const quickActive = { ...validSnapshot(), puzzleId: 'q-quick', source: 'local' as const };
		const storage = memoryStorage({
			'puzzle-progress-v2-variant-1': JSON.stringify(serverActive),
			'puzzle-progress-q-quick': JSON.stringify(quickActive),
			'puzzle-progress-legacy': JSON.stringify({ ...validSnapshot(), puzzleId: 'legacy' })
		});

		expect(listResumableSessionCandidateIds(storage)).toEqual(['variant-1', 'q-quick']);
	});

	it('clears a different schema version and reports missing', () => {
		const store: Record<string, string> = {};
		const storage = memoryStorage(store);
		storage.setItem(
			'puzzle-progress-v2-pz1',
			JSON.stringify({ schemaVersion: 2, puzzleId: 'pz1' })
		);
		const adapter = createSessionStorageAdapter({ storage });

		expect(adapter.loadSession('pz1', context)).toEqual({ status: 'missing' });
		expect(storage.getItem('puzzle-progress-v2-pz1')).toBeNull();
	});

	it('round-trips a snapshot through storage and reports loaded', () => {
		const store: Record<string, string> = {};
		const storage = memoryStorage(store);
		const adapter = createSessionStorageAdapter({ storage });

		const snapshot = serializeSession(makeState(), 1_000)!;
		adapter.saveSession('pz1', snapshot);

		const result = adapter.loadSession('pz1', context);
		expect(result.status).toBe('loaded');
		expect(store['puzzle-progress-v2-pz1']).toBeDefined();
	});

	it('reports missing when no key exists', () => {
		const adapter = createSessionStorageAdapter({ storage: memoryStorage({}) });
		expect(adapter.loadSession('pz1', context).status).toBe('missing');
	});

	it('clear removes the key', () => {
		const store: Record<string, string> = {};
		const adapter = createSessionStorageAdapter({ storage: memoryStorage(store) });
		adapter.saveSession('pz1', serializeSession(makeState(), 1)!);
		adapter.clearSession('pz1');
		expect(store['puzzle-progress-v2-pz1']).toBeUndefined();
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

		expect(adapter.loadSession('pz1', context).status).toBe('missing');
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

	it('swallows read errors silently when no onError is provided', () => {
		const storage = memoryStorage({});
		storage.getItem = () => {
			throw new Error('read denied');
		};
		const adapter = createSessionStorageAdapter({ storage });

		expect(adapter.loadSession('pz1', context).status).toBe('missing');
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

describe('listResumableSessionCandidateIds', () => {
	it('returns only current-schema active/paused sessions with activity and no seal', () => {
		const active = validSnapshot();
		const paused = { ...validSnapshot(), puzzleId: 'paused', lifecycle: 'paused' as const };
		const completed = {
			...validSnapshot(),
			puzzleId: 'complete',
			lifecycle: 'completed' as const,
			placedPieces: fullBoardPlacements(),
			sealedCompletion: seal()
		};
		const noActivity = {
			...validSnapshot(),
			puzzleId: 'idle',
			placedPieces: [],
			timerStarted: false,
			hasUserActivity: false
		};
		const sealed = { ...validSnapshot(), puzzleId: 'sealed', sealedCompletion: seal() };
		const storage = memoryStorage({
			'puzzle-progress-v2-pz1': JSON.stringify(active),
			'puzzle-progress-v2-paused': JSON.stringify(paused),
			'puzzle-progress-v2-complete': JSON.stringify(completed),
			'puzzle-progress-v2-idle': JSON.stringify(noActivity),
			'puzzle-progress-v2-sealed': JSON.stringify(sealed)
		});

		expect(listResumableSessionCandidateIds(storage)).toEqual(['pz1', 'paused']);
	});

	it('ignores malformed, old-schema, mismatched, empty, and unrelated keys', () => {
		const storage = memoryStorage({
			'puzzle-progress-v2-bad-json': '{',
			'puzzle-progress-v2-old': JSON.stringify({
				...validSnapshot(),
				puzzleId: 'old',
				schemaVersion: 999
			}),
			'puzzle-progress-v2-key-id': JSON.stringify({ ...validSnapshot(), puzzleId: 'other-id' }),
			'puzzle-progress-v2-': JSON.stringify(validSnapshot()),
			'unrelated-setting': '1'
		});

		expect(listResumableSessionCandidateIds(storage)).toEqual([]);
	});

	it('returns an empty list when storage enumeration/read is unavailable', () => {
		const blocked = {
			get length(): number {
				throw new Error('blocked');
			},
			key: () => null,
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {}
		} satisfies Storage;

		expect(listResumableSessionCandidateIds(blocked)).toEqual([]);
	});

	it('skips null keys, vanished values, and array-valued entries', () => {
		// Exercises the remaining defensive branches in the enumeration loop:
		//   - resolved.key(i) returns null past the last index (optional
		//     chaining `key?.startsWith` short-circuits),
		//   - a progress key whose getItem value is null (e.g. evicted between
		//     enumeration and read),
		//   - a progress key whose parsed value is a JSON array (rejected by the
		//     Array.isArray guard),
		// alongside a valid resumable entry that must still surface.
		const store = new Map<string, string>([
			[
				'puzzle-progress-v2-resumable',
				JSON.stringify({ ...validSnapshot(), puzzleId: 'resumable' })
			],
			['puzzle-progress-v2-vanished', 'will-be-null']
		]);
		const storage: Storage = {
			get length() {
				return store.size + 1; // report one extra slot to force a null key() read
			},
			key: (i: number) => Array.from(store.keys())[i] ?? null,
			getItem: (k: string) => (k === 'puzzle-progress-v2-vanished' ? null : (store.get(k) ?? null)),
			setItem: (k: string, v: string) => {
				store.set(k, v);
			},
			removeItem: (k: string) => {
				store.delete(k);
			},
			clear: () => store.clear()
		};

		// Overwrite the vanished slot's parsed shape with a JSON array to
		// exercise the Array.isArray guard on a non-null value.
		store.set('puzzle-progress-v2-array', JSON.stringify([1, 2, 3]));

		expect(listResumableSessionCandidateIds(storage)).toEqual(['resumable']);
	});
});

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
