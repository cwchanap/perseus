/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for server-side image aspect ratio validation in POST /puzzles.
 * Covers parseImageDimensions + aspectRatiosMatch + the 400 rejection path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/storage.worker', () => ({
	getPuzzle: vi.fn(),
	deletePuzzleAssets: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	createPuzzleMetadata: vi.fn(),
	uploadOriginalImage: vi.fn(),
	deleteOriginalImage: vi.fn(),
	listPuzzles: vi.fn()
}));

vi.mock('../../middleware/auth.worker', () => ({
	verifySession: vi.fn(),
	requireAuth: async (c: any, next: any) => {
		c.set('session', { userId: 'admin', username: 'admin', role: 'admin' });
		return next();
	},
	createSession: vi.fn(),
	setSessionCookie: vi.fn(),
	clearSessionCookie: vi.fn(),
	getSessionToken: vi.fn(() => 'valid-token'),
	revokeSession: vi.fn()
}));

import admin from '../admin.worker';
import * as storage from '../../services/storage.worker';

const baseEnv = {
	ADMIN_PASSKEY: 'test-passkey',
	JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
	PUZZLE_METADATA: {} as KVNamespace,
	PUZZLES_BUCKET: {} as R2Bucket,
	PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) }
};

// Build a minimal PNG file with the given width/height.
// PNG structure: 8-byte signature + 25-byte IHDR + 12-byte IEND
function makePng(width: number, height: number): Blob {
	const buf = new ArrayBuffer(8 + 25 + 12);
	const view = new DataView(buf);

	// PNG signature (8 bytes)
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	for (let i = 0; i < 8; i++) view.setUint8(i, sig[i]);

	// IHDR chunk: 4-byte length (13) + 4-byte type + 13 bytes data + 4-byte CRC
	view.setUint32(8, 13); // length
	view.setUint8(12, 0x49); // 'I'
	view.setUint8(13, 0x48); // 'H'
	view.setUint8(14, 0x44); // 'D'
	view.setUint8(15, 0x52); // 'R'
	view.setUint32(16, width); // width at offset 16
	view.setUint32(20, height); // height at offset 20
	view.setUint8(24, 8); // bit depth
	view.setUint8(25, 2); // color type (RGB)
	view.setUint8(26, 0); // compression
	view.setUint8(27, 0); // filter
	view.setUint8(28, 0); // interlace
	// CRC (bytes 29-32) — leave as zeros; we only need header bytes for parsing

	// IEND chunk (12 bytes)
	const iendOff = 33;
	view.setUint32(iendOff, 0); // length
	view.setUint8(iendOff + 4, 0x49); // 'I'
	view.setUint8(iendOff + 5, 0x45); // 'E'
	view.setUint8(iendOff + 6, 0x4e); // 'N'
	view.setUint8(iendOff + 7, 0x44); // 'D'
	// CRC (bytes 41-44) — leave as zeros

	return new Blob([buf], { type: 'image/png' });
}

// Build a minimal JPEG with the given width/height.
// SOI + APP0 + SOF0 with dimensions, all in one contiguous buffer.
function makeJpeg(width: number, height: number): Blob {
	// SOI(2) + APP0(marker(2)+length(2)+data(16)=20) + SOF0(marker(2)+length(2)+precision(1)+height(2)+width(2)+numComp(1)+3*3(9)=19) + EOI(2)
	const size = 2 + 20 + 19 + 2;
	const buf = new ArrayBuffer(size);
	const view = new DataView(buf);
	let off = 0;

	// SOI
	view.setUint8(off++, 0xff);
	view.setUint8(off++, 0xd8);

	// APP0 marker
	view.setUint8(off++, 0xff);
	view.setUint8(off++, 0xe0);
	// APP0 segment length (includes length bytes itself)
	view.setUint16(off, 18);
	off += 2;
	// APP0 data: 16 bytes of zeros
	off += 16;

	// SOF0 marker
	view.setUint8(off++, 0xff);
	view.setUint8(off++, 0xc0);
	// SOF0 segment length: includes the 2 length bytes themselves
	// Data after marker: length(2) + precision(1) + height(2) + width(2) + numComp(1) + 3*3(9) = 17
	view.setUint16(off, 17);
	off += 2;
	// Precision
	view.setUint8(off++, 8);
	// Height
	view.setUint16(off, height);
	off += 2;
	// Width
	view.setUint16(off, width);
	off += 2;
	// Number of components
	view.setUint8(off++, 3);
	// Component data: 3 components × 3 bytes each = 9 bytes (leave as zeros)
	off += 9;

	// EOI
	view.setUint8(off++, 0xff);
	view.setUint8(off++, 0xd9);

	return new Blob([buf], { type: 'image/jpeg' });
}

