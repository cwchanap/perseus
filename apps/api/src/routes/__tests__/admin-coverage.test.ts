/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage tests for remaining uncovered lines in admin.ts.
 * Covers: invalid aspect ratio, cleanup failure on save failure,
 * cleanup error in catch block, JPEG marker segment bounds check.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const originalAdminPasskey = process.env.ADMIN_PASSKEY;
const originalJwtSecret = process.env.JWT_SECRET;
process.env.ADMIN_PASSKEY = 'coverage-admin-passkey';
process.env.JWT_SECRET = 'coverage-jwt-secret-for-bun-1234567890123456';

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);

const PNG_500x500 = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x01, 0xf4, 0x00, 0x00, 0x01, 0xf4, 0x08, 0x02, 0x00, 0x00, 0x00
]);

const PNG_400x300 = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x01, 0x90, 0x00, 0x00, 0x01, 0x2c, 0x08, 0x02, 0x00, 0x00, 0x00
]);

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
	getOriginalImagePath: vi.fn().mockReturnValue('/fake/data/puzzles/test-id/original.jpg')
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
let storageMock: any;
let generatorMock: any;

beforeAll(async () => {
	const adminModule = await import('../admin');
	app = adminModule.default;
	storageMock = await import('../../services/storage');
	generatorMock = await import('../../services/puzzle-generator');
});

function buildFormData(fields: Record<string, string | Blob>): FormData {
	const fd = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		fd.append(key, value as any);
	}
	return fd;
}

function makeJpegSof(width: number, height: number): Uint8Array {
	return new Uint8Array([
		0xff,
		0xd8,
		0xff,
		0xc0,
		0x00,
		0x09,
		0x08,
		(height >> 8) & 0xff,
		height & 0xff,
		(width >> 8) & 0xff,
		width & 0xff,
		0x01
	]);
}

function makeJpegWithRst(width: number, height: number): Uint8Array {
	return new Uint8Array([
		0xff,
		0xd8,
		0xff,
		0xd0,
		0xff,
		0xc0,
		0x00,
		0x09,
		0x08,
		(height >> 8) & 0xff,
		height & 0xff,
		(width >> 8) & 0xff,
		width & 0xff,
		0x01,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00
	]);
}

function makeJpegWithApp0(width: number, height: number): Uint8Array {
	return new Uint8Array([
		0xff,
		0xd8,
		0xff,
		0xe0,
		0x00,
		0x05,
		0x00,
		0x00,
		0x00,
		0xff,
		0xc0,
		0x00,
		0x09,
		0x08,
		(height >> 8) & 0xff,
		height & 0xff,
		(width >> 8) & 0xff,
		width & 0xff,
		0x01
	]);
}

function makeWebPVP8(width: number, height: number): Uint8Array {
	const buf = new Uint8Array(34);
	buf[0] = 0x52;
	buf[1] = 0x49;
	buf[2] = 0x46;
	buf[3] = 0x46;
	buf[8] = 0x57;
	buf[9] = 0x45;
	buf[10] = 0x42;
	buf[11] = 0x50;
	buf[12] = 0x56;
	buf[13] = 0x50;
	buf[14] = 0x38;
	buf[15] = 0x20;
	buf[16] = 0x0a;
	buf[17] = 0x00;
	buf[18] = 0x00;
	buf[19] = 0x00;
	buf[23] = 0x9d;
	buf[24] = 0x01;
	buf[25] = 0x2a;
	buf[26] = width & 0xff;
	buf[27] = (width >> 8) & 0xff;
	buf[28] = height & 0xff;
	buf[29] = (height >> 8) & 0xff;
	return buf;
}

