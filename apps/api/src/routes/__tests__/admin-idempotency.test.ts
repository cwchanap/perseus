/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage tests for the server-side idempotency flow in admin.ts (Bun runtime).
 *
 * Covers the POST /puzzles Idempotency-Key reservation/commit/release paths
 * (lines ~314-374, 398-501) and the DELETE /puzzles/:id reservation-release
 * paths (lines ~521-555), including the cleanup-failed "stuck on disk"
 * branches that mirror the Worker's failReservation() semantics.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// Set env vars before any imports so the IIFE in admin.ts resolves correctly.
const originalAdminPasskey = process.env.ADMIN_PASSKEY;
const originalJwtSecret = process.env.JWT_SECRET;
process.env.ADMIN_PASSKEY = 'idempotency-test-admin-passkey';
process.env.JWT_SECRET = 'idempotency-test-jwt-secret-for-bun-1234567890';

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
	getPuzzle: vi.fn().mockResolvedValue(null),
	getPuzzleDir: vi.fn().mockReturnValue('/fake/data/puzzles/test-id'),
	getOriginalImagePath: vi.fn().mockReturnValue('/fake/data/puzzles/test-id/original.png'),
	reserveIdempotencyKey: vi.fn(),
	releaseIdempotencyKey: vi.fn().mockResolvedValue(undefined),
	findPuzzleByIdempotencyKey: vi.fn().mockResolvedValue(null)
}));

vi.mock('../../db', () => ({
	getDb: vi.fn(() => ({}))
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const original = await importOriginal<typeof import('@perseus/shared')>();
	return {
		...original,
		insertPuzzleOwnership: vi.fn().mockResolvedValue(undefined),
		deletePuzzleOwnership: vi.fn().mockResolvedValue(undefined),
		deletePuzzleStats: vi.fn().mockResolvedValue(undefined),
		SYSTEM_OWNER_ID: 'system'
	};
});

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

function postPuzzlesRequest(headers: Record<string, string> = {}): Request {
	const fd = buildFormData({
		name: 'My Puzzle',
		pieceCount: '25',
		image: new Blob([PNG_HEADER], { type: 'image/png' })
	});
	return new Request('http://localhost/puzzles', { method: 'POST', body: fd, headers });
}

describe('POST /puzzles - Idempotency-Key validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(mockPuzzleResult);
		(storageMock.createPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(true);
	});

	// Note: the empty/whitespace-only Idempotency-Key branch (trimmed.length === 0)
	// is defensive dead code via HTTP — fetch Headers strips leading/trailing OWS to
	// an empty value, which is falsy and skips the idempotency block entirely. The
	// over-long and invalid-character cases below exercise the 400 validation branch.

	it('rejects an over-long Idempotency-Key with 400', async () => {
		const res = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'x'.repeat(129) }));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
	});

	it('rejects an Idempotency-Key with invalid characters with 400', async () => {
		const res = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'bad key!' }));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('bad_request');
	});
});

describe('POST /puzzles - Idempotency-Key reservation existing branch', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(mockPuzzleResult);
		(storageMock.createPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(true);
	});

	it('returns 200 with the existing puzzle when reservation maps to a live puzzle', async () => {
		const existingPuzzle = {
			id: 'prior-id',
			name: 'Prior',
			pieceCount: 25,
			idempotencyKey: 'key-1'
		};
		(storageMock.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
			existing: true,
			puzzleId: 'prior-id'
		});
		(storageMock.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(existingPuzzle);

		const res = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'key-1' }));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.id).toBe('prior-id');
		// Must not mint a new puzzle
		expect(storageMock.createPuzzle).not.toHaveBeenCalled();
	});

	it('returns 409 when reservation exists but metadata is missing (in-flight/orphan)', async () => {
		(storageMock.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
			existing: true,
			puzzleId: 'ghost-id'
		});
		(storageMock.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(null);

		const res = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'key-2' }));
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.error).toBe('conflict');
		expect(storageMock.createPuzzle).not.toHaveBeenCalled();
	});

	it('returns 409 when reservation maps to a missing puzzle (in-flight or orphan)', async () => {
		// The Bun filesystem reservation has no lifecycle status or TTL, so
		// "in-flight" and "orphaned" are indistinguishable. Reclaiming is
		// unsafe — a concurrent in-flight create would be released and both
		// requests would mint separate puzzles under one Idempotency-Key.
		// Return 409 so the client retries; a truly orphaned reservation is
		// left for the dev to manually remove from the idempotency directory.
		(storageMock.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
			existing: true,
			puzzleId: 'deleted-id'
		});
		(storageMock.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(null);

		const res = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'key-reclaim' }));
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.error).toBe('conflict');
		// Must NOT release or re-reserve — both could mint duplicates under
		// a concurrent in-flight create.
		expect(storageMock.releaseIdempotencyKey).not.toHaveBeenCalled();
		expect(storageMock.createPuzzle).not.toHaveBeenCalled();
	});
});

describe('POST /puzzles - Idempotency-Key reserve failure', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
	});

	it('returns 500 when reserveIdempotencyKey throws', async () => {
		(storageMock.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('reservation write failed')
		);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const res = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'key-3' }));
			expect(res.status).toBe(500);
			const body = await res.json();
			expect(body.error).toBe('internal_error');
			expect(body.message).toContain('Failed to reserve idempotency key');
		} finally {
			consoleSpy.mockRestore();
		}
	});
});

