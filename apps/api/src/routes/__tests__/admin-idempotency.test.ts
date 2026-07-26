/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage tests for the server-side idempotency flow in admin.ts (Bun runtime).
 *
 * Covers the POST /puzzles Idempotency-Key reservation/commit/release paths
 * (lines ~314-374, 398-501) and the DELETE /puzzles/:id reservation-release
 * paths (lines ~521-555), including the cleanup-failed "stuck on disk"
 * branches that mirror the Worker's failReservation() semantics.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// Set env vars before any imports so the IIFE in admin.ts resolves correctly.
const originalAdminPasskey = process.env.ADMIN_PASSKEY;
const originalJwtSecret = process.env.JWT_SECRET;
process.env.ADMIN_PASSKEY = 'idempotency-test-admin-passkey';
process.env.JWT_SECRET = 'idempotency-test-jwt-secret-for-bun-1234567890';

const PNG_HEADER = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00
]);

const dbContextMock = vi.hoisted(() => ({
	db: {},
	completionWrites: {
		isPuzzleTombstoned: vi.fn().mockResolvedValue(false),
		beginPuzzleDeletion: vi.fn().mockResolvedValue(undefined),
		finishPuzzleDeletion: vi.fn().mockResolvedValue(undefined)
	}
}));

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
	getDb: vi.fn(() => dbContextMock.db),
	getDbContext: vi.fn(() => dbContextMock)
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const original = await importOriginal<typeof import('@perseus/shared')>();
	return {
		...original,
		validateImageEndMarker: vi.fn().mockResolvedValue(true),
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

describe('POST /puzzles - Idempotency-Key reservation tombstone-aware reclaim', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(mockPuzzleResult);
		(storageMock.createPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		dbContextMock.completionWrites.isPuzzleTombstoned.mockResolvedValue(false);
	});
	afterEach(() => {
		// Reset mocks whose base implementations this block mutates back
		// to their hoisted defaults, so later describe blocks start clean.
		storageMock.reserveIdempotencyKey.mockReset();
		storageMock.getPuzzle.mockReset();
		storageMock.getPuzzle.mockResolvedValue(null);
		dbContextMock.completionWrites.isPuzzleTombstoned.mockReset();
		dbContextMock.completionWrites.isPuzzleTombstoned.mockResolvedValue(false);
	});

	it('returns 409 (not 200) when the reserved puzzle is on disk but tombstoned (deletion in progress)', async () => {
		// Closes the same-key create-vs-delete race: the delete route
		// tombstones before releasing, so a concurrent create that reads
		// the still-present puzzle must NOT acknowledge it as 200.
		const tombstonedPuzzle = {
			id: 'dying-id',
			name: 'Dying',
			pieceCount: 25,
			idempotencyKey: 'key-dying'
		};
		(storageMock.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
			existing: true,
			puzzleId: 'dying-id'
		});
		(storageMock.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(tombstonedPuzzle);
		// First isPuzzleTombstoned call is the fresh-UUID allocation check
		// (must pass false so creation proceeds); subsequent calls are the
		// existing-reservation tombstone check (must return true).
		dbContextMock.completionWrites.isPuzzleTombstoned
			.mockResolvedValueOnce(false)
			.mockResolvedValue(true);

		const res = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'key-dying' }));
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.error).toBe('conflict');
		// Must not acknowledge the dying puzzle, must not mint a new one.
		expect(storageMock.createPuzzle).not.toHaveBeenCalled();
		expect(storageMock.releaseIdempotencyKey).not.toHaveBeenCalled();
	});

	it('reclaims a stale reservation when the reserved puzzle is missing and tombstoned', async () => {
		// Delete completed but the reservation release failed: the
		// tombstone distinguishes this from an in-flight create, so it is
		// safe to owner-check-release and re-reserve with our UUID.
		(storageMock.reserveIdempotencyKey as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ existing: true, puzzleId: 'dead-id' })
			.mockResolvedValueOnce({ existing: false, puzzleId: 'new-uuid' });
		(storageMock.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		dbContextMock.completionWrites.isPuzzleTombstoned
			.mockResolvedValueOnce(false) // fresh-UUID allocation check
			.mockResolvedValue(true); // reserved puzzle is tombstoned -> reclaim

		const res = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'key-dead' }));
		expect(res.status).toBe(201);
		expect(storageMock.releaseIdempotencyKey).toHaveBeenCalledWith('key-dead', 'dead-id');
		// Re-reserve won, then create ran.
		expect(storageMock.createPuzzle).toHaveBeenCalled();
	});

	it('returns 409 when a concurrent winner reclaimed the stale reservation first and is tombstoned', async () => {
		(storageMock.reserveIdempotencyKey as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ existing: true, puzzleId: 'dead-id' })
			// Re-reserve loses to a concurrent winner that is also tombstoned.
			.mockResolvedValueOnce({ existing: true, puzzleId: 'other-dead-id' });
		(storageMock.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		dbContextMock.completionWrites.isPuzzleTombstoned
			.mockResolvedValueOnce(false) // fresh-UUID allocation check
			.mockResolvedValue(true); // both dead-id and other-dead-id tombstoned

		const res = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'key-dead' }));
		expect(res.status).toBe(409);
		expect(storageMock.releaseIdempotencyKey).toHaveBeenCalledWith('key-dead', 'dead-id');
		expect(storageMock.createPuzzle).not.toHaveBeenCalled();
	});

	it('returns 200 when a concurrent winner reclaimed and committed a live puzzle', async () => {
		const winnerPuzzle = {
			id: 'winner-id',
			name: 'Winner',
			pieceCount: 25,
			idempotencyKey: 'key-dead'
		};
		(storageMock.reserveIdempotencyKey as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ existing: true, puzzleId: 'dead-id' })
			.mockResolvedValueOnce({ existing: true, puzzleId: 'winner-id' });
		// First getPuzzle (for dead-id) returns null; second (for winner) returns live.
		(storageMock.getPuzzle as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(winnerPuzzle);
		dbContextMock.completionWrites.isPuzzleTombstoned
			.mockResolvedValueOnce(false) // fresh-UUID allocation check
			.mockResolvedValueOnce(true) // dead-id is tombstoned -> reclaim
			.mockResolvedValueOnce(false); // winner-id is live -> acknowledge

		const res = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'key-dead' }));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.id).toBe('winner-id');
		expect(storageMock.createPuzzle).not.toHaveBeenCalled();
	});

	it('returns 409 when the tombstone check itself errors (fail closed)', async () => {
		(storageMock.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
			existing: true,
			puzzleId: 'maybe-dead-id'
		});
		(storageMock.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: 'maybe-dead-id',
			name: 'Maybe',
			pieceCount: 25
		});
		// First isPuzzleTombstoned call is the fresh-UUID allocation check
		// (must pass false so creation proceeds to the reservation); the
		// second call is the existing-reservation tombstone check, which
		// fails closed with a D1 error.
		dbContextMock.completionWrites.isPuzzleTombstoned
			.mockResolvedValueOnce(false)
			.mockRejectedValue(new Error('D1 down'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const res = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'key-maybe' }));
			expect(res.status).toBe(409);
			expect(storageMock.createPuzzle).not.toHaveBeenCalled();
		} finally {
			consoleSpy.mockRestore();
		}
	});
});

