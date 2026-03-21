/**
 * Unit tests for workflows helpers.ts
 * Covers padPixelsToTarget, applyMaskAlpha, getMetadata, and updateMetadata
 */
import { describe, it, expect, vi } from 'vitest';
import {
	padPixelsToTarget,
	applyMaskAlpha,
	getMetadata,
	updateMetadata,
	MAX_IMAGE_BYTES
} from './helpers';
import type { PuzzleMetadata } from './types';

// ── padPixelsToTarget ────────────────────────────────────────────────────────

describe('padPixelsToTarget', () => {
	it('places source pixels at the given offset within a larger target', () => {
		// 2x1 source RGBA (red, green)
		const source = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
		// place at (1, 1) inside a 4x3 target
		const result = padPixelsToTarget(source, 2, 1, 4, 3, 1, 1);

		expect(result).toHaveLength(4 * 3 * 4);
		// pixel at (col=1, row=1) => index = (1 * 4 + 1) * 4 = 20
		const start = (1 * 4 + 1) * 4;
		expect(Array.from(result.slice(start, start + 8))).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
	});

	it('fills surrounding area with zeros (transparent black)', () => {
		const source = new Uint8Array([1, 2, 3, 4]);
		const result = padPixelsToTarget(source, 1, 1, 2, 2, 0, 0);
		// pixel (0,0) is source
		expect(result[0]).toBe(1);
		// pixel (1,0) should be zero (padding)
		expect(result[4]).toBe(0);
	});

	it('throws RangeError when offsetX is negative', () => {
		const source = new Uint8Array(4);
		expect(() => padPixelsToTarget(source, 1, 1, 2, 2, -1, 0)).toThrow(RangeError);
		expect(() => padPixelsToTarget(source, 1, 1, 2, 2, -1, 0)).toThrow(
			/offsets must be non-negative/
		);
	});

	it('throws RangeError when offsetY is negative', () => {
		const source = new Uint8Array(4);
		expect(() => padPixelsToTarget(source, 1, 1, 2, 2, 0, -5)).toThrow(RangeError);
		expect(() => padPixelsToTarget(source, 1, 1, 2, 2, 0, -5)).toThrow(
			/offsets must be non-negative/
		);
	});

	it('throws RangeError when source width + offsetX exceeds target width', () => {
		const source = new Uint8Array(4);
		// sourceWidth=2, offsetX=1, targetWidth=2 → 1+2=3 > 2
		expect(() => padPixelsToTarget(source, 2, 1, 2, 4, 1, 0)).toThrow(RangeError);
		expect(() => padPixelsToTarget(source, 2, 1, 2, 4, 1, 0)).toThrow(/exceeds target width/);
	});

	it('throws RangeError when source height + offsetY exceeds target height', () => {
		const source = new Uint8Array(8);
		// sourceWidth=2, sourceHeight=1, offsetY=2, targetHeight=2 → 2+1=3 > 2
		expect(() => padPixelsToTarget(source, 2, 1, 4, 2, 0, 2)).toThrow(RangeError);
		expect(() => padPixelsToTarget(source, 2, 1, 4, 2, 0, 2)).toThrow(/exceeds target height/);
	});

	it('throws TypeError when sourcePixels length does not match dimensions', () => {
		// 2x2 source needs 2*2*4=16 bytes but only 4 provided
		const source = new Uint8Array(4);
		expect(() => padPixelsToTarget(source, 2, 2, 4, 4, 0, 0)).toThrow(TypeError);
		expect(() => padPixelsToTarget(source, 2, 2, 4, 4, 0, 0)).toThrow(/does not match expected/);
	});
});

// ── applyMaskAlpha ───────────────────────────────────────────────────────────

describe('applyMaskAlpha', () => {
	it('copies alpha channel from mask into piece pixels', () => {
		const piece = new Uint8Array([10, 20, 30, 0, 40, 50, 60, 0]);
		const mask = new Uint8Array([0, 0, 0, 200, 0, 0, 0, 128]);
		applyMaskAlpha(piece, mask);
		expect(piece[3]).toBe(200);
		expect(piece[7]).toBe(128);
		// RGB channels unchanged
		expect(piece[0]).toBe(10);
		expect(piece[4]).toBe(40);
	});

	it('leaves RGB channels untouched', () => {
		const piece = new Uint8Array([255, 128, 64, 0]);
		const mask = new Uint8Array([0, 0, 0, 77]);
		applyMaskAlpha(piece, mask);
		expect(piece[0]).toBe(255);
		expect(piece[1]).toBe(128);
		expect(piece[2]).toBe(64);
		expect(piece[3]).toBe(77);
	});

	it('throws RangeError when mask is shorter than piece pixels', () => {
		const piece = new Uint8Array(8); // 2 pixels
		const mask = new Uint8Array(4); // only 1 pixel — too short
		expect(() => applyMaskAlpha(piece, mask)).toThrow(RangeError);
		expect(() => applyMaskAlpha(piece, mask)).toThrow(/maskPixels length.*is less than/);
	});

	it('handles equal-length arrays without error', () => {
		const piece = new Uint8Array([0, 0, 0, 0]);
		const mask = new Uint8Array([0, 0, 0, 255]);
		expect(() => applyMaskAlpha(piece, mask)).not.toThrow();
		expect(piece[3]).toBe(255);
	});

	it('handles mask longer than piece without error', () => {
		const piece = new Uint8Array([10, 20, 30, 0]);
		const mask = new Uint8Array([0, 0, 0, 42, 0, 0, 0, 99]); // mask is 2 pixels, piece is 1
		expect(() => applyMaskAlpha(piece, mask)).not.toThrow();
		expect(piece[3]).toBe(42); // only first pixel alpha is set
	});
});

