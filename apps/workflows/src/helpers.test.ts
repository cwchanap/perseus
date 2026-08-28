import { describe, it, expect, vi } from 'vitest';
import { MAX_IMAGE_BYTES, padPixelsToTarget, applyMaskAlpha, getMetadata } from './helpers';

// ─── MAX_IMAGE_BYTES ──────────────────────────────────────────────────────────

describe('MAX_IMAGE_BYTES', () => {
	it('should equal 50MB', () => {
		expect(MAX_IMAGE_BYTES).toBe(50 * 1024 * 1024);
	});
});

// ─── padPixelsToTarget ────────────────────────────────────────────────────────

describe('padPixelsToTarget', () => {
	function makeRgba(width: number, height: number, fill = 0xff): Uint8Array {
		const buf = new Uint8Array(width * height * 4);
		for (let i = 0; i < buf.length; i += 4) {
			buf[i] = fill; // R
			buf[i + 1] = fill; // G
			buf[i + 2] = fill; // B
			buf[i + 3] = fill; // A
		}
		return buf;
	}

	it('places source at offset (0, 0)', () => {
		const src = makeRgba(2, 2, 0xaa);
		const result = padPixelsToTarget(src, 2, 2, 4, 4, 0, 0);
		expect(result.length).toBe(4 * 4 * 4);
		// First pixel of result should match source
		expect(result[0]).toBe(0xaa);
		expect(result[1]).toBe(0xaa);
	});

	it('places source at non-zero offset', () => {
		const src = makeRgba(1, 1, 0xcc);
		// 1x1 source placed at (2, 2) in a 4x4 target
		const result = padPixelsToTarget(src, 1, 1, 4, 4, 2, 2);
		// Pixel at row 2, col 2 → index (2*4 + 2) * 4 = 40
		expect(result[40]).toBe(0xcc);
		// First pixel should be 0 (padding)
		expect(result[0]).toBe(0);
	});

	it('fills surrounding area with zeros', () => {
		const src = makeRgba(2, 2, 0xff);
		const result = padPixelsToTarget(src, 2, 2, 4, 4, 1, 1);
		// Pixel at (0,0) should be 0
		expect(result[0]).toBe(0);
		expect(result[1]).toBe(0);
		expect(result[2]).toBe(0);
		expect(result[3]).toBe(0);
	});

	it('handles full-size source (no padding)', () => {
		const src = makeRgba(3, 3, 0x55);
		const result = padPixelsToTarget(src, 3, 3, 3, 3, 0, 0);
		expect(result).toEqual(src);
	});

	it('throws RangeError when offsetX is negative', () => {
		const src = makeRgba(2, 2);
		expect(() => padPixelsToTarget(src, 2, 2, 4, 4, -1, 0)).toThrow(RangeError);
		expect(() => padPixelsToTarget(src, 2, 2, 4, 4, -1, 0)).toThrow(/non-negative/);
	});

	it('throws RangeError when offsetY is negative', () => {
		const src = makeRgba(2, 2);
		expect(() => padPixelsToTarget(src, 2, 2, 4, 4, 0, -1)).toThrow(RangeError);
	});

	it('throws RangeError when source width exceeds target at offsetX', () => {
		const src = makeRgba(3, 2);
		// offsetX=2, sourceWidth=3, targetWidth=4 → 2+3=5 > 4
		expect(() => padPixelsToTarget(src, 3, 2, 4, 4, 2, 0)).toThrow(RangeError);
		expect(() => padPixelsToTarget(src, 3, 2, 4, 4, 2, 0)).toThrow(/source width/);
	});

	it('throws RangeError when source height exceeds target at offsetY', () => {
		const src = makeRgba(2, 3);
		// offsetY=2, sourceHeight=3, targetHeight=4 → 2+3=5 > 4
		expect(() => padPixelsToTarget(src, 2, 3, 4, 4, 0, 2)).toThrow(RangeError);
		expect(() => padPixelsToTarget(src, 2, 3, 4, 4, 0, 2)).toThrow(/source height/);
	});

	it('throws TypeError when sourcePixels length does not match dimensions', () => {
		// Create buffer with wrong length
		const wrongSize = new Uint8Array(10);
		expect(() => padPixelsToTarget(wrongSize, 2, 2, 4, 4, 0, 0)).toThrow(TypeError);
		expect(() => padPixelsToTarget(wrongSize, 2, 2, 4, 4, 0, 0)).toThrow(/sourcePixels length/);
	});

	it('copies all rows correctly for a multi-row source', () => {
		// 2x3 source (2 wide, 3 tall) in a 4x4 target at (1, 0)
		const src = new Uint8Array(2 * 3 * 4);
		for (let row = 0; row < 3; row++) {
			for (let col = 0; col < 2; col++) {
				const i = (row * 2 + col) * 4;
				src[i] = row * 10; // unique R per row
				src[i + 1] = col * 20; // unique G per col
				src[i + 2] = 0;
				src[i + 3] = 0xff;
			}
		}
		const result = padPixelsToTarget(src, 2, 3, 4, 4, 1, 0);
		// Check row=1, col=1 (source row 1, col 0 → target row 1, col 1)
		// target index: (1 * 4 + 1) * 4 = 20
		expect(result[20]).toBe(10); // row 1 R
		expect(result[21]).toBe(0); // col 0 G
		expect(result[23]).toBe(0xff); // A
	});
});

// ─── applyMaskAlpha ───────────────────────────────────────────────────────────

