/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Extra coverage tests for admin.ts (Bun runtime).
 * Covers the POST /puzzles success path, storePuzzle returning false,
 * and the overall catch block when generatePuzzle throws.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// Set env vars before any imports so the IIFE in admin.ts resolves correctly.
const originalAdminPasskey = process.env.ADMIN_PASSKEY;
const originalJwtSecret = process.env.JWT_SECRET;
process.env.ADMIN_PASSKEY = 'extra-test-admin-passkey';
process.env.JWT_SECRET = 'extra-test-jwt-secret-for-bun-12345678901234';

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

vi.mock('../../services/storage', () => ({
	createPuzzle: vi.fn().mockResolvedValue(true),
	deletePuzzle: vi.fn().mockResolvedValue(true),
	listPuzzles: vi.fn().mockResolvedValue([]),
	puzzleExists: vi.fn().mockResolvedValue(false)
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
let authMock: any;
let generatorMock: any;

beforeAll(async () => {
	const adminModule = await import('../admin');
	app = adminModule.default;
	storageMock = await import('../../services/storage');
	authMock = await import('../../middleware/auth');
	generatorMock = await import('../../services/puzzle-generator');
});

const mockPuzzleResult = {
	puzzle: {
		id: 'generated-puzzle-id',
		name: 'My Puzzle',
		pieceCount: 25,
		gridCols: 5,
		gridRows: 5,
		imageWidth: 500,
		imageHeight: 500,
		createdAt: Date.now(),
		pieces: []
	}
};

function buildFormData(fields: Record<string, string | Blob>): FormData {
	const fd = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		fd.append(key, value as any);
	}
	return fd;
}

describe('POST /puzzles - success paths', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(storageMock.createPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(mockPuzzleResult);
	});

	it('returns 201 when puzzle is created successfully without category', async () => {
		const fd = buildFormData({
			name: 'My Puzzle',
			pieceCount: '25',
			image: new Blob([new Uint8Array(100)], { type: 'image/png' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);

		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body).toBeDefined();
	});

	it('returns 201 when puzzle is created successfully with a valid category', async () => {
		const fd = buildFormData({
			name: 'Nature Puzzle',
			pieceCount: '25',
			category: 'Nature',
			image: new Blob([new Uint8Array(100)], { type: 'image/jpeg' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);

		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body).toBeDefined();
	});

	it('includes the category in the stored puzzle when provided', async () => {
		const fd = buildFormData({
			name: 'Animal Puzzle',
			pieceCount: '25',
			category: 'Animals',
			image: new Blob([new Uint8Array(100)], { type: 'image/png' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		await app.fetch(req);

		expect(storageMock.createPuzzle).toHaveBeenCalledWith(
			expect.objectContaining({ category: 'Animals' })
		);
	});
});

describe('POST /login - non-SyntaxError catch block (lines 68-74)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns 500 when createSession throws a generic Error (covers lines 68-70, 74)', async () => {
		(authMock.createSession as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('JWT signing failed')
		);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const req = new Request('http://localhost/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ passkey: 'extra-test-admin-passkey' })
			});
			const res = await app.fetch(req);
			expect(res.status).toBe(500);
			const body = await res.json();
			expect(body.error).toBe('internal_error');
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it('returns 500 when createSession throws a non-Error value (covers line 72)', async () => {
		(authMock.createSession as ReturnType<typeof vi.fn>).mockRejectedValue('string error');
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const req = new Request('http://localhost/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ passkey: 'extra-test-admin-passkey' })
			});
			const res = await app.fetch(req);
			expect(res.status).toBe(500);
			const body = await res.json();
			expect(body.error).toBe('internal_error');
		} finally {
			consoleSpy.mockRestore();
		}
	});
});

describe('POST /puzzles - error paths', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(mockPuzzleResult);
	});

	it('returns 500 when storePuzzle (createPuzzle) returns false', async () => {
		(storageMock.createPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(false);

		const fd = buildFormData({
			name: 'My Puzzle',
			pieceCount: '25',
			image: new Blob([new Uint8Array(100)], { type: 'image/png' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);

		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.error).toBe('internal_error');
		expect(body.message).toContain('Failed to save puzzle metadata');
	});

	it('calls deletePuzzle to clean up when createPuzzle returns false', async () => {
		(storageMock.createPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(false);
		(storageMock.deletePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(true);

		const fd = buildFormData({
			name: 'My Puzzle',
			pieceCount: '25',
			image: new Blob([new Uint8Array(100)], { type: 'image/png' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		await app.fetch(req);

		expect(storageMock.deletePuzzle).toHaveBeenCalled();
	});

	it('returns 500 when generatePuzzle throws an error', async () => {
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('Image processing failed')
		);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const fd = buildFormData({
				name: 'My Puzzle',
				pieceCount: '25',
				image: new Blob([new Uint8Array(100)], { type: 'image/png' })
			});
			const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
			const res = await app.fetch(req);

			expect(res.status).toBe(500);
			const body = await res.json();
			expect(body.error).toBe('internal_error');
			expect(body.message).toContain('Failed to create puzzle');
		} finally {
			consoleSpy.mockRestore();
		}
	});
});