describe('POST /puzzles - reservation commit/release on storePuzzle failure', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(mockPuzzleResult);
		(storageMock.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
			existing: false,
			puzzleId: 'new-id'
		});
		(storageMock.createPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(false);
	});

	it('releases the reservation and returns 500 when cleanup succeeds', async () => {
		(storageMock.deletePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const res = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'key-4' }));
			expect(res.status).toBe(500);
			const body = await res.json();
			expect(body.error).toBe('internal_error');
			expect(body.message).toContain('Failed to save puzzle metadata');
			expect(storageMock.releaseIdempotencyKey).toHaveBeenCalledWith('key-4', 'new-id');
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it('keeps the reservation and returns "stuck on disk" 500 when cleanup fails', async () => {
		(storageMock.deletePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(false);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const res = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'key-5' }));
			expect(res.status).toBe(500);
			const body = await res.json();
			expect(body.error).toBe('internal_error');
			expect(body.message).toContain('stuck on disk');
			// Reservation must NOT be released so a same-key retry sees the orphan
			expect(storageMock.releaseIdempotencyKey).not.toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it('logs and still returns 500 when releaseIdempotencyKey throws after cleanup', async () => {
		(storageMock.deletePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		(storageMock.releaseIdempotencyKey as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('release IO error')
		);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const res = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'key-6' }));
			expect(res.status).toBe(500);
			expect(storageMock.releaseIdempotencyKey).toHaveBeenCalledWith('key-6', 'new-id');
		} finally {
			consoleSpy.mockRestore();
		}
	});
});

describe('POST /puzzles - reservation release in outer catch (generatePuzzle throws)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('Image processing failed')
		);
		(storageMock.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
			existing: false,
			puzzleId: 'new-id'
		});
	});

	it('releases the reservation and returns 500 when cleanup succeeds', async () => {
		(storageMock.deletePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const res = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'key-7' }));
			expect(res.status).toBe(500);
			const body = await res.json();
			expect(body.error).toBe('internal_error');
			expect(body.message).toContain('Failed to create puzzle');
			expect(storageMock.releaseIdempotencyKey).toHaveBeenCalledWith('key-7', 'new-id');
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it('returns "stuck on disk" 500 and keeps the reservation when cleanup fails', async () => {
		(storageMock.deletePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(false);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const res = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'key-8' }));
			expect(res.status).toBe(500);
			const body = await res.json();
			expect(body.message).toContain('stuck on disk');
			expect(storageMock.releaseIdempotencyKey).not.toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it('returns "stuck on disk" 500 when deleteStoredPuzzle throws in the catch block', async () => {
		(storageMock.deletePuzzle as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('unexpected delete throw')
		);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const res = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'key-9' }));
			expect(res.status).toBe(500);
			const body = await res.json();
			expect(body.message).toContain('stuck on disk');
			expect(storageMock.releaseIdempotencyKey).not.toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
	});
});

describe('DELETE /puzzles/:id - idempotency reservation release', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(storageMock.deletePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		(storageMock.releaseIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
	});

	it('releases the reservation when the deleted puzzle has an idempotencyKey', async () => {
		(storageMock.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: 'del-id',
			name: 'Del',
			pieceCount: 25,
			idempotencyKey: 'del-key'
		});

		const req = new Request('http://localhost/puzzles/del-id', { method: 'DELETE' });
		const res = await app.fetch(req);
		expect(res.status).toBe(204);
		expect(storageMock.deletePuzzle).toHaveBeenCalledWith('del-id');
		expect(storageMock.releaseIdempotencyKey).toHaveBeenCalledWith('del-key', 'del-id');
	});

	it('logs and still returns 204 when releaseIdempotencyKey throws', async () => {
		(storageMock.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: 'del-id',
			name: 'Del',
			pieceCount: 25,
			idempotencyKey: 'del-key'
		});
		(storageMock.releaseIdempotencyKey as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('release failed')
		);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const req = new Request('http://localhost/puzzles/del-id', { method: 'DELETE' });
			const res = await app.fetch(req);
			expect(res.status).toBe(204);
			expect(storageMock.releaseIdempotencyKey).toHaveBeenCalledWith('del-key', 'del-id');
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it('skips release when metadata is corrupt (getPuzzle throws) but the puzzle exists', async () => {
		(storageMock.getPuzzle as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('corrupt metadata')
		);
		(storageMock.puzzleExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const req = new Request('http://localhost/puzzles/corrupt-id', { method: 'DELETE' });
			const res = await app.fetch(req);
			expect(res.status).toBe(204);
			expect(storageMock.deletePuzzle).toHaveBeenCalledWith('corrupt-id');
			// No key available → release must be skipped
			expect(storageMock.releaseIdempotencyKey).not.toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it('returns 404 when metadata is corrupt and the puzzle does not exist', async () => {
		(storageMock.getPuzzle as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('corrupt metadata')
		);
		(storageMock.puzzleExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const req = new Request('http://localhost/puzzles/missing-id', { method: 'DELETE' });
			const res = await app.fetch(req);
			expect(res.status).toBe(404);
			expect(storageMock.deletePuzzle).not.toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it('skips release when the puzzle has no idempotencyKey', async () => {
		(storageMock.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: 'plain-id',
			name: 'Plain',
			pieceCount: 25
		});
		const req = new Request('http://localhost/puzzles/plain-id', { method: 'DELETE' });
		const res = await app.fetch(req);
		expect(res.status).toBe(204);
		expect(storageMock.releaseIdempotencyKey).not.toHaveBeenCalled();
	});
});