describe('applyMaskAlpha', () => {
	it('copies alpha channel from mask to piece pixels', () => {
		const piece = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
		const mask = new Uint8Array([0, 0, 0, 128, 0, 0, 0, 64]);
		applyMaskAlpha(piece, mask);
		expect(piece[3]).toBe(128);
		expect(piece[7]).toBe(64);
	});

	it('sets alpha to 0 when mask alpha is 0 (fully transparent)', () => {
		const piece = new Uint8Array([100, 150, 200, 255]);
		const mask = new Uint8Array([0, 0, 0, 0]);
		applyMaskAlpha(piece, mask);
		expect(piece[3]).toBe(0);
	});

	it('does not modify RGB channels', () => {
		const piece = new Uint8Array([10, 20, 30, 255]);
		const mask = new Uint8Array([0, 0, 0, 127]);
		applyMaskAlpha(piece, mask);
		expect(piece[0]).toBe(10);
		expect(piece[1]).toBe(20);
		expect(piece[2]).toBe(30);
	});

	it('works with empty arrays', () => {
		const piece = new Uint8Array(0);
		const mask = new Uint8Array(0);
		expect(() => applyMaskAlpha(piece, mask)).not.toThrow();
	});

	it('throws RangeError when mask is shorter than piece', () => {
		const piece = new Uint8Array(8);
		const mask = new Uint8Array(4);
		expect(() => applyMaskAlpha(piece, mask)).toThrow(RangeError);
		expect(() => applyMaskAlpha(piece, mask)).toThrow(/maskPixels length/);
	});

	it('handles mask longer than piece without error (uses safeLength)', () => {
		const piece = new Uint8Array([0, 0, 0, 200]);
		const mask = new Uint8Array([0, 0, 0, 128, 0, 0, 0, 255]); // longer than piece
		expect(() => applyMaskAlpha(piece, mask)).not.toThrow();
		expect(piece[3]).toBe(128);
	});

	it('processes multiple pixels', () => {
		const n = 10;
		const piece = new Uint8Array(n * 4).fill(255);
		const mask = new Uint8Array(n * 4);
		for (let i = 0; i < n; i++) {
			mask[i * 4 + 3] = i * 25; // varying alpha
		}
		applyMaskAlpha(piece, mask);
		for (let i = 0; i < n; i++) {
			expect(piece[i * 4 + 3]).toBe(i * 25);
		}
	});
});

// ─── getMetadata ─────────────────────────────────────────────────────────────

describe('getMetadata', () => {
	function makeKV(value: unknown) {
		return {
			get: vi.fn(async () => value)
		} as unknown as KVNamespace;
	}

	const validMetadata = {
		id: 'puzzle-1',
		name: 'Test Puzzle',
		pieceCount: 9,
		gridCols: 3,
		gridRows: 3,
		imageWidth: 300,
		imageHeight: 300,
		createdAt: Date.now(),
		version: 1,
		pieces: [],
		status: 'processing',
		progress: {
			totalPieces: 9,
			generatedPieces: 0,
			updatedAt: Date.now()
		}
	};

	it('returns null when KV returns null', async () => {
		const kv = makeKV(null);
		const result = await getMetadata(kv, 'missing-puzzle');
		expect(result).toBeNull();
	});

	it('returns metadata when KV returns valid data', async () => {
		const kv = makeKV(validMetadata);
		const result = await getMetadata(kv, 'puzzle-1');
		expect(result).not.toBeNull();
		expect(result?.id).toBe('puzzle-1');
		expect(result?.name).toBe('Test Puzzle');
	});

	it('uses correct KV key format (puzzle:{id})', async () => {
		const kv = makeKV(validMetadata);
		await getMetadata(kv, 'my-puzzle-123');
		expect(kv.get).toHaveBeenCalledWith('puzzle:my-puzzle-123', 'json');
	});

	it('throws when KV returns corrupt data (fails validation)', async () => {
		const corruptData = { id: 123, name: null }; // invalid types
		const kv = makeKV(corruptData);
		await expect(getMetadata(kv, 'bad-puzzle')).rejects.toThrow(/Corrupt puzzle metadata/);
	});

	it('throws with diagnostic info listing all missing fields', async () => {
		// Only provide id and name, missing rest
		const partialData = { id: 'x', name: 'y' };
		const kv = makeKV(partialData);
		await expect(getMetadata(kv, 'x')).rejects.toThrow(/missing or invalid/);
	});

	it('includes grid math mismatch in diagnostics when gridCols*gridRows != pieceCount', async () => {
		// pieceCount says 10 but gridCols(3)*gridRows(3)=9 → fails validation → diagnostics should catch it
		const badMath = {
			...validMetadata,
			pieceCount: 10,
			progress: { totalPieces: 10, generatedPieces: 0, updatedAt: Date.now() }
		};
		const kv = makeKV(badMath);
		await expect(getMetadata(kv, 'puzzle-1')).rejects.toThrow(/grid math mismatch/);
	});

	it('throws when KV returns a non-object (e.g. string)', async () => {
		const kv = makeKV('invalid-string-data');
		await expect(getMetadata(kv, 'puzzle-1')).rejects.toThrow(/not an object/);
	});

	it('reports "unknown validation failure" when field checks pass but enum validation fails', async () => {
		// status is a non-empty string (passes getValidationDiagnostics typeof check)
		// but not a valid status enum value (fails validatePuzzleMetadata),
		// so getValidationDiagnostics finds no issues → 'unknown validation failure'.
		const dataWithUnknownStatus = {
			id: 'test-id',
			name: 'Test Puzzle',
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			imageWidth: 300,
			imageHeight: 300,
			createdAt: Date.now(),
			version: 1,
			pieces: [],
			status: 'unknown' // valid string but not 'processing' | 'ready' | 'failed'
		};
		const kv = makeKV(dataWithUnknownStatus);
		await expect(getMetadata(kv, 'test-id')).rejects.toThrow(/unknown validation failure/);
	});
});