function makeWebPVP8L(width: number, height: number): Uint8Array {
	const buf = new Uint8Array(34);
	buf[0] = 0x52;
	buf[1] = 0x49;
	buf[2] = 0x46;
	buf[3] = 0x46;
	buf[8] = 0x57;
	buf[9] = 0x45;
	buf[10] = 0x42;
	buf[11] = 0x50;
	buf[12] = 0x56;
	buf[13] = 0x50;
	buf[14] = 0x38;
	buf[15] = 0x4c;
	buf[16] = 0x0a;
	buf[17] = 0x00;
	buf[18] = 0x00;
	buf[19] = 0x00;
	buf[20] = 0x2f;
	const packed = (width - 1) | ((height - 1) << 14);
	buf[21] = packed & 0xff;
	buf[22] = (packed >> 8) & 0xff;
	buf[23] = (packed >> 16) & 0xff;
	buf[24] = (packed >> 24) & 0xff;
	return buf;
}

function makeWebPVP8X(width: number, height: number): Uint8Array {
	const buf = new Uint8Array(34);
	buf[0] = 0x52;
	buf[1] = 0x49;
	buf[2] = 0x46;
	buf[3] = 0x46;
	buf[8] = 0x57;
	buf[9] = 0x45;
	buf[10] = 0x42;
	buf[11] = 0x50;
	buf[12] = 0x56;
	buf[13] = 0x50;
	buf[14] = 0x38;
	buf[15] = 0x58;
	buf[16] = 0x0a;
	buf[17] = 0x00;
	buf[18] = 0x00;
	buf[19] = 0x00;
	buf[20] = 0x00;
	buf[24] = (width - 1) & 0xff;
	buf[25] = ((width - 1) >> 8) & 0xff;
	buf[26] = ((width - 1) >> 16) & 0xff;
	buf[27] = (height - 1) & 0xff;
	buf[28] = ((height - 1) >> 8) & 0xff;
	buf[29] = ((height - 1) >> 16) & 0xff;
	return buf;
}

const WEBP_UNKNOWN_FOURCC = new Uint8Array([
	0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x58, 0x58, 0x58, 0x58,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00
]);

describe('POST /puzzles - invalid aspect ratio', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
	});

	it('returns 400 when aspectRatio is not a valid ratio string', async () => {
		const fd = buildFormData({
			name: 'Test Puzzle',
			pieceCount: '25',
			aspectRatio: '16:9',
			image: new Blob([PNG_HEADER], { type: 'image/png' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
		expect(body.message).toContain('Invalid aspect ratio');
	});
});

describe('POST /puzzles - cleanup failure on metadata save failure', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			puzzle: {
				id: 'test-puzzle-id',
				name: 'My Puzzle',
				pieceCount: 25,
				gridCols: 5,
				gridRows: 5,
				imageWidth: 500,
				imageHeight: 500,
				createdAt: Date.now(),
				pieces: []
			}
		});
	});

	it('logs error when cleanup also fails after metadata save failure', async () => {
		(storageMock.createPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(false);
		(storageMock.deletePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(false);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		try {
			const fd = buildFormData({
				name: 'Test Puzzle',
				pieceCount: '25',
				image: new Blob([PNG_HEADER], { type: 'image/png' })
			});
			const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
			const res = await app.fetch(req);

			expect(res.status).toBe(500);
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('Failed to clean up puzzle directory')
			);
		} finally {
			consoleSpy.mockRestore();
		}
	});
});

describe('POST /puzzles - cleanup error in outer catch block', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
	});

	it('logs cleanup error when deleteStoredPuzzle throws in catch block', async () => {
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error('Generation exploded');
		});
		(storageMock.deletePuzzle as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('Cleanup also failed')
		);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		try {
			const fd = buildFormData({
				name: 'Test Puzzle',
				pieceCount: '25',
				image: new Blob([PNG_HEADER], { type: 'image/png' })
			});
			const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
			const res = await app.fetch(req);

			expect(res.status).toBe(500);
			expect(consoleSpy).toHaveBeenCalledWith(
				'Failed to clean up puzzle directory after error:',
				expect.any(Error)
			);
		} finally {
			consoleSpy.mockRestore();
		}
	});
});