describe('delete-vs-create same-key concurrency (barrier-controlled)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(generatorMock.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(generatorMock.generatePuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(mockPuzzleResult);
		(storageMock.createPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		(storageMock.releaseIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		dbContextMock.completionWrites.isPuzzleTombstoned.mockResolvedValue(false);
		dbContextMock.completionWrites.beginPuzzleDeletion.mockResolvedValue(undefined);
		dbContextMock.completionWrites.finishPuzzleDeletion.mockResolvedValue(undefined);
	});
	afterEach(() => {
		storageMock.reserveIdempotencyKey.mockReset();
		storageMock.getPuzzle.mockReset();
		storageMock.getPuzzle.mockResolvedValue(null);
		storageMock.deletePuzzle.mockReset();
		storageMock.deletePuzzle.mockResolvedValue(true);
		dbContextMock.completionWrites.isPuzzleTombstoned.mockReset();
		dbContextMock.completionWrites.isPuzzleTombstoned.mockResolvedValue(false);
		dbContextMock.completionWrites.beginPuzzleDeletion.mockReset();
		dbContextMock.completionWrites.beginPuzzleDeletion.mockResolvedValue(undefined);
		dbContextMock.completionWrites.finishPuzzleDeletion.mockReset();
		dbContextMock.completionWrites.finishPuzzleDeletion.mockResolvedValue(undefined);
	});

	it('a concurrent same-key create returns 409 (not 200) while a delete holds the reservation and has tombstoned', async () => {
		// Race under test (the one the P1 fix closes):
		//   delete: read meta -> tombstone -> [deleteSource gated] -> release
		//   create: reserve -> getPuzzle (still on disk) -> isPuzzleTombstoned
		// Before the fix, the delete released the reservation BEFORE
		// tombstoning, so the create re-reserved against the still-present
		// puzzle via the legacy metadata fallback and returned 200 for a
		// puzzle about to disappear. After the fix, the reservation stays
		// owned through deletion and the tombstone makes the create return
		// 409 instead of acknowledging the dying puzzle.
		const dyingPuzzle = {
			id: 'race-id',
			name: 'Race',
			pieceCount: 25,
			idempotencyKey: 'race-key'
		};
		// Delete reads the puzzle metadata.
		(storageMock.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(dyingPuzzle);
		// Reservation stays owned (reserve returns existing:true for the
		// concurrent create).
		(storageMock.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
			existing: true,
			puzzleId: 'race-id'
		});
		// Barrier: deleteSource blocks until the create has observed the
		// tombstoned reservation.
		let releaseDeleteSource!: () => void;
		const deleteSourceBarrier = new Promise<void>((resolve) => {
			releaseDeleteSource = resolve;
		});
		(storageMock.deletePuzzle as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			await deleteSourceBarrier;
			return true;
		});
		// Tombstone is inserted before deleteSource, so the create's
		// isPuzzleTombstoned check sees it. First call is the create's
		// fresh-UUID allocation check (false); second is the existing-
		// reservation check (true).
		dbContextMock.completionWrites.isPuzzleTombstoned
			.mockResolvedValueOnce(false)
			.mockResolvedValue(true);

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			// Start the delete; it tombstones then parks at deleteSource.
			const deleteResPromise = app.fetch(
				new Request('http://localhost/puzzle-delete/race-id', { method: 'POST' })
			);
			// Let the delete reach the gated deleteSource. A microtask
			// flush isn't enough because beginPuzzleDeletion is async; poll
			// until beginPuzzleDeletion has been called.
			await vi.waitFor(() =>
				expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
					'race-id',
					expect.any(Number)
				)
			);
			// Also wait until deletePuzzle (the gated call) has been
			// invoked, so the delete is genuinely parked inside it.
			await vi.waitFor(() => expect(storageMock.deletePuzzle).toHaveBeenCalledWith('race-id'));

			// Now fire the concurrent create with the same key. The
			// reservation still maps to race-id and the puzzle is still on
			// disk, but the tombstone is in place.
			const createRes = await app.fetch(postPuzzlesRequest({ 'Idempotency-Key': 'race-key' }));
			expect(createRes.status).toBe(409);
			const body = await createRes.json();
			expect(body.error).toBe('conflict');
			// The create must not mint a replacement or acknowledge the
			// dying puzzle, and must not release the delete's reservation.
			expect(storageMock.createPuzzle).not.toHaveBeenCalled();
			expect(storageMock.releaseIdempotencyKey).not.toHaveBeenCalledWith('race-key', 'race-id');

			// Release the delete; it completes and releases its reservation.
			releaseDeleteSource();
			const deleteRes = await deleteResPromise;
			expect(deleteRes.status).toBe(204);
			// Delete released its own reservation after source deletion.
			expect(storageMock.releaseIdempotencyKey).toHaveBeenCalledWith('race-key', 'race-id');
			expect(dbContextMock.completionWrites.finishPuzzleDeletion).toHaveBeenCalledWith('race-id');
		} finally {
			// Safety net: if an assertion above threw before the explicit
			// release, unblock the gated delete so deleteResPromise doesn't
			// hang. Promise resolve is idempotent — a no-op if already called.
			releaseDeleteSource();
			consoleSpy.mockRestore();
		}
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
		dbContextMock.completionWrites.isPuzzleTombstoned.mockResolvedValue(false);
		dbContextMock.completionWrites.beginPuzzleDeletion.mockResolvedValue(undefined);
		dbContextMock.completionWrites.finishPuzzleDeletion.mockResolvedValue(undefined);
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

		const req = new Request('http://localhost/puzzle-delete/del-id', { method: 'POST' });
		const res = await app.fetch(req);
		expect(res.status).toBe(204);
		expect(storageMock.deletePuzzle).toHaveBeenCalledWith('del-id');
		expect(storageMock.releaseIdempotencyKey).toHaveBeenCalledWith('del-key', 'del-id');
		// Release happens AFTER source deletion so the reservation stays
		// owned throughout deletion (closes the same-key create race).
		expect(storageMock.deletePuzzle).toHaveBeenCalledBefore(storageMock.releaseIdempotencyKey);
	});

	it('releases the reservation before a failed finish and resumes deletion on retry', async () => {
		let reservationPuzzleId: string | undefined = 'del-id';
		(storageMock.getPuzzle as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				id: 'del-id',
				name: 'Del',
				pieceCount: 25,
				idempotencyKey: 'del-key'
			})
			.mockResolvedValueOnce(null);
		(storageMock.puzzleExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
		(storageMock.releaseIdempotencyKey as ReturnType<typeof vi.fn>).mockImplementation(
			async (_key: string, puzzleId: string) => {
				if (reservationPuzzleId === puzzleId) reservationPuzzleId = undefined;
			}
		);
		dbContextMock.completionWrites.finishPuzzleDeletion
			.mockRejectedValueOnce(new Error('finish failed'))
			.mockResolvedValueOnce(undefined);
		dbContextMock.completionWrites.isPuzzleTombstoned.mockResolvedValue(true);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		try {
			const first = await app.fetch(
				new Request('http://localhost/puzzle-delete/del-id', { method: 'POST' })
			);
			const retry = await app.fetch(
				new Request('http://localhost/puzzle-delete/del-id', { method: 'POST' })
			);

			expect(first.status).toBe(500);
			expect(retry.status).toBe(204);
			expect(reservationPuzzleId).toBeUndefined();
			expect(storageMock.releaseIdempotencyKey).toHaveBeenCalledWith('del-key', 'del-id');
			expect(dbContextMock.completionWrites.finishPuzzleDeletion).toHaveBeenCalledTimes(2);
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it('proceeds with deletion when reservation release fails (non-fatal, reclaimable via tombstone)', async () => {
		// Release now happens AFTER source deletion and is non-fatal: the
		// tombstone inserted before source delete lets a future same-key
		// create reclaim the stale reservation, so a failed release must
		// not block or roll back deletion.
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
			const req = new Request('http://localhost/puzzle-delete/del-id', { method: 'POST' });
			const res = await app.fetch(req);
			expect(res.status).toBe(204);
			expect(storageMock.deletePuzzle).toHaveBeenCalledWith('del-id');
			expect(storageMock.releaseIdempotencyKey).toHaveBeenCalledWith('del-key', 'del-id');
			// Tombstone was inserted before source deletion.
			expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
				'del-id',
				expect.any(Number)
			);
			expect(dbContextMock.completionWrites.finishPuzzleDeletion).toHaveBeenCalledWith('del-id');
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
			const req = new Request('http://localhost/puzzle-delete/corrupt-id', { method: 'POST' });
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
			const req = new Request('http://localhost/puzzle-delete/missing-id', { method: 'POST' });
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
		const req = new Request('http://localhost/puzzle-delete/plain-id', { method: 'POST' });
		const res = await app.fetch(req);
		expect(res.status).toBe(204);
		expect(storageMock.releaseIdempotencyKey).not.toHaveBeenCalled();
	});
});
