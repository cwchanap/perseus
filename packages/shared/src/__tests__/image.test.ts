import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	sniffImageType,
	detectImageType,
	parseImageDimensions,
	validateImageEndMarker,
	validateImageStructural,
	type BlobLike
} from '../image';

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
	// 8 (signature) + 25 (IHDR chunk: 4 length + 4 type + 13 data + 4 CRC) = 33.
	// The extra byte beyond the old 32 ensures the IHDR chunk is complete so
	// chunk-boundary walkers (pngHasIDAT) find the next chunk at offset 33,
	// not misaligned by a missing CRC byte.
	const b = new Uint8Array(33);
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

	it('returns null for malformed JPEG with segLen < 2 in skip-path marker', async () => {
		// JPEG spec requires segLen >= 2 (the length field includes its own 2
		// bytes). A segLen of 0 or 1 is malformed — without an explicit guard,
		// the skip loop advances by less than 2 and can misinterpret segment
		// data as markers. The parser must reject these explicitly.
		// SOI + APP0 with segLen=0 (FF E0 00 00) + filler.
		const malformedSegLen0 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xc0]);
		expect(await parseImageDimensions(makeBlob(malformedSegLen0), 'image/jpeg')).toBeNull();

		// SOI + APP0 with segLen=1 (FF E0 00 01) + filler.
		const malformedSegLen1 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0xff, 0xc0]);
		expect(await parseImageDimensions(makeBlob(malformedSegLen1), 'image/jpeg')).toBeNull();
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

	it('returns null when JPEG SOF scan exceeds the 2 MiB cap (DoS guard)', async () => {
		// A crafted JPEG of many small marker segments could exhaust the
		// Workers CPU budget before reaching SOF/EOI/EOF. The scanner bails
		// (returns null) once pos exceeds SOF_SCAN_LIMIT (2 MiB). Build a
		// JPEG of ~2.1 MiB of standalone RST0 markers (FF D0, no payload)
		// followed by a valid SOF0 — the scanner must bail before reaching
		// SOF0. Each RST0 pair is 2 bytes, so ~1.05M iterations would be
		// needed without the cap.
		const sof0 = [
			0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x04, 0xb0, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11,
			0x01, 0x03, 0x11, 0x01
		];
		const fillBytes = 2 * 1024 * 1024 + 1024; // just past the 2 MiB cap
		const totalSize = 2 + fillBytes + sof0.length;
		const bytes = new Uint8Array(totalSize);
		bytes[0] = 0xff;
		bytes[1] = 0xd8; // SOI
		for (let i = 2; i < 2 + fillBytes; i += 2) {
			bytes[i] = 0xff;
			bytes[i + 1] = 0xd0; // RST0 (standalone, no payload)
		}
		bytes.set(sof0, 2 + fillBytes);
		const blob = makeBlob(bytes);
		expect(await parseImageDimensions(blob, 'image/jpeg')).toBeNull();
	});

	it('returns null when JPEG SOF scan exceeds the iteration cap (DoS guard)', async () => {
		// The byte cap alone does not bound CPU: a stream of 2-byte standalone
		// markers (FF D0 RST0) under the 2 MiB cap would still spin ~1M loop
		// iterations. The iteration cap (SOF_ITERATION_LIMIT = 10_000) bails
		// early. Build a JPEG of 10_001 RST0 markers (well under the byte cap)
		// followed by a valid SOF0 — the scanner must bail before reaching
		// SOF0 on iteration count alone.
		const sof0 = [
			0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x04, 0xb0, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11,
			0x01, 0x03, 0x11, 0x01
		];
		const rstPairs = 10_001; // one past the cap; total bytes = 2 + 20002 = ~20 KiB (well under byte cap)
		const totalSize = 2 + rstPairs * 2 + sof0.length;
		const bytes = new Uint8Array(totalSize);
		bytes[0] = 0xff;
		bytes[1] = 0xd8; // SOI
		for (let i = 0; i < rstPairs; i++) {
			bytes[2 + i * 2] = 0xff;
			bytes[2 + i * 2 + 1] = 0xd0; // RST0 (standalone, no payload)
		}
		bytes.set(sof0, 2 + rstPairs * 2);
		const blob = makeBlob(bytes);
		expect(await parseImageDimensions(blob, 'image/jpeg')).toBeNull();
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

	it('returns zero dimensions for PNG with zero width or height (not null)', async () => {
		expect(await parseImageDimensions(makeBlob(pngHeaderBytes(0, 400)), 'image/png')).toEqual({
			width: 0,
			height: 400
		});
		expect(await parseImageDimensions(makeBlob(pngHeaderBytes(600, 0)), 'image/png')).toEqual({
			width: 600,
			height: 0
		});
		expect(await parseImageDimensions(makeBlob(pngHeaderBytes(0, 0)), 'image/png')).toEqual({
			width: 0,
			height: 0
		});
	});

	it('returns zero dimensions for JPEG with zero width or height (not null)', async () => {
		expect(await parseImageDimensions(makeBlob(jpegHeaderBytes(0, 400)), 'image/jpeg')).toEqual({
			width: 0,
			height: 400
		});
		expect(await parseImageDimensions(makeBlob(jpegHeaderBytes(600, 0)), 'image/jpeg')).toEqual({
			width: 600,
			height: 0
		});
	});

	it('returns zero dimensions for WebP VP8 with zero width or height (not null)', async () => {
		expect(await parseImageDimensions(makeBlob(webpVp8Bytes(0, 400)), 'image/webp')).toEqual({
			width: 0,
			height: 400
		});
		expect(await parseImageDimensions(makeBlob(webpVp8Bytes(600, 0)), 'image/webp')).toEqual({
			width: 600,
			height: 0
		});
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

// ─── validateImageStructural (fallback path) ───────────────────────
// These tests exercise the structural marker checks directly. In production,
// validateImageEndMarker prefers a bounded decode via the runtime's native
// decoder; the structural checks are the fallback when no decoder is
// available. The synthetic bytes below pass structural checks but are NOT
// actually decodable — they test the marker-scanning logic, not decodability.

describe('validateImageStructural', () => {
	it('validates a PNG with IDAT and IEND chunks', async () => {
		const header = pngHeaderBytes(600, 400);
		// Append a minimal IDAT chunk: 4-byte length (1) + "IDAT" + 1 byte data + 4-byte CRC = 13 bytes
		const idat = new Uint8Array([
			0x00, 0x00, 0x00, 0x01, 0x49, 0x44, 0x41, 0x54, 0x00, 0x00, 0x00, 0x00, 0x00
		]);
		// Append IEND chunk: 4-byte zero length + "IEND" + CRC AE 42 60 82
		const iend = new Uint8Array([
			0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
		]);
		const full = new Uint8Array(header.length + idat.length + iend.length);
		full.set(header, 0);
		full.set(idat, header.length);
		full.set(iend, header.length + idat.length);
		expect(await validateImageStructural(makeBlob(full), 'image/png')).toBe(true);
	});

	it('rejects a PNG without IEND (truncated after header)', async () => {
		// Just the header, no IEND — this is the vulnerability: a truncated
		// PNG that passes parseImageDimensions but has no image data.
		const header = pngHeaderBytes(600, 400);
		expect(await validateImageStructural(makeBlob(header), 'image/png')).toBe(false);
	});

	it('rejects a header-only PNG with IEND but no IDAT (no image data)', async () => {
		// A PNG with IHDR + IEND but no IDAT chunk: valid structure but no
		// image data. Without the IDAT check this would pass validation and
		// fail later in the decoder, producing a 500 after R2 upload.
		const header = pngHeaderBytes(600, 400);
		const iend = new Uint8Array([
			0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
		]);
		const full = new Uint8Array(header.length + iend.length);
		full.set(header, 0);
		full.set(iend, header.length);
		expect(await validateImageStructural(makeBlob(full), 'image/png')).toBe(false);
	});

	it('rejects a PNG with wrong end bytes (not IEND)', async () => {
		const header = pngHeaderBytes(600, 400);
		// Append some random bytes instead of IEND
		const tail = new Uint8Array([
			0x00, 0x00, 0x00, 0x00, 0x49, 0x44, 0x41, 0x54, 0x00, 0x00, 0x00, 0x00
		]);
		const full = new Uint8Array(header.length + tail.length);
		full.set(header, 0);
		full.set(tail, header.length);
		expect(await validateImageStructural(makeBlob(full), 'image/png')).toBe(false);
	});

	it('rejects a PNG with more than 10,000 chunks (iteration limit)', async () => {
		// A crafted PNG with many zero-length chunks could exhaust CPU
		// before reaching IDAT. The iteration cap (10,000) prevents this.
		// Each zero-length chunk is 12 bytes (4 length + 4 type + 0 data + 4 CRC).
		// 10,001 chunks = 120,012 bytes — well within the 2 MiB byte cap.
		const header = pngHeaderBytes(600, 400);
		const chunkCount = 10_001;
		const chunkSize = 12;
		const chunks = new Uint8Array(chunkCount * chunkSize);
		for (let i = 0; i < chunkCount; i++) {
			// Zero-length "tEXt" chunk (type doesn't matter as long as it's
			// not IDAT or IEND)
			chunks[i * chunkSize + 4] = 0x74; // t
			chunks[i * chunkSize + 5] = 0x45; // E
			chunks[i * chunkSize + 6] = 0x58; // X
			chunks[i * chunkSize + 7] = 0x74; // t
		}
		const full = new Uint8Array(header.length + chunks.length);
		full.set(header, 0);
		full.set(chunks, header.length);
		expect(await validateImageStructural(makeBlob(full), 'image/png')).toBe(false);
	});

	it('validates a JPEG with SOS and EOI markers', async () => {
		const header = jpegHeaderBytes(600, 400);
		// Append SOS marker (FF DA) with a minimal segment + EOI (FF D9)
		const sos = new Uint8Array([
			0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00
		]);
		const eoi = new Uint8Array([0xff, 0xd9]);
		const full = new Uint8Array(header.length + sos.length + eoi.length);
		full.set(header, 0);
		full.set(sos, header.length);
		full.set(eoi, header.length + sos.length);
		expect(await validateImageStructural(makeBlob(full), 'image/jpeg')).toBe(true);
	});

	it('validates a JPEG with trailing fill bytes after EOI', async () => {
		const header = jpegHeaderBytes(600, 400);
		const sos = new Uint8Array([
			0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00
		]);
		// Append EOI + some trailing padding (some encoders do this)
		const eoi = new Uint8Array([0xff, 0xd9, 0x00, 0x00, 0x00]);
		const full = new Uint8Array(header.length + sos.length + eoi.length);
		full.set(header, 0);
		full.set(sos, header.length);
		full.set(eoi, header.length + sos.length);
		expect(await validateImageStructural(makeBlob(full), 'image/jpeg')).toBe(true);
	});

	it('rejects a JPEG without EOI (truncated)', async () => {
		const header = jpegHeaderBytes(600, 400);
		// No EOI — just the header
		expect(await validateImageStructural(makeBlob(header), 'image/jpeg')).toBe(false);
	});

	it('rejects a header-only JPEG with EOI but no SOS (no scan data)', async () => {
		// A JPEG with SOF + EOI but no SOS: valid headers but no compressed
		// image data. Without the SOS check this would pass validation and
		// fail later in the decoder.
		const header = jpegHeaderBytes(600, 400);
		const eoi = new Uint8Array([0xff, 0xd9]);
		const full = new Uint8Array(header.length + eoi.length);
		full.set(header, 0);
		full.set(eoi, header.length);
		expect(await validateImageStructural(makeBlob(full), 'image/jpeg')).toBe(false);
	});

	it('validates a WebP where file size >= declared RIFF size', async () => {
		const header = webpVp8Bytes(600, 400);
		// RIFF size at offset 4 is currently 0 (34 - 8 = 26). Set it to
		// the actual payload size so the check passes.
		const dv = new DataView(header.buffer);
		dv.setUint32(4, header.length - 8, true);
		expect(await validateImageStructural(makeBlob(header), 'image/webp')).toBe(true);
	});

	it('rejects a truncated WebP (file smaller than declared RIFF size)', async () => {
		const header = webpVp8Bytes(600, 400);
		// Declare a larger RIFF size than the actual file
		const dv = new DataView(header.buffer);
		dv.setUint32(4, 1000, true); // claims 1008 bytes, file is only 34
		expect(await validateImageStructural(makeBlob(header), 'image/webp')).toBe(false);
	});

	it('rejects a WebP whose RIFF length has the high bit set (unsigned overflow)', async () => {
		// Assembling the RIFF length with signed JS bitwise operators
		// (header[7] << 24) yields a negative number when the high bit is
		// set, and `size >= negative` is always true — so a truncated WebP
		// with a high-bit length byte would bypass the check. The fix reads
		// the length as unsigned; the declared size (0xFF... + 8) far
		// exceeds the actual file, so this must be rejected.
		const header = webpVp8Bytes(600, 400);
		const dv = new DataView(header.buffer);
		dv.setUint32(4, 0xffffffff, true); // declares ~4 GiB, file is 34 bytes
		expect(await validateImageStructural(makeBlob(header), 'image/webp')).toBe(false);
	});

	it('rejects a WebP with a zero declared RIFF length', async () => {
		// A zero declared length means riffSize = 8 (just "RIFF" + size),
		// with no "WEBP" or any chunk — not a valid WebP. The old check
		// passed because `size >= 8` was always true for any file ≥ 12
		// bytes. Require riffSize ≥ 12 (RIFF + size + WEBP) to reject.
		const header = webpVp8Bytes(600, 400);
		const dv = new DataView(header.buffer);
		dv.setUint32(4, 0, true); // declares 8 bytes total, file is 34
		expect(await validateImageStructural(makeBlob(header), 'image/webp')).toBe(false);
	});

	it('rejects a VP8X-only WebP with no image frame chunk', async () => {
		// A VP8X (extended container) chunk carries only canvas dimensions
		// and flags — no decodable image data. Without the image-chunk
		// check this would pass validation and fail in the decoder.
		const header = webpVp8XBytes(600, 400);
		// Set RIFF size to actual file size so the size check passes.
		const dv = new DataView(header.buffer);
		dv.setUint32(4, header.length - 8, true);
		expect(await validateImageStructural(makeBlob(header), 'image/webp')).toBe(false);
	});

	it('rejects a WebP with more than 10,000 chunks (iteration limit)', async () => {
		// A crafted WebP with many tiny chunks could exhaust CPU before
		// reaching VP8/VP8L/ANMF. The iteration cap (10,000) prevents this.
		// Each zero-length chunk is 8 bytes (4 fourCC + 4 size).
		// 10,001 chunks = 80,008 bytes + 12 header = 80,020 — within 2 MiB.
		const chunkCount = 10_001;
		const chunkSize = 8;
		const buf = new Uint8Array(12 + chunkCount * chunkSize);
		// RIFF header
		buf.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
		const dv = new DataView(buf.buffer);
		dv.setUint32(4, buf.length - 8, true); // RIFF size
		buf.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
		for (let i = 0; i < chunkCount; i++) {
			const off = 12 + i * chunkSize;
			// "XXXX" fourCC (not VP8/VP8L/ANMF)
			buf.set([0x58, 0x58, 0x58, 0x58], off);
			// zero chunk size
		}
		expect(await validateImageStructural(makeBlob(buf), 'image/webp')).toBe(false);
	});

	it('rejects unknown image format', async () => {
		const blob = makeBlob(new Uint8Array([0x00, 0x01, 0x02, 0x03]));
		expect(await validateImageStructural(blob, 'image/gif')).toBe(false);
	});

	it('rejects PNG smaller than 12 bytes', async () => {
		const blob = makeBlob(new Uint8Array(8));
		expect(await validateImageStructural(blob, 'image/png')).toBe(false);
	});

	it('rejects JPEG smaller than 4 bytes', async () => {
		const blob = makeBlob(new Uint8Array(2));
		expect(await validateImageStructural(blob, 'image/jpeg')).toBe(false);
	});
});

// ─── validateImageEndMarker (bounded decode primary path) ──────────
// validateImageEndMarker first attempts a bounded decode via the runtime's
// native decoder (Bun.Image in Bun, createImageBitmap in Workers). A
// successful decode proves the image is complete and valid — stronger than
// structural marker checks. These tests use real decodable images generated
// from a data URL, plus corrupt variants, to verify the decode path.

describe('validateImageEndMarker', () => {
	// Generate real decodable images from a 1x1 red pixel PNG data URL.
	// Bun.Image can encode to PNG, JPEG, and WebP from this source.
	const RED_PIXEL_DATA_URL =
		'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

	let realPng: Uint8Array;
	let realJpeg: Uint8Array;
	let realWebp: Uint8Array;

	// Generate all three formats once. Bun.Image.png()/jpeg()/webp() return
	// a new Image; .bytes() is the terminal call that produces encoded bytes.
	// Using allTests: true would run this for every test; instead we generate
	// lazily on first use.
	// Cast through unknown: bun-types' `Bun` namespace doesn't expose `Image`
	// under this project's lib config, but it exists at runtime.
	type BunImageLike = {
		png(): { bytes(): Promise<Uint8Array> };
		jpeg(): { bytes(): Promise<Uint8Array> };
		webp(): { bytes(): Promise<Uint8Array> };
	};
	async function ensureImages() {
		if (realPng) return;
		const BunGlobal = (
			globalThis as unknown as { Bun?: { Image: new (input: string) => BunImageLike } }
		).Bun;
		if (!BunGlobal?.Image) {
			throw new Error('Bun.Image is required for validateImageEndMarker tests');
		}
		const source = new BunGlobal.Image(RED_PIXEL_DATA_URL);
		realPng = await source.png().bytes();
		realJpeg = await source.jpeg().bytes();
		realWebp = await source.webp().bytes();
	}

	it('validates a real decodable PNG', async () => {
		await ensureImages();
		expect(await validateImageEndMarker(makeBlob(realPng), 'image/png')).toBe(true);
	});

	it('validates a real decodable JPEG', async () => {
		await ensureImages();
		expect(await validateImageEndMarker(makeBlob(realJpeg), 'image/jpeg')).toBe(true);
	});

	it('validates a real decodable WebP', async () => {
		await ensureImages();
		expect(await validateImageEndMarker(makeBlob(realWebp), 'image/webp')).toBe(true);
	});

	it('rejects a truncated PNG (IDAT data cut off)', async () => {
		await ensureImages();
		const truncated = realPng.slice(0, realPng.length - 20);
		expect(await validateImageEndMarker(makeBlob(truncated), 'image/png')).toBe(false);
	});

	it('rejects a truncated JPEG (scan data cut off)', async () => {
		await ensureImages();
		const truncated = realJpeg.slice(0, realJpeg.length - 20);
		expect(await validateImageEndMarker(makeBlob(truncated), 'image/jpeg')).toBe(false);
	});

	it('rejects a truncated WebP (frame data cut off)', async () => {
		await ensureImages();
		const truncated = realWebp.slice(0, realWebp.length - 20);
		expect(await validateImageEndMarker(makeBlob(truncated), 'image/webp')).toBe(false);
	});

	it('rejects a PNG with valid header + IEND but no IDAT (structural pass, decode fail)', async () => {
		// This is the key case: the structural fallback would accept this
		// (IEND present, but no IDAT → structural rejects). The bounded
		// decode also rejects it (not decodable). Both paths agree: reject.
		const header = pngHeaderBytes(600, 400);
		const iend = new Uint8Array([
			0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
		]);
		const full = new Uint8Array(header.length + iend.length);
		full.set(header, 0);
		full.set(iend, header.length);
		expect(await validateImageEndMarker(makeBlob(full), 'image/png')).toBe(false);
	});

	it('rejects a PNG with valid header + IDAT marker + IEND but corrupt IDAT data', async () => {
		// Structural fallback would accept this (IDAT present, IEND present).
		// Bounded decode rejects it (IDAT data is not valid compressed data).
		// This is the case the bounded decode catches that structural cannot.
		const header = pngHeaderBytes(600, 400);
		const idat = new Uint8Array([
			0x00, 0x00, 0x00, 0x01, 0x49, 0x44, 0x41, 0x54, 0x00, 0x00, 0x00, 0x00, 0x00
		]);
		const iend = new Uint8Array([
			0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
		]);
		const full = new Uint8Array(header.length + idat.length + iend.length);
		full.set(header, 0);
		full.set(idat, header.length);
		full.set(iend, header.length + idat.length);
		expect(await validateImageEndMarker(makeBlob(full), 'image/png')).toBe(false);
	});

	it('rejects a JPEG with valid header + SOS + EOI but corrupt scan data', async () => {
		// Structural fallback would accept this (SOS present, EOI present).
		// Bounded decode rejects it (scan data is not valid). This is the
		// case the bounded decode catches that structural cannot.
		const header = jpegHeaderBytes(600, 400);
		const sos = new Uint8Array([
			0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00
		]);
		const eoi = new Uint8Array([0xff, 0xd9]);
		const full = new Uint8Array(header.length + sos.length + eoi.length);
		full.set(header, 0);
		full.set(sos, header.length);
		full.set(eoi, header.length + sos.length);
		expect(await validateImageEndMarker(makeBlob(full), 'image/jpeg')).toBe(false);
	});

	it('rejects unknown image format', async () => {
		const blob = makeBlob(new Uint8Array([0x00, 0x01, 0x02, 0x03]));
		expect(await validateImageEndMarker(blob, 'image/gif')).toBe(false);
	});

	it('rejects PNG smaller than 12 bytes', async () => {
		const blob = makeBlob(new Uint8Array(8));
		expect(await validateImageEndMarker(blob, 'image/png')).toBe(false);
	});

	it('rejects JPEG smaller than 4 bytes', async () => {
		const blob = makeBlob(new Uint8Array(2));
		expect(await validateImageEndMarker(blob, 'image/jpeg')).toBe(false);
	});
});

// ─── createImageBitmap path (mocked) ───────────────────────────────
// Cloudflare Workers does not expose createImageBitmap today, and Bun
// uses Bun.Image instead. These tests mock createImageBitmap on
// globalThis to verify that when a runtime DOES expose it, the code
// passes a Blob (per the ImageBitmapSource spec) — not a raw
// ArrayBuffer, which spec-compliant implementations reject.

describe('validateImageEndMarker – createImageBitmap path', () => {
	const RED_PIXEL_DATA_URL =
		'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

	let realPng: Uint8Array;

	type BunImageLike = {
		png(): { bytes(): Promise<Uint8Array> };
	};
	async function ensurePng() {
		if (realPng) return;
		const BunGlobal = (
			globalThis as unknown as { Bun?: { Image: new (input: string) => BunImageLike } }
		).Bun;
		if (!BunGlobal?.Image) {
			throw new Error('Bun.Image is required to generate test fixtures');
		}
		const source = new BunGlobal.Image(RED_PIXEL_DATA_URL);
		realPng = await source.png().bytes();
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('passes a Blob (not ArrayBuffer) to createImageBitmap with the sniffed MIME type', async () => {
		await ensurePng();

		const calls: { input: unknown; type: string | undefined }[] = [];
		const fakeBitmap = { close: vi.fn() };
		vi.stubGlobal(
			'createImageBitmap',
			vi.fn(async (input: Blob) => {
				calls.push({ input, type: input.type });
				return fakeBitmap;
			})
		);

		const result = await validateImageEndMarker(makeBlob(realPng), 'image/png');

		expect(result).toBe(true);
		expect(calls).toHaveLength(1);
		// The input must be a Blob (ImageBitmapSource), not an ArrayBuffer.
		// ArrayBuffer lacks `size` and `type`; Blob has both.
		expect(calls[0].input).toBeInstanceOf(Blob);
		expect(calls[0].type).toBe('image/png');
		// Bitmap must be closed to release memory.
		expect(fakeBitmap.close).toHaveBeenCalledTimes(1);
	});

	it('returns false when createImageBitmap throws (corrupt image), without falling back to structural', async () => {
		await ensurePng();

		vi.stubGlobal(
			'createImageBitmap',
			vi.fn(async () => {
				throw new Error('decode failed');
			})
		);

		// A real decodable PNG — but createImageBitmap throws. The code
		// must return false (decode failed), NOT fall through to Bun.Image
		// or structural validation (which would return true for this file).
		const result = await validateImageEndMarker(makeBlob(realPng), 'image/png');
		expect(result).toBe(false);
	});
});

// ─── @cf-wasm/photon path (Cloudflare Workers) ─────────────────────
// In Cloudflare Workers, neither createImageBitmap nor Bun.Image is
// available. The third decoder path in boundedDecode uses @cf-wasm/photon
// (a WebAssembly image decoder) to fully decode the image.
//
// These tests exercise the photon decode directly. The full integration
// path through boundedDecode → photon can only be tested in a workerd/
// Miniflare environment (where Bun.Image doesn't exist); under Bun, the
// Bun.Image path is always hit first and the Bun global is non-
// configurable so it cannot be stubbed. The runtime detection pattern
// (check → try → catch → fall through to next decoder) is already
// verified by the createImageBitmap tests above.

describe('validateImageEndMarker – @cf-wasm/photon decode capability', () => {
	const RED_PIXEL_DATA_URL =
		'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

	let realPng: Uint8Array;
	let realJpeg: Uint8Array;
	let realWebp: Uint8Array;

	type BunImageLike = {
		png(): { bytes(): Promise<Uint8Array> };
		jpeg(): { bytes(): Promise<Uint8Array> };
		webp(): { bytes(): Promise<Uint8Array> };
	};
	async function ensureImages() {
		if (realPng) return;
		const BunGlobal = (
			globalThis as unknown as { Bun?: { Image: new (input: string) => BunImageLike } }
		).Bun;
		if (!BunGlobal?.Image) {
			throw new Error('Bun.Image is required to generate test fixtures');
		}
		const source = new BunGlobal.Image(RED_PIXEL_DATA_URL);
		realPng = await source.png().bytes();
		realJpeg = await source.jpeg().bytes();
		realWebp = await source.webp().bytes();
	}

	it('photon decodes a real PNG and reports valid dimensions', async () => {
		await ensureImages();
		const { PhotonImage } = await import('@cf-wasm/photon');
		const image = PhotonImage.new_from_byteslice(realPng);
		try {
			expect(image.get_width()).toBeGreaterThan(0);
			expect(image.get_height()).toBeGreaterThan(0);
		} finally {
			image.free();
		}
	});

	it('photon decodes a real JPEG and reports valid dimensions', async () => {
		await ensureImages();
		const { PhotonImage } = await import('@cf-wasm/photon');
		const image = PhotonImage.new_from_byteslice(realJpeg);
		try {
			expect(image.get_width()).toBeGreaterThan(0);
		} finally {
			image.free();
		}
	});

	it('photon decodes a real WebP and reports valid dimensions', async () => {
		await ensureImages();
		const { PhotonImage } = await import('@cf-wasm/photon');
		const image = PhotonImage.new_from_byteslice(realWebp);
		try {
			expect(image.get_width()).toBeGreaterThan(0);
		} finally {
			image.free();
		}
	});

	it('photon rejects a truncated PNG (throws on corrupt input)', async () => {
		await ensureImages();
		const { PhotonImage } = await import('@cf-wasm/photon');
		const truncated = realPng.slice(0, realPng.length - 20);
		expect(() => PhotonImage.new_from_byteslice(truncated)).toThrow();
	});

	it('photon rejects a truncated JPEG (throws on corrupt input)', async () => {
		await ensureImages();
		const { PhotonImage } = await import('@cf-wasm/photon');
		const truncated = realJpeg.slice(0, realJpeg.length - 20);
		expect(() => PhotonImage.new_from_byteslice(truncated)).toThrow();
	});

	it('photon rejects a PNG with valid header + IDAT marker + IEND but corrupt IDAT data', async () => {
		// This is the key case P2 identified: structural validation accepts
		// this (IDAT present, IEND present), but a real decode rejects it
		// (IDAT data is not valid compressed data). The photon path catches
		// what structural cannot.
		await ensureImages();
		const { PhotonImage } = await import('@cf-wasm/photon');
		const header = pngHeaderBytes(600, 400);
		const idat = new Uint8Array([
			0x00, 0x00, 0x00, 0x01, 0x49, 0x44, 0x41, 0x54, 0x00, 0x00, 0x00, 0x00, 0x00
		]);
		const iend = new Uint8Array([
			0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
		]);
		const full = new Uint8Array(header.length + idat.length + iend.length);
		full.set(header, 0);
		full.set(idat, header.length);
		full.set(iend, header.length + idat.length);
		expect(() => PhotonImage.new_from_byteslice(full)).toThrow();
	});

	it('photon rejects a JPEG with valid header + SOS + EOI but corrupt scan data', async () => {
		await ensureImages();
		const { PhotonImage } = await import('@cf-wasm/photon');
		const header = jpegHeaderBytes(600, 400);
		const sos = new Uint8Array([
			0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00
		]);
		const eoi = new Uint8Array([0xff, 0xd9]);
		const full = new Uint8Array(header.length + sos.length + eoi.length);
		full.set(header, 0);
		full.set(sos, header.length);
		full.set(eoi, header.length + sos.length);
		expect(() => PhotonImage.new_from_byteslice(full)).toThrow();
	});

	it('photon dynamic import resolves successfully (package is installed)', async () => {
		// Verify the dynamic import used by boundedDecode's third path
		// resolves. This is the guard that enables the photon path in
		// Cloudflare Workers.
		const photon = await import('@cf-wasm/photon');
		expect(photon.PhotonImage).toBeDefined();
		expect(typeof photon.PhotonImage.new_from_byteslice).toBe('function');
	});
});