describe('parseImageDimensions - JPEG branches', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(storageMock.createPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			puzzle: {
				id: 'test-puzzle-id',
				name: 'Test Puzzle',
				pieceCount: 25,
				gridCols: 5,
				gridRows: 5,
				imageWidth: 500,
				imageHeight: 500,
				createdAt: Date.now(),
				pieces: []
			}
		});
	});

	it('parses JPEG SOF0 marker and returns 201 with matching 1:1 ratio', async () => {
		const jpeg = makeJpegSof(500, 500);
		const fd = buildFormData({
			name: 'JPEG Puzzle',
			pieceCount: '25',
			image: new Blob([jpeg], { type: 'image/jpeg' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(201);
	});

	it('skips JPEG RST standalone marker then finds SOF0', async () => {
		const jpeg = makeJpegWithRst(500, 500);
		const fd = buildFormData({
			name: 'JPEG RST Puzzle',
			pieceCount: '25',
			image: new Blob([jpeg], { type: 'image/jpeg' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(201);
	});

	it('skips JPEG APP0 segment marker then finds SOF0', async () => {
		const jpeg = makeJpegWithApp0(500, 500);
		const fd = buildFormData({
			name: 'JPEG APP0 Puzzle',
			pieceCount: '25',
			image: new Blob([jpeg], { type: 'image/jpeg' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(201);
	});

	it('returns null dimensions for JPEG with SOS marker and still succeeds', async () => {
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
		const fd = buildFormData({
			name: 'JPEG SOS Puzzle',
			pieceCount: '25',
			image: new Blob([jpeg], { type: 'image/jpeg' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(201);
	});

	it('returns null dimensions for JPEG with EOI marker', async () => {
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
		const fd = buildFormData({
			name: 'JPEG EOI Puzzle',
			pieceCount: '25',
			image: new Blob([jpeg], { type: 'image/jpeg' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(201);
	});

	it('returns null dimensions for JPEG with SOF segLen less than 9', async () => {
		const jpeg = new Uint8Array([
			0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, 0x01, 0xf4, 0x01, 0xf4, 0x01
		]);
		const fd = buildFormData({
			name: 'JPEG Short SegLen Puzzle',
			pieceCount: '25',
			image: new Blob([jpeg], { type: 'image/jpeg' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(201);
	});

	it('returns null for JPEG with non-FF byte after skipping a marker segment', async () => {
		const jpeg = new Uint8Array([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
			0x00, 0x00, 0x00, 0x00, 0x00
		]);
		const fd = buildFormData({
			name: 'JPEG Bad Marker Puzzle',
			pieceCount: '25',
			image: new Blob([jpeg], { type: 'image/jpeg' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(201);
	});
});

describe('parseImageDimensions - WebP branches', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(storageMock.createPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			puzzle: {
				id: 'test-puzzle-id',
				name: 'Test Puzzle',
				pieceCount: 25,
				gridCols: 5,
				gridRows: 5,
				imageWidth: 500,
				imageHeight: 500,
				createdAt: Date.now(),
				pieces: []
			}
		});
	});

	it('parses WebP VP8 lossy chunk and returns 201 with matching 1:1 ratio', async () => {
		const webp = makeWebPVP8(500, 500);
		const fd = buildFormData({
			name: 'VP8 Puzzle',
			pieceCount: '25',
			image: new Blob([webp], { type: 'image/webp' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(201);
	});

	it('parses WebP VP8L lossless chunk and returns 201 with matching 1:1 ratio', async () => {
		const webp = makeWebPVP8L(500, 500);
		const fd = buildFormData({
			name: 'VP8L Puzzle',
			pieceCount: '25',
			image: new Blob([webp], { type: 'image/webp' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(201);
	});

	it('parses WebP VP8X extended chunk and returns 201 with matching 1:1 ratio', async () => {
		const webp = makeWebPVP8X(500, 500);
		const fd = buildFormData({
			name: 'VP8X Puzzle',
			pieceCount: '25',
			image: new Blob([webp], { type: 'image/webp' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(201);
	});

	it('returns null dimensions for WebP with unknown fourCC and still succeeds', async () => {
		const fd = buildFormData({
			name: 'Unknown WebP Puzzle',
			pieceCount: '25',
			image: new Blob([WEBP_UNKNOWN_FOURCC], { type: 'image/webp' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(201);
	});
});

describe('POST /puzzles - aspect ratio validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(storageMock.createPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			puzzle: {
				id: 'test-puzzle-id',
				name: 'Test Puzzle',
				pieceCount: 25,
				gridCols: 5,
				gridRows: 5,
				imageWidth: 500,
				imageHeight: 500,
				createdAt: Date.now(),
				pieces: []
			}
		});
	});

	it('returns 400 when PNG image ratio does not match requested 1:1', async () => {
		const fd = buildFormData({
			name: 'Mismatched Ratio Puzzle',
			pieceCount: '25',
			aspectRatio: '1:1',
			image: new Blob([PNG_400x300], { type: 'image/png' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
		expect(body.message).toContain('does not match requested ratio');
	});

	it('succeeds when PNG image ratio matches requested 4:3', async () => {
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			puzzle: {
				id: 'test-puzzle-id',
				name: '4:3 Puzzle',
				pieceCount: 48,
				gridCols: 8,
				gridRows: 6,
				imageWidth: 400,
				imageHeight: 300,
				createdAt: Date.now(),
				pieces: []
			}
		});
		const fd = buildFormData({
			name: '4:3 PNG Puzzle',
			pieceCount: '48',
			aspectRatio: '4:3',
			image: new Blob([PNG_400x300], { type: 'image/png' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(201);
	});

	it('succeeds when JPEG image ratio matches requested 4:3', async () => {
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			puzzle: {
				id: 'test-puzzle-id',
				name: '4:3 JPEG Puzzle',
				pieceCount: 48,
				gridCols: 8,
				gridRows: 6,
				imageWidth: 400,
				imageHeight: 300,
				createdAt: Date.now(),
				pieces: []
			}
		});
		const jpeg = makeJpegSof(400, 300);
		const fd = buildFormData({
			name: '4:3 JPEG Puzzle',
			pieceCount: '48',
			aspectRatio: '4:3',
			image: new Blob([jpeg], { type: 'image/jpeg' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(201);
	});

	it('succeeds when WebP VP8 image ratio matches requested 4:3', async () => {
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			puzzle: {
				id: 'test-puzzle-id',
				name: '4:3 WebP Puzzle',
				pieceCount: 48,
				gridCols: 8,
				gridRows: 6,
				imageWidth: 400,
				imageHeight: 300,
				createdAt: Date.now(),
				pieces: []
			}
		});
		const webp = makeWebPVP8(400, 300);
		const fd = buildFormData({
			name: '4:3 VP8 Puzzle',
			pieceCount: '48',
			aspectRatio: '4:3',
			image: new Blob([webp], { type: 'image/webp' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(201);
	});
});

describe('POST /puzzles - default aspect ratio', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(storageMock.createPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			puzzle: {
				id: 'test-puzzle-id',
				name: 'Default Ratio Puzzle',
				pieceCount: 25,
				gridCols: 5,
				gridRows: 5,
				imageWidth: 500,
				imageHeight: 500,
				createdAt: Date.now(),
				pieces: []
			}
		});
	});

	it('defaults to 1:1 when aspectRatio is an empty string', async () => {
		const fd = buildFormData({
			name: 'Default Ratio Puzzle',
			pieceCount: '25',
			aspectRatio: '',
			image: new Blob([PNG_500x500], { type: 'image/png' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(201);
		expect(generatorMock.generatePuzzle).toHaveBeenCalledWith(
			expect.objectContaining({ aspectRatio: '1:1' })
		);
	});

	it('defaults to 1:1 when aspectRatio is not provided', async () => {
		const fd = buildFormData({
			name: 'No Ratio Puzzle',
			pieceCount: '25',
			image: new Blob([PNG_500x500], { type: 'image/png' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(201);
		expect(generatorMock.generatePuzzle).toHaveBeenCalledWith(
			expect.objectContaining({ aspectRatio: '1:1' })
		);
	});
});