// Build a minimal WebP (VP8 lossy) with the given width/height
function makeWebP(width: number, height: number): Blob {
	const riffSize = 4 + 8 + 10; // "WEBP" + VP8 chunk header + VP8 frame header
	const buf = new ArrayBuffer(12 + riffSize);
	const view = new DataView(buf);

	// RIFF header
	view.setUint8(0, 0x52); // 'R'
	view.setUint8(1, 0x49); // 'I'
	view.setUint8(2, 0x46); // 'F'
	view.setUint8(3, 0x46); // 'F'
	view.setUint32(4, riffSize, true); // file size - 8
	view.setUint8(8, 0x57); // 'W'
	view.setUint8(9, 0x45); // 'E'
	view.setUint8(10, 0x42); // 'B'
	view.setUint8(11, 0x50); // 'P'

	// VP8 chunk
	const vp8Off = 12;
	view.setUint8(vp8Off, 0x56); // 'V'
	view.setUint8(vp8Off + 1, 0x50); // 'P'
	view.setUint8(vp8Off + 2, 0x38); // '8'
	view.setUint8(vp8Off + 3, 0x20); // ' '
	view.setUint32(vp8Off + 4, 10, true); // chunk size

	// VP8 bitstream frame tag (3 bytes) + sync code (3 bytes) + dimensions
	const frameOff = vp8Off + 8;
	// Frame tag: keyframe (2 bytes) + size byte
	view.setUint16(frameOff, 0x9d, true); // keyframe signature part 1
	view.setUint8(frameOff + 2, 0x01); // signature part 2
	// Sync code 0x9d 0x01 0x2a is implicit in the frame header
	// For VP8, the dimensions are encoded as 14-bit LE values
	const wEncoded = width & 0x3fff;
	const hEncoded = height & 0x3fff;
	view.setUint16(frameOff + 6, wEncoded, true);
	view.setUint16(frameOff + 8, hEncoded, true);

	return new Blob([buf], { type: 'image/webp' });
}

// Build a minimal WebP (VP8X extended) with the given width/height.
// VP8X layout (relative to header buffer starting at file offset 12):
//   [0..3] FourCC "VP8X" | [4..7] ChunkSize | [8] Flags | [9..11] Reserved
//   [12..14] CanvasWidth-1 (24-bit LE) | [15..17] CanvasHeight-1 (24-bit LE)
function makeWebPVp8x(width: number, height: number): Blob {
	const vp8xChunkSize = 10;
	const riffSize = 4 + 8 + vp8xChunkSize; // "WEBP" + VP8X chunk header + VP8X chunk data
	const buf = new ArrayBuffer(12 + riffSize);
	const view = new DataView(buf);

	// RIFF header
	view.setUint8(0, 0x52); // 'R'
	view.setUint8(1, 0x49); // 'I'
	view.setUint8(2, 0x46); // 'F'
	view.setUint8(3, 0x46); // 'F'
	view.setUint32(4, riffSize, true);
	view.setUint8(8, 0x57); // 'W'
	view.setUint8(9, 0x45); // 'E'
	view.setUint8(10, 0x42); // 'B'
	view.setUint8(11, 0x50); // 'P'

	// VP8X chunk header
	const off = 12;
	view.setUint8(off, 0x56); // 'V'
	view.setUint8(off + 1, 0x50); // 'P'
	view.setUint8(off + 2, 0x38); // '8'
	view.setUint8(off + 3, 0x58); // 'X'
	view.setUint32(off + 4, vp8xChunkSize, true);

	// VP8X chunk data
	const dataOff = off + 8;
	view.setUint8(dataOff, 0x10); // flags: has alpha bit set
	// bytes dataOff+1..3: reserved (0)
	// Canvas Width Minus One (24-bit LE) at dataOff+4 = header offset 12
	const wMinusOne = width - 1;
	view.setUint8(dataOff + 4, wMinusOne & 0xff);
	view.setUint8(dataOff + 5, (wMinusOne >> 8) & 0xff);
	view.setUint8(dataOff + 6, (wMinusOne >> 16) & 0xff);
	// Canvas Height Minus One (24-bit LE) at dataOff+7 = header offset 15
	const hMinusOne = height - 1;
	view.setUint8(dataOff + 7, hMinusOne & 0xff);
	view.setUint8(dataOff + 8, (hMinusOne >> 8) & 0xff);
	view.setUint8(dataOff + 9, (hMinusOne >> 16) & 0xff);

	return new Blob([buf], { type: 'image/webp' });
}

