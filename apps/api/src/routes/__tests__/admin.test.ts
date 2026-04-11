/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// admin.ts reads ADMIN_PASSKEY at module-load time via an IIFE.
// Set required env vars before the dynamic import in beforeAll.
const originalAdminPasskey = process.env.ADMIN_PASSKEY;
const originalJwtSecret = process.env.JWT_SECRET;
process.env.ADMIN_PASSKEY = 'test-admin-passkey-for-bun';
process.env.JWT_SECRET = 'test-jwt-secret-for-bun-admin-testing-12345';

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);

// Mock all dependencies before admin.ts is imported (vi.mock is hoisted)
vi.mock('../../middleware/auth', () => ({
	createSession: vi.fn().mockResolvedValue('mock-session-token'),
	setSessionCookie: vi.fn(),
	clearSessionCookie: vi.fn(),
	getSessionToken: vi.fn().mockReturnValue(null),
	verifySession: vi.fn().mockResolvedValue(null),
	requireAuth: vi.fn().mockImplementation(async (_c: any, next: any) => next())
}));

// Mock rate-limit to prevent the module-level loginAttempts Map from accumulating
// state across tests and to avoid the setInterval timer that leaks into other tests.
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
let authMock: any;
let generatorMock: any;

beforeAll(async () => {
	const adminModule = await import('../admin');
	app = adminModule.default;
	storageMock = await import('../../services/storage');
	authMock = await import('../../middleware/auth');
	generatorMock = await import('../../services/puzzle-generator');
});

// ─── POST /login ──────────────────────────────────────────────────────────────

describe('POST /login', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(authMock.createSession as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
	});

	it('returns 400 when passkey field is missing', async () => {
		const req = new Request('http://localhost/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({})
		});
		const res = await app.fetch(req);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
		expect(body.message).toContain('Passkey is required');
	});

	it('returns 401 when passkey is wrong', async () => {
		const req = new Request('http://localhost/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ passkey: 'wrong-passkey' })
		});
		const res = await app.fetch(req);
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error).toBe('unauthorized');
	});

	it('returns 200 with success=true when correct passkey is provided', async () => {
		const req = new Request('http://localhost/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ passkey: 'test-admin-passkey-for-bun' })
		});
		const res = await app.fetch(req);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
	});

	it('calls createSession and setSessionCookie on successful login', async () => {
		const req = new Request('http://localhost/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ passkey: 'test-admin-passkey-for-bun' })
		});
		await app.fetch(req);
		expect(authMock.createSession).toHaveBeenCalledWith({
			userId: 'admin',
			username: 'admin',
			role: 'admin'
		});
		expect(authMock.setSessionCookie).toHaveBeenCalled();
	});

	it('returns 400 for malformed JSON body', async () => {
		const req = new Request('http://localhost/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{invalid-json'
		});
		const res = await app.fetch(req);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
	});
});

// ─── POST /logout ─────────────────────────────────────────────────────────────

describe('POST /logout', () => {
	it('returns 200 with success=true', async () => {
		const req = new Request('http://localhost/logout', { method: 'POST' });
		const res = await app.fetch(req);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
	});

	it('calls clearSessionCookie', async () => {
		vi.clearAllMocks();
		const req = new Request('http://localhost/logout', { method: 'POST' });
		await app.fetch(req);
		expect(authMock.clearSessionCookie).toHaveBeenCalled();
	});
});

// ─── GET /session ─────────────────────────────────────────────────────────────

describe('GET /session', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns authenticated=false when no session token', async () => {
		(authMock.getSessionToken as ReturnType<typeof vi.fn>).mockReturnValue(null);

		const req = new Request('http://localhost/session');
		const res = await app.fetch(req);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.authenticated).toBe(false);
	});

	it('returns authenticated=true when session is valid', async () => {
		(authMock.getSessionToken as ReturnType<typeof vi.fn>).mockReturnValue('valid-token');
		(authMock.verifySession as ReturnType<typeof vi.fn>).mockResolvedValue({
			userId: 'admin',
			role: 'admin'
		});

		const req = new Request('http://localhost/session');
		const res = await app.fetch(req);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.authenticated).toBe(true);
	});

	it('returns authenticated=false and clears cookie when session is invalid', async () => {
		(authMock.getSessionToken as ReturnType<typeof vi.fn>).mockReturnValue('bad-token');
		(authMock.verifySession as ReturnType<typeof vi.fn>).mockResolvedValue(null);

		const req = new Request('http://localhost/session');
		const res = await app.fetch(req);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.authenticated).toBe(false);
		expect(authMock.clearSessionCookie).toHaveBeenCalled();
	});
});

// ─── GET /puzzles ─────────────────────────────────────────────────────────────

