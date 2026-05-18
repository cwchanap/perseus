/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for server-side image aspect ratio validation in Bun POST /puzzles.
 * Covers parseImageDimensions + aspectRatiosMatch + the 400 rejection path.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// Set env vars before any imports so the IIFE in admin.ts resolves correctly.
const originalAdminPasskey = process.env.ADMIN_PASSKEY;
const originalJwtSecret = process.env.JWT_SECRET;
process.env.ADMIN_PASSKEY = 'aspect-ratio-test-admin-passkey';
process.env.JWT_SECRET = 'aspect-ratio-test-jwt-secret-for-bun-12345678901234';

vi.mock('../../middleware/auth', () => ({
	createSession: vi.fn().mockResolvedValue('mock-session-token'),
	setSessionCookie: vi.fn(),
	clearSessionCookie: vi.fn(),
	getSessionToken: vi.fn().mockReturnValue(null),
	verifySession: vi.fn().mockResolvedValue(null),
	requireAuth: vi.fn().mockImplementation(async (_c: any, next: any) => next())
}));

vi.mock('../../middleware/rate-limit', () => ({
	loginRateLimit: vi.fn().mockImplementation(async (_c: any, next: any) => next()),
	resetLoginAttempts: vi.fn()
}));

vi.mock('../../services/puzzle-generator', () => ({
	generatePuzzle: vi.fn(),
	isValidPieceCount: vi.fn().mockReturnValue(true)
}));

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined)
	};
});

vi.mock('../../services/storage', () => ({
	createPuzzle: vi.fn().mockResolvedValue(true),
	deletePuzzle: vi.fn().mockResolvedValue(true),
	listPuzzles: vi.fn().mockResolvedValue([]),
	puzzleExists: vi.fn().mockResolvedValue(false),
	getPuzzleDir: vi.fn().mockReturnValue('/fake/data/puzzles/test-id'),
	getOriginalImagePath: vi.fn().mockReturnValue('/fake/data/puzzles/test-id/original.png')
}));

afterAll(() => {
	if (originalAdminPasskey === undefined) {
		delete process.env.ADMIN_PASSKEY;
	} else {
		process.env.ADMIN_PASSKEY = originalAdminPasskey;
	}
	if (originalJwtSecret === undefined) {
		delete process.env.JWT_SECRET;
	} else {
		process.env.JWT_SECRET = originalJwtSecret;
	}
});

let app: any;
let generatorMock: any;

beforeAll(async () => {
	const adminModule = await import('../admin');
	app = adminModule.default;
	generatorMock = await import('../../services/puzzle-generator');
});

// Build a minimal PNG file with the given width/height.
function makePng(width: number, height: number): Blob {
	const buf = new ArrayBuffer(8 + 25 + 12);
	const view = new DataView(buf);

	// PNG signature (8 bytes)
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	for (let i = 0; i < 8; i++) view.setUint8(i, sig[i]);

	// IHDR chunk
	view.setUint32(8, 13); // length
	view.setUint8(12, 0x49); // 'I'
	view.setUint8(13, 0x48); // 'H'
	view.setUint8(14, 0x44); // 'D'
	view.setUint8(15, 0x52); // 'R'
	view.setUint32(16, width);
	view.setUint32(20, height);
	view.setUint8(24, 8); // bit depth
	view.setUint8(25, 2); // color type (RGB)
	view.setUint8(26, 0); // compression
	view.setUint8(27, 0); // filter
	view.setUint8(28, 0); // interlace
	// CRC left as zeros

	// IEND chunk (12 bytes)
	const iendOff = 33;
	view.setUint32(iendOff, 0);
	view.setUint8(iendOff + 4, 0x49);
	view.setUint8(iendOff + 5, 0x45);
	view.setUint8(iendOff + 6, 0x4e);
	view.setUint8(iendOff + 7, 0x44);

	return new Blob([buf], { type: 'image/png' });
}

// Build a minimal JPEG with the given width/height.
function makeJpeg(width: number, height: number): Blob {
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
	view.setUint16(off, 18);
	off += 2;
	off += 16;

	// SOF0 marker
	view.setUint8(off++, 0xff);
	view.setUint8(off++, 0xc0);
	view.setUint16(off, 17);
	off += 2;
	view.setUint8(off++, 8);
	view.setUint16(off, height);
	off += 2;
	view.setUint16(off, width);
	off += 2;
	view.setUint8(off++, 3);
	off += 9;

	// EOI
	view.setUint8(off++, 0xff);
	view.setUint8(off++, 0xd9);

	return new Blob([buf], { type: 'image/jpeg' });
}