// Build a minimal WebP (VP8L lossless) with the given width/height.
// VP8L layout (relative to header buffer starting at file offset 12):
//   [0..3] FourCC "VP8L" | [4..7] ChunkSize | [8] Signature (0x2f)
//   [9..12] packed uint32 LE: width-1 (14 bits) | height-1 (14 bits) | alpha_hint (1 bit)
function makeWebPVp8l(width: number, height: number): Blob {
	const vp8lChunkSize = 5; // signature(1) + packed size(4)
	const riffSize = 4 + 8 + vp8lChunkSize;
	const buf = new ArrayBuffer(12 + riffSize);
	const view = new DataView(buf);

	// RIFF header
	view.setUint8(0, 0x52); // 'R'
	view.setUint8(1, 0x49); // 'I'
	view.setUint8(2, 0x46); // 'F'
	view.setUint8(3, 0x46); // 'F'
	view.setUint32(4, riffSize, true);
	view.setUint8(8, 0x57); // 'W'
	view.setUint8(9, 0x45); // 'E'
	view.setUint8(10, 0x42); // 'B'
	view.setUint8(11, 0x50); // 'P'

	// VP8L chunk header
	const off = 12;
	view.setUint8(off, 0x56); // 'V'
	view.setUint8(off + 1, 0x50); // 'P'
	view.setUint8(off + 2, 0x38); // '8'
	view.setUint8(off + 3, 0x4c); // 'L'
	view.setUint32(off + 4, vp8lChunkSize, true);

	// VP8L chunk data
	const dataOff = off + 8;
	view.setUint8(dataOff, 0x2f); // VP8L signature
	// Pack: width-1 (14 bits) | height-1 (14 bits) | alpha_hint (1 bit) | version (3 bits)
	const packed = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
	view.setUint32(dataOff + 1, packed, true);

	return new Blob([buf], { type: 'image/webp' });
}

