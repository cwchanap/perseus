import { describe, it, expect } from 'vitest';
import { sniffImageType, detectImageType } from '../image';

// ─── sniffImageType boundary tests ──────────────────────────────────
// The minimum-length threshold changed from 12 to 3 bytes (commit 744c961).
// These tests pin the boundary behavior so future changes are caught:
//   - < 3 bytes  → null (too short for any format)
//   - 3+ bytes   → JPEG detectable (FF D8 FF)
//   - 8+ bytes   → PNG detectable (89 50 4E 47 0D 0A 1A 0A)
//   - 12+ bytes  → WebP detectable (RIFF....WEBP)

describe('sniffImageType – boundary conditions', () => {
	// --- Below minimum threshold ---

	it('returns null for 0 bytes', () => {
		expect(sniffImageType(new Uint8Array(0))).toBeNull();
	});

	it('returns null for 1 byte', () => {
		expect(sniffImageType(new Uint8Array([0xff]))).toBeNull();
	});

	it('returns null for 2 bytes (below 3-byte minimum)', () => {
		expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
	});

	// --- JPEG boundary (3 magic bytes: FF D8 FF) ---

	it('returns jpeg for exactly 3 bytes matching JPEG header', () => {
		expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
	});

	it('returns null for 3 bytes that do not match any format', () => {
		expect(sniffImageType(new Uint8Array([0x00, 0x00, 0x00]))).toBeNull();
	});

	it('returns jpeg for 3 bytes matching JPEG even though PNG/WebP need more', () => {
		// This is the key behavior change: previously < 12 bytes returned null
		// for everything. Now 3-byte JPEG is detectable.
		const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
		expect(sniffImageType(bytes)).toBe('image/jpeg');
	});

	it('returns jpeg for a full JPEG header (3 bytes + padding)', () => {
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
		expect(sniffImageType(bytes)).toBe('image/jpeg');
	});

	// --- PNG boundary (8 magic bytes: 89 50 4E 47 0D 0A 1A 0A) ---

	it('returns null for 7 bytes matching PNG prefix but too short', () => {
		// First 7 bytes of PNG header — not enough for the 8-byte check
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]);
		expect(sniffImageType(bytes)).toBeNull();
	});

	it('returns png for exactly 8 bytes matching PNG header', () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(sniffImageType(bytes)).toBe('image/png');
	});

	it('returns null for 8 bytes that start with PNG but have wrong 8th byte', () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00]);
		expect(sniffImageType(bytes)).toBeNull();
	});

	// --- WebP boundary (12 magic bytes: RIFF....WEBP) ---

	it('returns null for 11 bytes matching WebP prefix but too short', () => {
		// RIFF + 4 size bytes + WEB (missing final P)
		const bytes = new Uint8Array([
			0x52,
			0x49,
			0x46,
			0x46, // RIFF
			0x00,
			0x00,
			0x00,
			0x00, // file size
			0x57,
			0x45,
			0x42 // "WEB" — missing "P"
		]);
		expect(sniffImageType(bytes)).toBeNull();
	});

	it('returns webp for exactly 12 bytes matching WebP header', () => {
		const bytes = new Uint8Array([
			0x52,
			0x49,
			0x46,
			0x46, // RIFF
			0x00,
			0x00,
			0x00,
			0x00, // file size
			0x57,
			0x45,
			0x42,
			0x50 // "WEBP"
		]);
		expect(sniffImageType(bytes)).toBe('image/webp');
	});

	it('returns null for 12 bytes with RIFF but wrong WEBP fourCC', () => {
		const bytes = new Uint8Array([
			0x52,
			0x49,
			0x46,
			0x46, // RIFF
			0x00,
			0x00,
			0x00,
			0x00, // file size
			0x57,
			0x41,
			0x56,
			0x45 // "WAVE" — not WebP
		]);
		expect(sniffImageType(bytes)).toBeNull();
	});

	// --- Format priority (JPEG checked first) ---

	it('checks JPEG before PNG before WebP', () => {
		// If bytes match JPEG, return jpeg even if they could partially match others
		expect(
			sniffImageType(
				new Uint8Array([0xff, 0xd8, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x52])
			)
		).toBe('image/jpeg');
	});
});

// ─── sniffImageType format recognition ──────────────────────────────

describe('sniffImageType – format recognition', () => {
	it('recognizes a realistic JPEG header', () => {
		const bytes = new Uint8Array([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01
		]);
		expect(sniffImageType(bytes)).toBe('image/jpeg');
	});

	it('recognizes a realistic PNG header', () => {
		const bytes = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d
		]);
		expect(sniffImageType(bytes)).toBe('image/png');
	});

	it('recognizes a realistic WebP header', () => {
		const bytes = new Uint8Array([
			0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50
		]);
		expect(sniffImageType(bytes)).toBe('image/webp');
	});

	it('returns null for unrecognized magic bytes', () => {
		expect(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull(); // GIF
	});

	it('returns null for random bytes', () => {
		expect(sniffImageType(new Uint8Array([0x01, 0x02, 0x03, 0x04]))).toBeNull();
	});
});

// ─── detectImageType (async, blob-based) ────────────────────────────

describe('detectImageType', () => {
	it('detects JPEG from a Blob', async () => {
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
		const blob = new Blob([bytes]);
		expect(await detectImageType(blob)).toBe('image/jpeg');
	});

	it('detects PNG from a Blob', async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const blob = new Blob([bytes]);
		expect(await detectImageType(blob)).toBe('image/png');
	});

	it('detects WebP from a Blob', async () => {
		const bytes = new Uint8Array([
			0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50
		]);
		const blob = new Blob([bytes]);
		expect(await detectImageType(blob)).toBe('image/webp');
	});

	it('returns null for an unrecognized Blob', async () => {
		const blob = new Blob([new Uint8Array([0x00, 0x01, 0x02, 0x03])]);
		expect(await detectImageType(blob)).toBeNull();
	});

	it('reads only the first 12 bytes (slice 0..12)', async () => {
		// A blob with JPEG magic in first 3 bytes but garbage after — still JPEG
		const bytes = new Uint8Array(100);
		bytes[0] = 0xff;
		bytes[1] = 0xd8;
		bytes[2] = 0xff;
		const blob = new Blob([bytes]);
		expect(await detectImageType(blob)).toBe('image/jpeg');
	});
});
