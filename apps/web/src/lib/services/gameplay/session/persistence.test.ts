// Red tests for PuzzleSession persistence: canonical run IDs and canonical JSON.
import { describe, it, expect } from 'vitest';
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