describe('GET /puzzles', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns list of puzzles', async () => {
		const mockPuzzles = [
			{ id: 'abc', name: 'Test Puzzle', pieceCount: 25 },
			{ id: 'def', name: 'Another Puzzle', pieceCount: 16 }
		];
		(storageMock.listPuzzles as ReturnType<typeof vi.fn>).mockResolvedValue(mockPuzzles);

		const req = new Request('http://localhost/puzzles');
		const res = await app.fetch(req);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.puzzles).toEqual(mockPuzzles);
	});

	it('returns empty array when no puzzles exist', async () => {
		(storageMock.listPuzzles as ReturnType<typeof vi.fn>).mockResolvedValue([]);

		const req = new Request('http://localhost/puzzles');
		const res = await app.fetch(req);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.puzzles).toEqual([]);
	});

	it('returns 500 when storage throws', async () => {
		(storageMock.listPuzzles as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('Disk error')
		);

		const req = new Request('http://localhost/puzzles');
		const res = await app.fetch(req);
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.error).toBe('internal_error');
	});
});

// ─── POST /puzzles ────────────────────────────────────────────────────────────

describe('POST /puzzles', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(storageMock.createPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			puzzle: {
				id: 'new-puzzle-id',
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

	function buildFormData(fields: Record<string, string | Blob>): FormData {
		const fd = new FormData();
		for (const [key, value] of Object.entries(fields)) {
			if (value instanceof Blob) {
				fd.append(key, value);
			} else {
				fd.append(key, value);
			}
		}
		return fd;
	}

	it('returns 400 when name is missing', async () => {
		const fd = buildFormData({
			pieceCount: '25',
			image: new Blob([PNG_HEADER], { type: 'image/png' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
		expect(body.message).toContain('Name is required');
	});

	it('returns 400 when pieceCount is missing', async () => {
		const fd = buildFormData({
			name: 'Test Puzzle',
			image: new Blob([PNG_HEADER], { type: 'image/png' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
		expect(body.message).toContain('Piece count is required');
	});

	it('returns 400 when pieceCount is invalid', async () => {
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(false);
		const fd = buildFormData({
			name: 'Test Puzzle',
			pieceCount: '7',
			image: new Blob([PNG_HEADER], { type: 'image/png' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
		expect(body.message).toContain('Invalid piece count');
	});

	it('returns 400 when image is missing', async () => {
		const fd = buildFormData({ name: 'Test Puzzle', pieceCount: '25' });
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
		expect(body.message).toContain('Image file is required');
	});

	it('returns 400 when image exceeds 10MB', async () => {
		const largeBuf = new Uint8Array(11 * 1024 * 1024);
		largeBuf.set([0xff, 0xd8, 0xff, 0xe0], 0);
		const largeBlob = new Blob([largeBuf], { type: 'image/jpeg' });
		const fd = buildFormData({ name: 'Test Puzzle', pieceCount: '25', image: largeBlob });
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
		expect(body.message).toContain('10MB');
	});

	it('returns 400 for invalid MIME type', async () => {
		const fd = buildFormData({
			name: 'Test Puzzle',
			pieceCount: '25',
			image: new Blob(['data'], { type: 'image/gif' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
		expect(body.message).toContain('Invalid file type');
	});

	it('returns 400 when file content does not match any known image format', async () => {
		const fd = buildFormData({
			name: 'Test Puzzle',
			pieceCount: '25',
			image: new Blob([new Uint8Array(100)], { type: 'image/png' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
		expect(body.message).toContain('Invalid file type');
	});

	it('returns 400 for invalid category', async () => {
		const fd = buildFormData({
			name: 'Test Puzzle',
			pieceCount: '25',
			category: 'InvalidCategory',
			image: new Blob([PNG_HEADER], { type: 'image/png' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
		expect(body.message).toContain('Invalid category');
	});

	it('returns 400 when name exceeds 255 characters', async () => {
		const longName = 'a'.repeat(256);
		const fd = buildFormData({
			name: longName,
			pieceCount: '25',
			image: new Blob([PNG_HEADER], { type: 'image/png' })
		});
		const req = new Request('http://localhost/puzzles', { method: 'POST', body: fd });
		const res = await app.fetch(req);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
		expect(body.message).toContain('255');
	});

	it('cleans up puzzle directory when generatePuzzle throws', async () => {
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('Generation failed')
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
			const body = await res.json();
			expect(body.error).toBe('internal_error');
			expect(storageMock.deletePuzzle).toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
	});
});

// ─── DELETE /puzzles/:id ──────────────────────────────────────────────────────

describe('DELETE /puzzles/:id', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns 404 when puzzle does not exist', async () => {
		(storageMock.puzzleExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

		const req = new Request('http://localhost/puzzles/nonexistent-id', { method: 'DELETE' });
		const res = await app.fetch(req);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe('not_found');
	});

	it('returns 204 when puzzle is successfully deleted', async () => {
		(storageMock.puzzleExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		(storageMock.deletePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(true);

		const req = new Request('http://localhost/puzzles/existing-puzzle-id', { method: 'DELETE' });
		const res = await app.fetch(req);
		expect(res.status).toBe(204);
	});

	it('returns 500 when deletion fails', async () => {
		(storageMock.puzzleExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		(storageMock.deletePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(false);

		const req = new Request('http://localhost/puzzles/puzzle-id', { method: 'DELETE' });
		const res = await app.fetch(req);
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.error).toBe('internal_error');
	});
});