// Build a minimal WebP (VP8 lossy) with the given width/height
function makeWebP(width: number, height: number): Blob {
	const riffSize = 4 + 8 + 10;
	const buf = new ArrayBuffer(12 + riffSize);
	const view = new DataView(buf);

	// RIFF header
	view.setUint8(0, 0x52);
	view.setUint8(1, 0x49);
	view.setUint8(2, 0x46);
	view.setUint8(3, 0x46);
	view.setUint32(4, riffSize, true);
	view.setUint8(8, 0x57);
	view.setUint8(9, 0x45);
	view.setUint8(10, 0x42);
	view.setUint8(11, 0x50);

	// VP8 chunk
	const vp8Off = 12;
	view.setUint8(vp8Off, 0x56);
	view.setUint8(vp8Off + 1, 0x50);
	view.setUint8(vp8Off + 2, 0x38);
	view.setUint8(vp8Off + 3, 0x20);
	view.setUint32(vp8Off + 4, 10, true);

	// VP8 bitstream frame tag + sync + dimensions
	const frameOff = vp8Off + 8;
	view.setUint16(frameOff, 0x9d, true);
	view.setUint8(frameOff + 2, 0x01);
	const wEncoded = width & 0x3fff;
	const hEncoded = height & 0x3fff;
	view.setUint16(frameOff + 6, wEncoded, true);
	view.setUint16(frameOff + 8, hEncoded, true);

	return new Blob([buf], { type: 'image/webp' });
}

describe('Bun Admin Routes - Image aspect ratio validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			puzzle: {
				id: 'test-puzzle-id',
				name: 'Test',
				pieceCount: 16,
				gridCols: 4,
				gridRows: 4,
				imageWidth: 400,
				imageHeight: 400,
				createdAt: Date.now(),
				pieces: []
			}
		});
	});

	it('rejects PNG with wrong aspect ratio for requested 3:4', async () => {
		// 300x300 (square) image with aspectRatio=3:4 (portrait)
		const blob = makePng(300, 300);
		const formData = new FormData();
		formData.append('name', 'Mismatched Puzzle');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '3:4');
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzles', { method: 'POST', body: formData });
		const res = await app.fetch(req);

		expect(res.status).toBe(400);
		const body = await res.json();
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

		const req = new Request('http://localhost/puzzles', { method: 'POST', body: formData });
		const res = await app.fetch(req);

		expect(res.status).toBe(201);
	});

	it('accepts PNG with matching 4:3 aspect ratio', async () => {
		const blob = makePng(400, 300);
		const formData = new FormData();
		formData.append('name', 'Landscape Puzzle');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '4:3');
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzles', { method: 'POST', body: formData });
		const res = await app.fetch(req);

		expect(res.status).toBe(201);
	});

	it('rejects JPEG with wrong aspect ratio', async () => {
		// 600x400 = 3:2 ratio, requesting 1:1
		const blob = makeJpeg(600, 400);
		const formData = new FormData();
		formData.append('name', 'Mismatched JPEG');
		formData.append('pieceCount', '16');
		formData.append('aspectRatio', '1:1');
		formData.append('image', blob, 'test.jpg');

		const req = new Request('http://localhost/puzzles', { method: 'POST', body: formData });
		const res = await app.fetch(req);

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.message).toContain('does not match requested ratio');
	});

	it('accepts JPEG with matching aspect ratio', async () => {
		const blob = makeJpeg(800, 600);
		const formData = new FormData();
		formData.append('name', 'Matched JPEG');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '4:3');
		formData.append('image', blob, 'test.jpg');

		const req = new Request('http://localhost/puzzles', { method: 'POST', body: formData });
		const res = await app.fetch(req);

		expect(res.status).toBe(201);
	});

	it('rejects WebP with wrong aspect ratio', async () => {
		const blob = makeWebP(500, 500);
		const formData = new FormData();
		formData.append('name', 'Mismatched WebP');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '3:4');
		formData.append('image', blob, 'test.webp');

		const req = new Request('http://localhost/puzzles', { method: 'POST', body: formData });
		const res = await app.fetch(req);

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.message).toContain('does not match requested ratio');
	});

	it('accepts WebP with matching aspect ratio', async () => {
		const blob = makeWebP(300, 400);
		const formData = new FormData();
		formData.append('name', 'Matched WebP');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '3:4');
		formData.append('image', blob, 'test.webp');

		const req = new Request('http://localhost/puzzles', { method: 'POST', body: formData });
		const res = await app.fetch(req);

		expect(res.status).toBe(201);
	});

	it('accepts image within 5% tolerance for aspect ratio', async () => {
		// 4:3 = 1.333..., 403x300 = 1.343, ~0.8% off — within 5% tolerance
		const blob = makePng(403, 300);
		const formData = new FormData();
		formData.append('name', 'Near Match');
		formData.append('pieceCount', '12');
		formData.append('aspectRatio', '4:3');
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzles', { method: 'POST', body: formData });
		const res = await app.fetch(req);

		expect(res.status).toBe(201);
	});

	it('rejects image well outside 5% tolerance', async () => {
		// 300x200 = 1.5, requesting 1:1 — 50% off
		const blob = makePng(300, 200);
		const formData = new FormData();
		formData.append('name', 'Way Off');
		formData.append('pieceCount', '16');
		formData.append('aspectRatio', '1:1');
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzles', { method: 'POST', body: formData });
		const res = await app.fetch(req);

		expect(res.status).toBe(400);
		const body = await res.json();
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

		const req = new Request('http://localhost/puzzles', { method: 'POST', body: formData });
		const res = await app.fetch(req);

		// Should NOT reject on aspect ratio — proceeds to generation
		expect(res.status).not.toBe(400);
	});
});
