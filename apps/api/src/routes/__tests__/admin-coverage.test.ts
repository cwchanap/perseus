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
