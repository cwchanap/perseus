import { describe, it, expect } from 'vitest';
import { sniffImageType, detectImageType, parseImageDimensions, type BlobLike } from '../image';

// bun-types' `Blob` interface (under lib: ES2022, no DOM) omits `slice`, so a
// real Blob isn't structurally assignable to BlobLike even though it has slice
// at runtime. Wrap construction so tests typecheck against the exported type.
function makeBlob(bytes: Uint8Array): BlobLike {
	return new Blob([bytes]) as unknown as BlobLike;
}

// ─── sniffImageType boundary tests ──────────────────────────────────
// These tests pin the boundary behavior so future changes are caught:
//   - < 3 bytes  → null (too short for any format)
//   - 3 bytes    → null for JPEG (FF D8 FF alone is truncated — needs 4+)
//   - 4+ bytes   → JPEG detectable (FF D8 FF + marker code)
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

	// --- JPEG boundary (SOI FF D8 + FF + marker code = minimum 4 bytes) ---

	it('returns null for exactly 3 bytes matching JPEG SOI prefix (truncated)', () => {
		// FF D8 FF alone is a truncated header — no marker code byte follows,
		// so this is not a valid JPEG image. Rejecting it prevents callers from
		// proceeding with malformed bytes when dimension parsing returns null.
		expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
	});

	it('returns null for 3 bytes that do not match any format', () => {
		expect(sniffImageType(new Uint8Array([0x00, 0x00, 0x00]))).toBeNull();
	});

	it('returns jpeg for 4 bytes matching JPEG SOI + marker code', () => {
		// FF D8 FF E0 — SOI + APP0 marker prefix (minimum valid JPEG header).
		expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
	});

	it('returns jpeg for a full JPEG header (4+ bytes with padding)', () => {
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
		expect(sniffImageType(bytes)).toBe('image/jpeg');
	});

	it('returns null for FF D8 FF 00 (0x00 is byte-stuffing, not a marker)', () => {
		// After SOI (FF D8), FF must be followed by a marker code, not 0x00.
		// 0x00 is byte-stuffing — only valid inside entropy-coded segments,
		// never at the marker level. Accepting it would label malformed bytes
		// as JPEG and let them through to storage.
		expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBeNull();
	});

	it('returns jpeg for FF D8 FF FF (0xFF is a valid fill byte before marker)', () => {
		// Fill bytes (0xFF) are spec-valid before a marker — the dimension
		// parser consumes them individually. The sniffer must accept this.
		expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xff]))).toBe('image/jpeg');
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
		const blob = makeBlob(bytes);
		expect(await detectImageType(blob)).toBe('image/jpeg');
	});

	it('detects PNG from a Blob', async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const blob = makeBlob(bytes);
		expect(await detectImageType(blob)).toBe('image/png');
	});

	it('detects WebP from a Blob', async () => {
		const bytes = new Uint8Array([
			0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50
		]);
		const blob = makeBlob(bytes);
		expect(await detectImageType(blob)).toBe('image/webp');
	});

	it('returns null for an unrecognized Blob', async () => {
		const blob = makeBlob(new Uint8Array([0x00, 0x01, 0x02, 0x03]));
		expect(await detectImageType(blob)).toBeNull();
	});

	it('reads only the first 12 bytes (slice 0..12)', async () => {
		// A blob with JPEG magic in first 4 bytes but garbage after — still JPEG
		const bytes = new Uint8Array(100);
		bytes[0] = 0xff;
		bytes[1] = 0xd8;
		bytes[2] = 0xff;
		bytes[3] = 0xe0; // APP0 marker code (bytes[3] must be a valid marker, not 0x00)
		const blob = makeBlob(bytes);
		expect(await detectImageType(blob)).toBe('image/jpeg');
	});
});

// ─── parseImageDimensions (binary header parsing) ──────────────────
// Constructs minimal valid headers for each format and verifies the parser
// extracts width/height without decoding the full image. These are the
// trickiest code paths (JPEG SOF marker scan, three WebP VP8 variants).

function pngHeaderBytes(width: number, height: number): Uint8Array {
	const b = new Uint8Array(32);
	// PNG signature
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	// IHDR chunk length = 13
	b.set([0x00, 0x00, 0x00, 0x0d], 8);
	// "IHDR"
	b.set([0x49, 0x48, 0x44, 0x52], 12);
	// width/height are 4-byte big-endian at offset 16–23
	const dv = new DataView(b.buffer);
	dv.setUint32(16, width);
	dv.setUint32(20, height);
	return b;
}