// ── getMetadata ──────────────────────────────────────────────────────────────

function createMockKV(returnValue: unknown) {
	return {
		get: vi.fn(async () => returnValue)
	} as unknown as KVNamespace;
}

describe('getMetadata', () => {
	it('returns null when KV returns null', async () => {
		const kv = createMockKV(null);
		const result = await getMetadata(kv, 'puzzle-123');
		expect(result).toBeNull();
	});

	it('returns valid metadata when KV returns correct data', async () => {
		const validMeta: PuzzleMetadata = {
			id: '550e8400-e29b-41d4-a716-446655440000',
			name: 'Test',
			pieceCount: 1,
			gridCols: 1,
			gridRows: 1,
			imageWidth: 100,
			imageHeight: 100,
			createdAt: Date.now(),
			version: 1,
			status: 'ready',
			pieces: [
				{
					id: 0,
					puzzleId: '550e8400-e29b-41d4-a716-446655440000',
					correctX: 0,
					correctY: 0,
					edges: { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' },
					imagePath: 'pieces/0.png'
				}
			]
		};
		const kv = createMockKV(validMeta);
		const result = await getMetadata(kv, '550e8400-e29b-41d4-a716-446655440000');
		expect(result).toEqual(validMeta);
	});

	it('throws an error when KV returns data that fails validation', async () => {
		// Non-object value that will fail validatePuzzleMetadata and
		// trigger getValidationDiagnostics with 'not an object'
		const kv = createMockKV('invalid-string');
		await expect(getMetadata(kv, 'bad-puzzle')).rejects.toThrow(/Corrupt puzzle metadata/);
	});

	it('includes "not an object" diagnostic for non-object corrupt data', async () => {
		const kv = createMockKV(42);
		await expect(getMetadata(kv, 'num-puzzle')).rejects.toThrow(/not an object/);
	});

	it('includes field-level diagnostics for object with missing fields', async () => {
		// Object that passes the null-check but fails validation (missing most fields)
		const kv = createMockKV({ id: 123, status: 'ready' });
		await expect(getMetadata(kv, 'bad-meta')).rejects.toThrow(
			/missing or invalid id|missing or invalid name/
		);
	});

	it('includes grid math mismatch diagnostic', async () => {
		// Almost valid metadata but gridCols * gridRows != pieceCount
		const kv = createMockKV({
			id: 'some-id',
			name: 'Test',
			pieceCount: 4,
			gridCols: 3,
			gridRows: 3,
			imageWidth: 100,
			imageHeight: 100,
			createdAt: Date.now(),
			version: 1,
			status: 'ready',
			pieces: []
		});
		await expect(getMetadata(kv, 'grid-mismatch')).rejects.toThrow(/grid math mismatch/);
	});

	it('handles objects missing all diagnostic fields', async () => {
		// Empty object: all field checks in getValidationDiagnostics will fire
		const kv = createMockKV({});
		await expect(getMetadata(kv, 'empty-meta')).rejects.toThrow(/Corrupt puzzle metadata/);
	});
});

// ── updateMetadata ───────────────────────────────────────────────────────────

function createMockDO(responseFactory: () => Response) {
	const stub = {
		fetch: vi.fn(async () => responseFactory())
	};
	return {
		idFromName: vi.fn(() => 'mock-id'),
		get: vi.fn(() => stub),
		_stub: stub
	} as unknown as DurableObjectNamespace & { _stub: typeof stub };
}

describe('updateMetadata', () => {
	it('resolves successfully on HTTP 200 response', async () => {
		const ns = createMockDO(() => new Response('{}', { status: 200 }));
		await expect(updateMetadata(ns, 'puzzle-1', { status: 'ready' })).resolves.toBeUndefined();
	});

	it('throws using the message from the error response body', async () => {
		const ns = createMockDO(
			() =>
				new Response(JSON.stringify({ message: 'Not found' }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' }
				})
		);
		await expect(updateMetadata(ns, 'puzzle-x', {})).rejects.toThrow('Not found');
	});

	it('falls back to generic error message when response body is not parseable JSON', async () => {
		const ns = createMockDO(
			() =>
				new Response('internal server error', {
					status: 500,
					headers: { 'Content-Type': 'text/plain' }
				})
		);
		await expect(updateMetadata(ns, 'puzzle-y', {})).rejects.toThrow(
			/Failed to update puzzle puzzle-y \(HTTP 500\)/
		);
	});

	it('falls back to generic error when response body has no message field', async () => {
		const ns = createMockDO(
			() =>
				new Response(JSON.stringify({ code: 42 }), {
					status: 503,
					headers: { 'Content-Type': 'application/json' }
				})
		);
		await expect(updateMetadata(ns, 'puzzle-z', {})).rejects.toThrow(
			/Failed to update puzzle puzzle-z \(HTTP 503\)/
		);
	});
});

// ── MAX_IMAGE_BYTES constant ─────────────────────────────────────────────────

describe('MAX_IMAGE_BYTES', () => {
	it('is 50MB', () => {
		expect(MAX_IMAGE_BYTES).toBe(50 * 1024 * 1024);
	});
});