describe('Admin Routes - Image aspect ratio validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);
	});

	it('rejects PNG with wrong aspect ratio for requested 3:4', async () => {
		// 300×300 (square) image with aspectRatio=3:4 (portrait)
		const blob = makePng(300, 300);
		const formData = new FormData();
		formData.append('name', 'Mismatched Puzzle');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '3:4');
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, baseEnv as any);

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBe('bad_request');
		expect(body.message).toContain('does not match requested ratio');
		expect(body.message).toContain('3:4');
	});

	it('accepts PNG with matching 1:1 aspect ratio', async () => {
		const blob = makePng(400, 400);
		const formData = new FormData();
		formData.append('name', 'Square Puzzle');
		formData.append('pieceCount', '16');
		formData.append('aspectRatio', '1:1');
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, baseEnv as any);

		expect(res.status).toBe(201);
	});

	it('accepts PNG with matching 4:3 aspect ratio', async () => {
		const blob = makePng(400, 300);
		const formData = new FormData();
		formData.append('name', 'Landscape Puzzle');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '4:3');
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, baseEnv as any);

		expect(res.status).toBe(201);
	});

	it('accepts PNG with matching 3:4 aspect ratio', async () => {
		const blob = makePng(300, 400);
		const formData = new FormData();
		formData.append('name', 'Portrait Puzzle');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '3:4');
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, baseEnv as any);

		expect(res.status).toBe(201);
	});

	it('rejects JPEG with wrong aspect ratio', async () => {
		// 600×400 = 3:2 ratio, requesting 1:1
		const blob = makeJpeg(600, 400);
		const formData = new FormData();
		formData.append('name', 'Mismatched JPEG');
		formData.append('pieceCount', '16');
		formData.append('aspectRatio', '1:1');
		formData.append('image', blob, 'test.jpg');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, baseEnv as any);

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.message).toContain('does not match requested ratio');
	});

	it('accepts JPEG with matching aspect ratio', async () => {
		const blob = makeJpeg(800, 600);
		const formData = new FormData();
		formData.append('name', 'Matched JPEG');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '4:3');
		formData.append('image', blob, 'test.jpg');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, baseEnv as any);

		expect(res.status).toBe(201);
	});

	it('rejects WebP with wrong aspect ratio', async () => {
		const blob = makeWebP(500, 500);
		const formData = new FormData();
		formData.append('name', 'Mismatched WebP');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '3:4');
		formData.append('image', blob, 'test.webp');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, baseEnv as any);

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.message).toContain('does not match requested ratio');
	});

	it('accepts WebP with matching aspect ratio', async () => {
		const blob = makeWebP(300, 400);
		const formData = new FormData();
		formData.append('name', 'Matched WebP');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '3:4');
		formData.append('image', blob, 'test.webp');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, baseEnv as any);

		expect(res.status).toBe(201);
	});

	it('accepts image within 5% tolerance for aspect ratio', async () => {
		// 4:3 = 1.333..., 403×300 = 1.343, which is ~0.8% off — within 5% tolerance
		const blob = makePng(403, 300);
		const formData = new FormData();
		formData.append('name', 'Near Match');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '4:3');
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, baseEnv as any);

		expect(res.status).toBe(201);
	});

	it('rejects image well outside 5% tolerance', async () => {
		// 300×200 = 1.5, requesting 1:1 — 50% off
		const blob = makePng(300, 200);
		const formData = new FormData();
		formData.append('name', 'Way Off');
		formData.append('pieceCount', '16');
		formData.append('aspectRatio', '1:1');
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, baseEnv as any);

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.message).toContain('300x200');
	});

	it('proceeds when dimensions cannot be parsed (graceful fallback)', async () => {
		// PNG with valid magic bytes but truncated (no IHDR data at offset 16)
		const header = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);
		const blob = new Blob([header], { type: 'image/png' });
		const formData = new FormData();
		formData.append('name', 'Tiny Puzzle');
		formData.append('pieceCount', '16');
		formData.append('aspectRatio', '1:1');
		formData.append('image', blob, 'tiny.png');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, baseEnv as any);

		// Should NOT reject on aspect ratio — proceeds to upload (which may fail,
		// but the aspect ratio check itself should pass gracefully)
		expect(res.status).not.toBe(400);
	});

	it('accepts VP8X WebP with matching 4:3 aspect ratio', async () => {
		const blob = makeWebPVp8x(400, 300);
		const formData = new FormData();
		formData.append('name', 'VP8X Landscape');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '4:3');
		formData.append('image', blob, 'test.webp');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, baseEnv as any);

		expect(res.status).toBe(201);
	});

	it('accepts VP8X WebP with matching 3:4 aspect ratio', async () => {
		const blob = makeWebPVp8x(300, 400);
		const formData = new FormData();
		formData.append('name', 'VP8X Portrait');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '3:4');
		formData.append('image', blob, 'test.webp');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, baseEnv as any);

		expect(res.status).toBe(201);
	});

	it('rejects VP8X WebP with wrong aspect ratio', async () => {
		const blob = makeWebPVp8x(500, 500);
		const formData = new FormData();
		formData.append('name', 'VP8X Square');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '3:4');
		formData.append('image', blob, 'test.webp');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, baseEnv as any);

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.message).toContain('does not match requested ratio');
	});

	it('accepts VP8L WebP with matching 4:3 aspect ratio', async () => {
		const blob = makeWebPVp8l(400, 300);
		const formData = new FormData();
		formData.append('name', 'VP8L Landscape');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '4:3');
		formData.append('image', blob, 'test.webp');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, baseEnv as any);

		expect(res.status).toBe(201);
	});

	it('rejects VP8L WebP with wrong aspect ratio', async () => {
		const blob = makeWebPVp8l(500, 500);
		const formData = new FormData();
		formData.append('name', 'VP8L Square');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '4:3');
		formData.append('image', blob, 'test.webp');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, baseEnv as any);

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.message).toContain('does not match requested ratio');
	});
});