function jpegHeaderBytes(width: number, height: number): Uint8Array {
	// SOI + APP0/JFIF (18 bytes incl. marker) + SOF0 segment carrying dims.
	const app0 = [
		0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01,
		0x00, 0x00
	];
	// SOF0: FF C0, length 0x0011 (17, covers length+precision+dims+3 components),
	// precision 08, height(2 BE), width(2 BE), 03 components, 9 component bytes.
	const sof0 = [
		0xff,
		0xc0,
		0x00,
		0x11,
		0x08,
		(height >> 8) & 0xff,
		height & 0xff,
		(width >> 8) & 0xff,
		width & 0xff,
		0x03,
		0x01,
		0x22,
		0x00,
		0x02,
		0x11,
		0x01,
		0x03,
		0x11,
		0x01
	];
	return new Uint8Array([0xff, 0xd8, ...app0, ...sof0]);
}

function webpVp8Bytes(width: number, height: number): Uint8Array {
	// RIFF....WEBP + "VP8 " (lossy) chunk. Width/height are 14-bit LE at
	// slice offsets 14/16 (file offsets 26/28), masked with 0x3fff.
	const b = new Uint8Array(34);
	b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
	b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
	b.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
	const dv = new DataView(b.buffer);
	dv.setUint16(26, width & 0x3fff, true);
	dv.setUint16(28, height & 0x3fff, true);
	return b;
}

function webpVp8LBytes(width: number, height: number): Uint8Array {
	// "VP8L" (lossless): 1-byte signature (0x2f) + 4-byte packed image size.
	// width-1 in low 14 bits, height-1 in next 14 bits (little-endian uint32).
	const b = new Uint8Array(34);
	b.set([0x52, 0x49, 0x46, 0x46], 0);
	b.set([0x57, 0x45, 0x42, 0x50], 8);
	b.set([0x56, 0x50, 0x38, 0x4c], 12); // "VP8L"
	b[20] = 0x2f; // signature
	const packed = ((width - 1) | ((height - 1) << 14)) >>> 0;
	new DataView(b.buffer).setUint32(21, packed, true);
	return b;
}

function webpVp8XBytes(width: number, height: number): Uint8Array {
	// "VP8X" (extended): flags + 3 reserved + canvas-width-1 (3-byte LE) +
	// canvas-height-1 (3-byte LE). Stored +1 on read.
	const b = new Uint8Array(34);
	b.set([0x52, 0x49, 0x46, 0x46], 0);
	b.set([0x57, 0x45, 0x42, 0x50], 8);
	b.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
	b[20] = 0x00; // flags (don't care)
	b[24] = (width - 1) & 0xff;
	b[25] = ((width - 1) >> 8) & 0xff;
	b[26] = ((width - 1) >> 16) & 0xff;
	b[27] = (height - 1) & 0xff;
	b[28] = ((height - 1) >> 8) & 0xff;
	b[29] = ((height - 1) >> 16) & 0xff;
	return b;
}

describe('parseImageDimensions', () => {
	it('parses PNG width/height from IHDR', async () => {
		const blob = makeBlob(pngHeaderBytes(600, 400));
		expect(await parseImageDimensions(blob, 'image/png')).toEqual({ width: 600, height: 400 });
	});

	it('parses a square PNG', async () => {
		const blob = makeBlob(pngHeaderBytes(1024, 1024));
		expect(await parseImageDimensions(blob, 'image/png')).toEqual({ width: 1024, height: 1024 });
	});

	it('parses JPEG width/height from SOF0 marker', async () => {
		const blob = makeBlob(jpegHeaderBytes(600, 400));
		expect(await parseImageDimensions(blob, 'image/jpeg')).toEqual({ width: 600, height: 400 });
	});

	it('parses JPEG dimensions after multiple leading marker segments', async () => {
		// SOI + an APP1 (EXIF) segment before SOF0, to exercise the skip loop.
		// APP1: FF E1 + 2-byte length (8) + 6 bytes payload.
		const app1 = [0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
		const sof0 = [
			0xff,
			0xc0,
			0x00,
			0x11,
			0x08,
			0x01,
			0x2c, // height = 300
			0x04,
			0xb0, // width = 1200
			0x03,
			0x01,
			0x22,
			0x00,
			0x02,
			0x11,
			0x01,
			0x03,
			0x11,
			0x01
		];
		const blob = makeBlob(new Uint8Array([0xff, 0xd8, ...app1, ...sof0]));
		expect(await parseImageDimensions(blob, 'image/jpeg')).toEqual({ width: 1200, height: 300 });
	});

	it('stops scanning at SOS marker and returns null (no SOF seen)', async () => {
		// SOI + APP0 + SOS (FF DA) before any SOF → scan stops, returns null.
		const app0 = [
			0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
			0x01, 0x00, 0x00
		];
		const sos = [
			0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00
		];
		const blob = makeBlob(new Uint8Array([0xff, 0xd8, ...app0, ...sos]));
		expect(await parseImageDimensions(blob, 'image/jpeg')).toBeNull();
	});

	// ─── JPEG fill-byte + incremental-read regression tests ───────────
	// The scanner must consume 0xFF fill bytes individually (not treat
	// 0xFF 0xFF as a marker pair) and read past the old 256 KiB limit for
	// JPEGs with large APP segments (EXIF, ICC profiles).

	it('parses JPEG dimensions after 0xFF fill bytes before SOF0', async () => {
		// SOI + FF FF (fill bytes) + SOF0. The old code treated FF FF as a
		// marker pair (marker=0xFF, offset+=2), then broke because the next
		// byte (C0) is not 0xFF — missing the SOF marker entirely.
		const sof0 = [
			0xff,
			0xc0,
			0x00,
			0x11,
			0x08,
			0x02,
			0x58, // height = 600
			0x04,
			0xb0, // width = 1200
			0x03,
			0x01,
			0x22,
			0x00,
			0x02,
			0x11,
			0x01,
			0x03,
			0x11,
			0x01
		];
		const blob = makeBlob(new Uint8Array([0xff, 0xd8, 0xff, 0xff, ...sof0]));
		expect(await parseImageDimensions(blob, 'image/jpeg')).toEqual({ width: 1200, height: 600 });
	});

	it('parses JPEG dimensions after multiple consecutive 0xFF fill bytes', async () => {
		// SOI + 5 fill bytes + SOF0 — exercises the fill-byte consumption loop.
		const sof0 = [
			0xff,
			0xc0,
			0x00,
			0x11,
			0x08,
			0x01,
			0x2c, // height = 300
			0x04,
			0xb0, // width = 1200
			0x03,
			0x01,
			0x22,
			0x00,
			0x02,
			0x11,
			0x01,
			0x03,
			0x11,
			0x01
		];
		const blob = makeBlob(new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xff, 0xff, 0xff, ...sof0]));
		expect(await parseImageDimensions(blob, 'image/jpeg')).toEqual({ width: 1200, height: 300 });
	});

	it('parses JPEG dimensions with fill bytes between APP0 and SOF0', async () => {
		// SOI + APP0 + FF FF (fill bytes between segments) + SOF0
		const app0 = [
			0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
			0x01, 0x00, 0x00
		];
		const sof0 = [
			0xff,
			0xc0,
			0x00,
			0x11,
			0x08,
			0x02,
			0x58, // height = 600
			0x04,
			0xb0, // width = 1200
			0x03,
			0x01,
			0x22,
			0x00,
			0x02,
			0x11,
			0x01,
			0x03,
			0x11,
			0x01
		];
		const blob = makeBlob(new Uint8Array([0xff, 0xd8, ...app0, 0xff, 0xff, ...sof0]));
		expect(await parseImageDimensions(blob, 'image/jpeg')).toEqual({ width: 1200, height: 600 });
	});

	it('parses JPEG dimensions when SOF0 is beyond 256 KiB (many APP segments)', async () => {
		// SOI + 5 × APP segments (each ~64 KiB, near the 16-bit segLen max of
		// 65535) + SOF0. Total APP data ~320 KiB, pushing SOF0 beyond the old
		// 256 KiB read limit. JPEG segLen is a 16-bit field, so a single
		// segment can't exceed 65535 bytes — large metadata (ICC profiles,
		// EXIF thumbnails) is split across multiple APP segments.
		const segLen = 65500;
		const numSegments = 5;
		const sof0 = [
			0xff,
			0xc0,
			0x00,
			0x11,
			0x08,
			0x01,
			0x2c, // height = 300
			0x04,
			0xb0, // width = 1200
			0x03,
			0x01,
			0x22,
			0x00,
			0x02,
			0x11,
			0x01,
			0x03,
			0x11,
			0x01
		];
		const segmentSize = 2 + segLen; // marker (FF Ex) + segLen bytes
		const totalSize = 2 + numSegments * segmentSize + sof0.length;
		const bytes = new Uint8Array(totalSize);
		let off = 0;
		bytes.set([0xff, 0xd8], off);
		off += 2;
		for (let i = 0; i < numSegments; i++) {
			bytes[off] = 0xff;
			bytes[off + 1] = 0xe0 + i; // APP0..APP4
			bytes[off + 2] = (segLen >> 8) & 0xff;
			bytes[off + 3] = segLen & 0xff;
			// payload is zeros (already initialized)
			off += segmentSize;
		}
		bytes.set(sof0, off);
		const blob = makeBlob(bytes);
		expect(await parseImageDimensions(blob, 'image/jpeg')).toEqual({ width: 1200, height: 300 });
	});

	it('parses JPEG dimensions after multiple APP segments with fill bytes', async () => {
		// SOI + APP0 + APP1 + fill bytes + SOF0 — combines incremental reading
		// (two APP segments) with fill-byte consumption in a single scan.
		const app0 = [
			0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
			0x01, 0x00, 0x00
		];
		const app1 = [0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
		const sof0 = [
			0xff,
			0xc0,
			0x00,
			0x11,
			0x08,
			0x02,
			0x58, // height = 600
			0x04,
			0xb0, // width = 1200
			0x03,
			0x01,
			0x22,
			0x00,
			0x02,
			0x11,
			0x01,
			0x03,
			0x11,
			0x01
		];
		const blob = makeBlob(new Uint8Array([0xff, 0xd8, ...app0, ...app1, 0xff, 0xff, ...sof0]));
		expect(await parseImageDimensions(blob, 'image/jpeg')).toEqual({ width: 1200, height: 600 });
	});

	it('parses WebP VP8 (lossy) dimensions', async () => {
		const blob = makeBlob(webpVp8Bytes(600, 400));
		expect(await parseImageDimensions(blob, 'image/webp')).toEqual({ width: 600, height: 400 });
	});

	it('parses WebP VP8L (lossless) dimensions', async () => {
		const blob = makeBlob(webpVp8LBytes(600, 400));
		expect(await parseImageDimensions(blob, 'image/webp')).toEqual({ width: 600, height: 400 });
	});

	it('parses WebP VP8X (extended) dimensions', async () => {
		const blob = makeBlob(webpVp8XBytes(600, 400));
		expect(await parseImageDimensions(blob, 'image/webp')).toEqual({ width: 600, height: 400 });
	});

	it('returns null for an unknown WebP chunk fourCC', async () => {
		const b = new Uint8Array(34);
		b.set([0x52, 0x49, 0x46, 0x46], 0);
		b.set([0x57, 0x45, 0x42, 0x50], 8);
		b.set([0x56, 0x50, 0x38, 0x5a], 12); // "VP8Z" — not a real variant
		const blob = makeBlob(b);
		expect(await parseImageDimensions(blob, 'image/webp')).toBeNull();
	});

	it('returns null for an unsupported mime type', async () => {
		const blob = makeBlob(new Uint8Array([0x47, 0x49, 0x46, 0x38])); // GIF
		expect(await parseImageDimensions(blob, 'image/gif')).toBeNull();
	});

	it('returns null for a truncated PNG header (< 24 bytes)', async () => {
		const truncated = pngHeaderBytes(600, 400).slice(0, 20);
		const blob = makeBlob(truncated);
		expect(await parseImageDimensions(blob, 'image/png')).toBeNull();
	});

	it('returns null for PNG with zero width or height', async () => {
		expect(await parseImageDimensions(makeBlob(pngHeaderBytes(0, 400)), 'image/png')).toBeNull();
		expect(await parseImageDimensions(makeBlob(pngHeaderBytes(600, 0)), 'image/png')).toBeNull();
		expect(await parseImageDimensions(makeBlob(pngHeaderBytes(0, 0)), 'image/png')).toBeNull();
	});

	it('returns null for JPEG with zero width or height', async () => {
		expect(await parseImageDimensions(makeBlob(jpegHeaderBytes(0, 400)), 'image/jpeg')).toBeNull();
		expect(await parseImageDimensions(makeBlob(jpegHeaderBytes(600, 0)), 'image/jpeg')).toBeNull();
	});

	it('returns null for WebP VP8 with zero width or height', async () => {
		expect(await parseImageDimensions(makeBlob(webpVp8Bytes(0, 400)), 'image/webp')).toBeNull();
		expect(await parseImageDimensions(makeBlob(webpVp8Bytes(600, 0)), 'image/webp')).toBeNull();
	});

	it('returns null when JPEG SOF declares a segment longer than remaining file', async () => {
		// SOI + SOF0 with segLen=0x0011 (17) but only enough bytes for the
		// dimension fields (7 of the segment payload). ensure(7) succeeds and
		// would return dims without a full-segment check.
		const truncatedSof = new Uint8Array([
			0xff,
			0xd8, // SOI
			0xff,
			0xc0, // SOF0
			0x00,
			0x11, // segLen = 17
			0x08, // precision
			0x01,
			0x90, // height = 400
			0x02,
			0x58 // width = 600 — EOF here; remaining SOF component bytes missing
		]);
		const blob = makeBlob(truncatedSof);
		expect(await parseImageDimensions(blob, 'image/jpeg')).toBeNull();
	});

	it('round-trips with detectImageType for a real PNG header', async () => {
		const bytes = pngHeaderBytes(800, 600);
		const blob = makeBlob(bytes);
		const mime = await detectImageType(blob);
		expect(mime).toBe('image/png');
		expect(await parseImageDimensions(blob, mime!)).toEqual({ width: 800, height: 600 });
	});
});
