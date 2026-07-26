/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbContextMock = vi.hoisted(() => ({
	db: {},
	completionWrites: {
		write: vi.fn(),
		deletePuzzleCompletionData: vi.fn(async () => undefined),
		finishPuzzleDeletion: vi.fn(async () => undefined),
		isPuzzleTombstoned: vi.fn().mockResolvedValue(false)
	}
}));

// Mock the storage and auth modules before importing admin
vi.mock('../../services/storage.worker', () => ({
	getPuzzle: vi.fn(),
	deletePuzzleAssets: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	createPuzzleMetadata: vi.fn(),
	uploadOriginalImage: vi.fn(),
	deleteOriginalImage: vi.fn(),
	originalImageExists: vi.fn().mockResolvedValue(false),
	puzzleExists: vi.fn().mockResolvedValue(false),
	listPuzzles: vi.fn(),
	reserveIdempotencyKey: vi.fn(),
	commitIdempotencyKey: vi.fn(),
	failIdempotencyKey: vi.fn(),
	releaseIdempotencyKey: vi.fn(),
	deleteMetadataDO: vi.fn().mockResolvedValue(undefined),
	writeCleanupRecord: vi.fn().mockResolvedValue(undefined),
	deleteCleanupRecord: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../middleware/auth.worker', () => ({
	verifySession: vi.fn(),
	requireAuth: vi.fn(async (c: any, next: any) => {
		// Simulate successful authentication
		c.set('session', { userId: 'admin', username: 'admin', role: 'admin' });
		return next();
	}),
	createSession: vi.fn(),
	setSessionCookie: vi.fn(),
	clearSessionCookie: vi.fn(),
	getSessionToken: vi.fn(() => 'valid-token'),
	revokeSession: vi.fn()
}));

vi.mock('../../services/player-auth.worker', () => ({
	addAllowlistEntry: vi.fn(),
	deleteAllowlistEntry: vi.fn(),
	getPlayerByEmail: vi.fn(),
	listAllowlistEntries: vi.fn(),
	revokePlayerSessionsForEmail: vi.fn()
}));

// admin.worker.ts cleans up the D1 ownership row on puzzle delete. Mock the db
// handle and repository so the test doesn't bind a real D1 session and so the
// cleanup is assertable.
vi.mock('../../db.worker', () => ({
	getWorkerDb: vi.fn(() => dbContextMock.db),
	getWorkerDbContext: vi.fn(() => dbContextMock)
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const original = await importOriginal<typeof import('@perseus/shared')>();
	const { sharedMockOverrides } = await import('./helpers/shared-mock');
	return {
		...original,
		...sharedMockOverrides,
		deletePuzzleStats: original.deletePuzzleStats
	};
});

import admin from '../admin.worker';
import * as storage from '../../services/storage.worker';
import * as auth from '../../middleware/auth.worker';
import * as playerAuth from '../../services/player-auth.worker';
import { __resetRateLimitStore } from '../../middleware/rate-limit.worker';
import { insertPuzzleOwnership, deletePuzzleOwnership, SYSTEM_OWNER_ID } from '@perseus/shared';

// Valid PNG magic bytes header for test blobs
const PNG_HEADER = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00
]);

// 3x4 PNG for 3:4 (portrait) aspect ratio tests
const PNG_3X4 = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00
]);

describe('Admin Routes - Player Allowlist', () => {
	const metadataKv = {} as KVNamespace;
	const mockEnv = {
		ADMIN_PASSKEY: 'test-passkey',
		JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
		PUZZLE_METADATA: metadataKv
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('GET /player-allowlist returns entries with linked player metadata', async () => {
		const entryWithPlayer = {
			email: 'linked@example.com',
			createdAt: 1000,
			addedBy: 'admin'
		};
		const entryWithoutPlayer = {
			email: 'unlinked@example.com',
			createdAt: 2000,
			addedBy: 'admin'
		};
		const player = {
			id: 'player-1',
			email: 'linked@example.com',
			name: 'Linked Player',
			createdAt: 500,
			lastLoginAt: 1500
		};
		(playerAuth.listAllowlistEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
			entryWithPlayer,
			entryWithoutPlayer
		]);
		(playerAuth.getPlayerByEmail as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce(player)
			.mockResolvedValueOnce(null);

		const res = await admin.fetch(new Request('http://localhost/player-allowlist'), mockEnv);

		expect(res.status).toBe(200);
		expect(auth.requireAuth).toHaveBeenCalled();
		expect(playerAuth.listAllowlistEntries).toHaveBeenCalledWith(metadataKv);
		expect(playerAuth.getPlayerByEmail).toHaveBeenNthCalledWith(
			1,
			metadataKv,
			'linked@example.com'
		);
		expect(playerAuth.getPlayerByEmail).toHaveBeenNthCalledWith(
			2,
			metadataKv,
			'unlinked@example.com'
		);
		expect(await res.json()).toEqual({
			entries: [{ ...entryWithPlayer, player }, entryWithoutPlayer]
		});
	});

	it('POST /player-allowlist passes the raw email string and returns the service entry', async () => {
		const rawEmail = '  New.Player+Tag@Example.COM  ';
		const entry = {
			email: 'new.player+tag@example.com',
			createdAt: 3000,
			addedBy: 'admin'
		};
		(playerAuth.addAllowlistEntry as ReturnType<typeof vi.fn>).mockResolvedValue(entry);

		const res = await admin.fetch(
			new Request('http://localhost/player-allowlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: rawEmail })
			}),
			mockEnv
		);

		expect(res.status).toBe(200);
		expect(auth.requireAuth).toHaveBeenCalled();
		expect(playerAuth.addAllowlistEntry).toHaveBeenCalledWith(metadataKv, rawEmail, 'admin');
		expect(await res.json()).toEqual({ entry });
	});

	it('DELETE /player-allowlist/:email revokes sessions before deleting decoded email', async () => {
		const email = 'Raw.User+Tag@Example.COM';
		const encodedEmail = encodeURIComponent(email);
		(playerAuth.revokePlayerSessionsForEmail as ReturnType<typeof vi.fn>).mockResolvedValue(
			undefined
		);
		(playerAuth.deleteAllowlistEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		const res = await admin.fetch(
			new Request(`http://localhost/player-allowlist/${encodedEmail}`, {
				method: 'DELETE'
			}),
			mockEnv
		);

		expect(res.status).toBe(200);
		expect(auth.requireAuth).toHaveBeenCalled();
		expect(playerAuth.revokePlayerSessionsForEmail).toHaveBeenCalledWith(metadataKv, email);
		expect(playerAuth.deleteAllowlistEntry).toHaveBeenCalledWith(metadataKv, email);
		expect(
			(playerAuth.revokePlayerSessionsForEmail as ReturnType<typeof vi.fn>).mock
				.invocationCallOrder[0]
		).toBeLessThan(
			(playerAuth.deleteAllowlistEntry as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
		);
		expect(await res.json()).toEqual({ success: true });
	});

	it('DELETE /player-allowlist/:email does not double-decode percent characters', async () => {
		const email = 'user%example@example.com';
		const encodedEmail = 'user%25example%40example.com';
		(playerAuth.revokePlayerSessionsForEmail as ReturnType<typeof vi.fn>).mockResolvedValue(
			undefined
		);
		(playerAuth.deleteAllowlistEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		const res = await admin.fetch(
			new Request(`http://localhost/player-allowlist/${encodedEmail}`, {
				method: 'DELETE'
			}),
			mockEnv
		);

		expect(res.status).toBe(200);
		expect(playerAuth.revokePlayerSessionsForEmail).toHaveBeenCalledWith(metadataKv, email);
		expect(playerAuth.deleteAllowlistEntry).toHaveBeenCalledWith(metadataKv, email);
		expect(await res.json()).toEqual({ success: true });
	});

	it('POST /player-allowlist returns 400 for invalid JSON', async () => {
		const res = await admin.fetch(
			new Request('http://localhost/player-allowlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{invalid-json'
			}),
			mockEnv
		);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: 'bad_request',
			message: 'Invalid JSON body'
		});
	});

	it('POST /player-allowlist returns 400 when email is missing or non-string', async () => {
		for (const body of [{}, { email: 123 }]) {
			const res = await admin.fetch(
				new Request('http://localhost/player-allowlist', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				}),
				mockEnv
			);

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				error: 'bad_request',
				message: 'Email is required'
			});
		}
	});

	it('POST /player-allowlist maps invalid email service errors to 400', async () => {
		(playerAuth.addAllowlistEntry as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('Invalid email')
		);

		const res = await admin.fetch(
			new Request('http://localhost/player-allowlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: 'bad-email' })
			}),
			mockEnv
		);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: 'bad_request',
			message: 'Enter a valid email address'
		});
	});

	it('DELETE /player-allowlist/:email maps invalid email service errors to 400', async () => {
		(playerAuth.revokePlayerSessionsForEmail as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('Invalid email')
		);

		const res = await admin.fetch(
			new Request(`http://localhost/player-allowlist/${encodeURIComponent('bad-email')}`, {
				method: 'DELETE'
			}),
			mockEnv
		);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: 'bad_request',
			message: 'Enter a valid email address'
		});
	});
});

describe('Admin Routes - JSON Parsing', () => {
	const mockEnv = {
		ADMIN_PASSKEY: 'test-passkey',
		JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
		RATE_LIMIT_KV: {} as KVNamespace
	};

	describe('POST /login', () => {
		it('should return 400 for malformed JSON', async () => {
			const req = new Request('http://localhost/login', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'cf-connecting-ip': '127.0.0.1'
				},
				body: '{invalid json}'
			});

			const res = await admin.fetch(req, mockEnv);

			// Verify status code first
			expect(res.status).toBe(400);

			const body = (await res.json()) as any;
			expect(body.error).toBe('bad_request');
			expect(body.message).toContain('Invalid JSON');
		});

		it('should return 400 for missing Content-Type', async () => {
			const req = new Request('http://localhost/login', {
				method: 'POST',
				headers: {
					'cf-connecting-ip': '127.0.0.1'
				},
				body: 'not json'
			});

			const res = await admin.fetch(req, mockEnv);

			// Verify status code
			expect(res.status).toBe(400);

			const body = (await res.json()) as any;
			expect(body.error).toBe('bad_request');
		});
	});
});

describe('Admin Routes - Puzzle Deletion', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('DELETE /puzzles/:id', () => {
		it('should return 207 when some assets fail to delete', async () => {
			// Mock getPuzzle to return a valid puzzle
			(storage.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: '550e8400-e29b-41d4-a716-446655440000',
				name: 'Test Puzzle',
				pieceCount: 4,
				gridCols: 2,
				gridRows: 2,
				imageWidth: 100,
				imageHeight: 100,
				createdAt: Date.now(),
				status: 'ready',
				pieces: [],
				version: 0
			});

			// Mock deletePuzzleAssets to return partial failure
			(storage.deletePuzzleAssets as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: false,
				failedKeys: ['puzzles/test-puzzle/pieces/0.png', 'puzzles/test-puzzle/pieces/1.png']
			});

			// Mock deletePuzzleMetadata to return success
			(storage.deletePuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true
			});

			// Mock auth to allow the request
			(auth.verifySession as ReturnType<typeof vi.fn>).mockResolvedValue({
				userId: 'admin',
				username: 'admin',
				role: 'admin'
			});

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket
			};

			const req = new Request(
				'http://localhost/puzzle-delete/550e8400-e29b-41d4-a716-446655440000',
				{
					method: 'POST',
					headers: {
						cookie: 'session=valid.token'
					}
				}
			);

			const res = await admin.fetch(req, mockEnv);

			// Should return 207
			expect(res.status).toBe(207);

			const body = (await res.json()) as any;
			expect(body.success).toBe(false);
			expect(body.partialSuccess).toBe(true);
			expect(body.warning).toBe('R2 asset deletion partial; KV preserved for reaper retry');
			expect(body.failedAssets).toEqual([
				'puzzles/test-puzzle/pieces/0.png',
				'puzzles/test-puzzle/pieces/1.png'
			]);

			// Safe ordering: KV metadata is NOT deleted when R2 deletion fails
			// partially — the failed R2 keys would become invisible orphans
			// with no metadata to discover them. KV is preserved so the reaper
			// can retry R2 cleanup on its next run.
			expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();

			// A cleanup record is written so the reaper picks this puzzle up
			// even if the operator never retries.
			expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.objectContaining({ puzzleId: '550e8400-e29b-41d4-a716-446655440000' })
			);

			// D1 ownership cleanup is NOT reached on R2 partial failure — the
			// reaper handles D1 cleanup after R2/KV succeed on retry.
			const { deletePuzzleOwnership } = await import('@perseus/shared');
			expect(deletePuzzleOwnership).not.toHaveBeenCalled();
		});
	});
});

describe('Admin Routes - Logout', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should return 200 and clear cookie when session revocation fails in development', async () => {
		(auth.revokeSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('KV unavailable'));

		const mockEnv = {
			ADMIN_PASSKEY: 'test-passkey',
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			NODE_ENV: 'development'
		};

		const req = new Request('http://localhost/logout', {
			method: 'POST',
			headers: {
				cookie: 'session=valid.token'
			}
		});

		const res = await admin.fetch(req, mockEnv as any);

		// In development, session revocation failure should still return success
		// and clear the client cookie for debugging convenience
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.success).toBe(true);
		expect(auth.clearSessionCookie).toHaveBeenCalled();
	});

	it('should return 500 when session revocation fails in production', async () => {
		(auth.revokeSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('KV unavailable'));

		const mockEnv = {
			ADMIN_PASSKEY: 'test-passkey',
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			NODE_ENV: 'production'
		};

		const req = new Request('http://localhost/logout', {
			method: 'POST',
			headers: {
				cookie: 'session=valid.token'
			}
		});

		const res = await admin.fetch(req, mockEnv as any);

		// In production, session revocation failure is a security concern
		// - the client should be notified and retry
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Failed to revoke session. Please try again.');
		expect(auth.clearSessionCookie).not.toHaveBeenCalled();
	});
});

describe('Admin Routes - Passkey Validation', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});

	describe('POST /login', () => {
		it('should return 500 when ADMIN_PASSKEY is missing from environment', async () => {
			const mockEnv = {
				ADMIN_PASSKEY: undefined,
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				RATE_LIMIT_KV: {} as KVNamespace
			};

			const req = new Request('http://localhost/login', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'cf-connecting-ip': '127.0.0.1'
				},
				body: JSON.stringify({ passkey: 'any-passkey' })
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(500);
			const body = (await res.json()) as any;
			expect(body.error).toBe('internal_error');
			expect(body.message).toContain('Server configuration error');
		});

		it('should return 400 for empty passkey string', async () => {
			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				RATE_LIMIT_KV: {} as KVNamespace
			};

			const req = new Request('http://localhost/login', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'cf-connecting-ip': '127.0.0.1'
				},
				body: JSON.stringify({ passkey: '' })
			});

			const res = await admin.fetch(req, mockEnv);

			expect(res.status).toBe(400);
			const body = (await res.json()) as any;
			expect(body.error).toBe('bad_request');
			expect(body.message).toContain('Passkey is required');
		});

		it('should return 401 for whitespace-only passkey', async () => {
			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				RATE_LIMIT_KV: {} as KVNamespace
			};

			const req = new Request('http://localhost/login', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'cf-connecting-ip': '127.0.0.1'
				},
				body: JSON.stringify({ passkey: '   ' })
			});

			const res = await admin.fetch(req, mockEnv);

			expect(res.status).toBe(401);
			const body = (await res.json()) as any;
			expect(body.error).toBe('unauthorized');
			expect(body.message).toBe('Invalid passkey');
		});

		it('should handle unicode characters in constant-time comparison', async () => {
			const mockEnv = {
				ADMIN_PASSKEY: 'test-🔐-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				RATE_LIMIT_KV: {} as KVNamespace
			};

			const req = new Request('http://localhost/login', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'cf-connecting-ip': '127.0.0.1'
				},
				body: JSON.stringify({ passkey: 'test-🔐-passkey' })
			});

			const res = await admin.fetch(req, mockEnv);

			expect(res.status).toBe(200);
			const body = (await res.json()) as any;
			expect(body.success).toBe(true);
		});
	});
});

describe('Admin Routes - Workflow Trigger Cleanup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('POST /puzzles', () => {
		it('should reject pieceCount with trailing characters', async () => {
			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn()
				}
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225abc');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(400);
			const body = (await res.json()) as any;
			expect(body.error).toBe('bad_request');
			expect(body.message).toContain('Invalid piece count');
		});

		it('should accept a portrait aspect ratio and store matching grid metadata', async () => {
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn().mockResolvedValue(undefined)
				}
			};

			const formData = new FormData();
			formData.append('name', 'Portrait Puzzle');
			formData.append('pieceCount', '48');
			formData.append('aspectRatio', '3:4');
			const blob = new Blob([PNG_3X4], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(201);
			expect(storage.createPuzzleMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.objectContaining({
					name: 'Portrait Puzzle',
					pieceCount: 48,
					aspectRatio: '3:4',
					gridCols: 6,
					gridRows: 8
				})
			);
			// Admin-created puzzles are mirrored into D1 with a system sentinel
			// owner so listPlayerStats can resolve their names.
			expect(insertPuzzleOwnership).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					ownerId: SYSTEM_OWNER_ID,
					name: 'Portrait Puzzle',
					pieceCount: 48,
					status: 'processing'
				})
			);
		});

		it('rejects a tombstoned generated ID before publishing Worker data', async () => {
			const generatedId = '550e8400-e29b-41d4-a716-446655440000';
			const uuidSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValue(generatedId);
			dbContextMock.completionWrites.isPuzzleTombstoned.mockResolvedValueOnce(true);
			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn()
				}
			};
			const formData = new FormData();
			formData.append('name', 'Tombstoned Puzzle');
			formData.append('pieceCount', '48');
			formData.append('aspectRatio', '3:4');
			formData.append('image', new Blob([PNG_3X4], { type: 'image/png' }), 'test.png');

			try {
				const res = await admin.fetch(
					new Request('http://localhost/puzzles', {
						method: 'POST',
						headers: { cookie: 'session=valid.token' },
						body: formData
					}),
					mockEnv as any
				);

				expect(res.status).toBe(500);
				expect(await res.json()).toEqual({
					error: 'internal_error',
					message: 'Failed to allocate puzzle ID'
				});
				expect(dbContextMock.completionWrites.isPuzzleTombstoned).toHaveBeenCalledWith(generatedId);
				expect(storage.uploadOriginalImage).not.toHaveBeenCalled();
				expect(storage.createPuzzleMetadata).not.toHaveBeenCalled();
				expect(insertPuzzleOwnership).not.toHaveBeenCalled();
				expect(mockEnv.PUZZLE_WORKFLOW.create).not.toHaveBeenCalled();
			} finally {
				uuidSpy.mockRestore();
			}
		});

		it('should cleanup both metadata and image when workflow.create() fails', async () => {
			// Mock successful image upload
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			// Mock successful metadata creation
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			// Mock successful cleanup operations
			(storage.deletePuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true
			});
			(storage.deleteOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true
			});

			// Create mock environment with workflow that throws
			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn().mockRejectedValue(new Error('Workflow service unavailable')),
					get: vi.fn().mockRejectedValue(
						Object.assign(new Error('instance.not_found'), {
							code: 'instance.not_found'
						})
					)
				}
			};

			// Create form data
			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			// Verify 500 response
			expect(res.status).toBe(500);
			const body = (await res.json()) as any;
			expect(body.error).toBe('internal_error');
			expect(body.message).toBe('Failed to start puzzle processing');

			const createdPuzzleMetadata = (storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mock
				.calls[0][1];

			expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				createdPuzzleMetadata.id
			);
			expect(storage.deleteOriginalImage).toHaveBeenCalledWith(
				mockEnv.PUZZLES_BUCKET,
				createdPuzzleMetadata.id
			);
			// Ownership row inserted before the workflow trigger must also be cleaned up.
			expect(deletePuzzleOwnership).toHaveBeenCalledWith(
				expect.anything(),
				createdPuzzleMetadata.id
			);
		});

		it('should return 503 and cleanup when workflow binding is missing', async () => {
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.deletePuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true
			});
			(storage.deleteOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true
			});

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(503);
			const body = (await res.json()) as any;
			expect(body.error).toBe('service_unavailable');
			expect(body.message).toContain('not configured');
			const createdPuzzleMetadata = (storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mock
				.calls[0][1];

			expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				createdPuzzleMetadata.id
			);
			expect(storage.deleteOriginalImage).toHaveBeenCalledWith(
				mockEnv.PUZZLES_BUCKET,
				createdPuzzleMetadata.id
			);
			// Ownership row inserted before the workflow binding check must also be cleaned up.
			expect(deletePuzzleOwnership).toHaveBeenCalledWith(
				expect.anything(),
				createdPuzzleMetadata.id
			);
		});
	});
});

describe('Admin Routes - Magic Bytes Validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('POST /puzzles', () => {
		it('should reject file with spoofed MIME type but invalid magic bytes', async () => {
			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn()
				}
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			// File claims to be PNG but has invalid magic bytes
			const blob = new Blob(['fake image data'], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(400);
			const body = (await res.json()) as any;
			expect(body.error).toBe('bad_request');
			expect(body.message).toContain('Invalid file type');
		});

		it('should accept file with valid JPEG magic bytes', async () => {
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn().mockResolvedValue(undefined)
				}
			};

			// Valid JPEG with SOF0 marker (1x1 for default 1:1 aspect ratio)
			const jpegHeader = new Uint8Array([
				0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00
			]);
			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([jpegHeader], { type: 'image/jpeg' });
			formData.append('image', blob, 'test.jpg');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			// Should successfully accept the valid JPEG
			expect(res.status).toBe(201);
		});

		it('should return existing puzzle when Idempotency-Key already reserved', async () => {
			const existingPuzzle = {
				id: 'original-uuid',
				name: 'Test Puzzle',
				pieceCount: 225,
				status: 'processing',
				aspectRatio: '1:1',
				gridCols: 15,
				gridRows: 15,
				imageWidth: 0,
				imageHeight: 0,
				createdAt: 1700000000000,
				pieces: [],
				version: 0,
				progress: { totalPieces: 225, generatedPieces: 0, updatedAt: 1700000000000 }
			};
			(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
				existing: true,
				puzzleId: 'original-uuid'
			});
			(storage.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(existingPuzzle);

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: { create: vi.fn() },
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token',
					'Idempotency-Key': 'abc123def456'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(200);
			const body = (await res.json()) as any;
			expect(body.id).toBe('original-uuid');
			// Must NOT have created a new puzzle
			expect(storage.createPuzzleMetadata).not.toHaveBeenCalled();
			expect(storage.uploadOriginalImage).not.toHaveBeenCalled();
		});

		it('should reject invalid Idempotency-Key header format', async () => {
			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: { create: vi.fn() }
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token',
					'Idempotency-Key': 'has spaces!'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(400);
			const body = (await res.json()) as any;
			expect(body.error).toBe('bad_request');
			expect(storage.reserveIdempotencyKey).not.toHaveBeenCalled();
		});

		it('should create puzzle with idempotencyKey when first reserve', async () => {
			(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
				existing: false,
				puzzleId: 'new-uuid',
				status: 'pending'
			});
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.commitIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) },
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token',
					'Idempotency-Key': 'abc123def456'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(201);
			expect(storage.reserveIdempotencyKey).toHaveBeenCalled();
			expect(storage.commitIdempotencyKey).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA_DO,
				'abc123def456',
				'new-uuid'
			);
			expect(storage.createPuzzleMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.objectContaining({
					idempotencyKey: 'abc123def456'
				})
			);
		});

		it('fails reservation (not release) when metadata cleanup fails after workflow trigger', async () => {
			// When the workflow trigger fails AND metadata cleanup also fails,
			// the reservation must be FAILED (not released) so a retry reclaims
			// through the DO's serialized path. Releasing would let a same-key
			// retry mint a replacement alongside the orphaned processing
			// metadata. The orphan remains in KV for operator force-delete.
			(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
				existing: false,
				puzzleId: 'reserved-uuid',
				status: 'pending'
			});
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.deletePuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: false,
				error: new Error('KV delete failed')
			});
			(storage.deleteOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true
			});
			(storage.failIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn().mockRejectedValue(new Error('Workflow unavailable')),
					get: vi.fn().mockRejectedValue(
						Object.assign(new Error('instance.not_found'), {
							code: 'instance.not_found'
						})
					)
				},
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token',
					'Idempotency-Key': 'abc123def456'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(500);
			const body = (await res.json()) as any;
			expect(body.error).toBe('internal_error');
			expect(body.message).toMatch(/stuck|metadata cleanup failed/i);
			// Reservation FAILED (not released) so the key is retained in a
			// recoverable state and a retry reclaims through the DO.
			expect(storage.failIdempotencyKey).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA_DO,
				'abc123def456',
				'reserved-uuid'
			);
			expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
		});

		it('fails reservation (not release) when R2 image cleanup fails after workflow trigger failure', async () => {
			// When the workflow trigger fails, metadata cleanup succeeds, BUT R2
			// image cleanup fails, the orphaned original remains in R2. Releasing
			// the reservation would let a retry mint a replacement alongside the
			// orphan. Fail the reservation instead so the key is retained in a
			// recoverable state and a retry reclaims through the DO's serialized
			// path.
			(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
				existing: false,
				puzzleId: 'reserved-uuid',
				status: 'pending'
			});
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.deletePuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true
			});
			(storage.deleteOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: false,
				error: new Error('R2 delete failed')
			});
			(storage.failIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.releaseIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn().mockRejectedValue(new Error('Workflow unavailable')),
					get: vi.fn().mockRejectedValue(
						Object.assign(new Error('instance.not_found'), {
							code: 'instance.not_found'
						})
					)
				},
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token',
					'Idempotency-Key': 'abc123def456'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(500);
			const body = (await res.json()) as any;
			expect(body.error).toBe('internal_error');
			expect(body.message).toMatch(/stuck|image cleanup failed/i);
			// R2 cleanup attempted.
			expect(storage.deleteOriginalImage).toHaveBeenCalledTimes(1);
			// Reservation FAILED (not released) because R2 cleanup failed.
			expect(storage.failIdempotencyKey).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA_DO,
				'abc123def456',
				'reserved-uuid'
			);
			expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
		});

		it('fails reservation (not release) when R2 image cleanup fails after missing workflow binding', async () => {
			// When the workflow binding is missing, metadata cleanup succeeds,
			// BUT R2 image cleanup fails, the orphaned original remains in R2.
			// Releasing the reservation would let a retry mint a replacement
			// alongside the orphan. Fail the reservation instead.
			(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
				existing: false,
				puzzleId: 'reserved-uuid',
				status: 'pending'
			});
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.deletePuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true
			});
			(storage.deleteOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: false,
				error: new Error('R2 delete failed')
			});
			(storage.failIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.releaseIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token',
					'Idempotency-Key': 'abc123def456'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(500);
			const body = (await res.json()) as any;
			expect(body.error).toBe('internal_error');
			expect(body.message).toMatch(/stuck|image cleanup failed/i);
			expect(storage.deleteOriginalImage).toHaveBeenCalledTimes(1);
			expect(storage.failIdempotencyKey).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA_DO,
				'abc123def456',
				'reserved-uuid'
			);
			expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
		});

		it('should return 409 when key is reserved but metadata is missing', async () => {
			(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
				existing: true,
				puzzleId: 'original-uuid',
				status: 'pending'
			});
			(storage.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(null);

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: { create: vi.fn() },
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token',
					'Idempotency-Key': 'abc123def456'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(409);
			expect(storage.createPuzzleMetadata).not.toHaveBeenCalled();
		});

		it('should return 200 when committed reservation has stale KV read that resolves on retry', async () => {
			// A committed reservation means the create succeeded; a missing first
			// getPuzzle is KV propagation lag. The API retries once after a brief
			// delay; if the retry finds the metadata, it returns the existing
			// puzzle (200) instead of bricking the key or creating a duplicate.
			(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
				existing: true,
				puzzleId: 'original-uuid',
				status: 'committed'
			});
			const existingPuzzle = {
				id: 'original-uuid',
				name: 'Test Puzzle',
				pieceCount: 225,
				status: 'processing',
				aspectRatio: '1:1',
				gridCols: 15,
				gridRows: 15,
				imageWidth: 0,
				imageHeight: 0,
				createdAt: 1700000000000,
				pieces: [],
				version: 0,
				progress: { totalPieces: 225, generatedPieces: 0, updatedAt: 1700000000000 }
			};
			// First read: null (KV lag). Retry: finds the puzzle.
			(storage.getPuzzle as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce(null)
				.mockResolvedValue(existingPuzzle);

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				// Committed + processing now probes workflow liveness before
				// acknowledging 200 (P2 #3/#4). The puzzle is genuinely live,
				// so the workflow reports 'running'.
				PUZZLE_WORKFLOW: {
					create: vi.fn(),
					get: vi.fn(async () => ({
						status: vi.fn().mockResolvedValue({ status: 'running' })
					}))
				},
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token',
					'Idempotency-Key': 'abc123def456'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(200);
			const body = (await res.json()) as any;
			expect(body.id).toBe('original-uuid');
			expect(storage.createPuzzleMetadata).not.toHaveBeenCalled();
			expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
		});

		it('should release stale committed reservation and re-reserve when puzzle was deleted', async () => {
			// A committed reservation with no metadata even after the KV retry
			// means the puzzle was deleted but the reservation release failed
			// (e.g. DO outage during admin delete). The API must release the
			// stale reservation and re-reserve so the key isn't permanently
			// bricked mapping to a deleted puzzle (which would 409 every future
			// upload with that key).
			(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce({
					existing: true,
					puzzleId: 'deleted-uuid',
					status: 'committed'
				})
				.mockResolvedValueOnce({
					existing: false,
					puzzleId: 'replacement-uuid',
					status: 'pending'
				});
			// Both reads (initial + retry) return null — puzzle is gone.
			(storage.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(null);
			(storage.releaseIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.commitIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) },
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token',
					'Idempotency-Key': 'abc123def456'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(201);
			// Released the stale committed reservation before re-reserving.
			expect(storage.releaseIdempotencyKey).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA_DO,
				'abc123def456',
				'deleted-uuid'
			);
			// Created a replacement puzzle under the re-reserved id.
			expect(storage.createPuzzleMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.objectContaining({ id: 'replacement-uuid', idempotencyKey: 'abc123def456' })
			);
		});

		it('should 409 (not release) when R2 probe fails for a stale committed reservation', async () => {
			// A transient R2 `head` failure must NOT be interpreted as "object
			// gone" — that would release the reservation and mint a duplicate
			// of a live puzzle. Fail closed: 409 so the client retries.
			(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				existing: true,
				puzzleId: 'live-uuid',
				status: 'committed'
			});
			(storage.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(null);
			(storage.originalImageExists as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
				new Error('R2 internal error')
			);
			(storage.releaseIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) },
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token',
					'Idempotency-Key': 'abc123def456'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(409);
			// Must NOT release — the live puzzle's reservation stays intact.
			expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
			// Must NOT create a replacement puzzle.
			expect(storage.createPuzzleMetadata).not.toHaveBeenCalled();
		});

		it('should reclaim a failed reservation and create a replacement puzzle', async () => {
			// A committed reservation whose workflow later marked the puzzle
			// failed must be reclaimed (failIdempotencyKey) and re-reserved so
			// this request builds a replacement instead of returning the failed
			// metadata as 200 (which would make the seed uploader skip it).
			(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce({
					existing: true,
					puzzleId: 'failed-uuid',
					status: 'committed'
				})
				.mockResolvedValueOnce({
					existing: false,
					puzzleId: 'replacement-uuid',
					status: 'pending'
				});
			(storage.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: 'failed-uuid',
				name: 'Test Puzzle',
				pieceCount: 225,
				status: 'failed',
				aspectRatio: '1:1',
				gridCols: 15,
				gridRows: 15,
				imageWidth: 0,
				imageHeight: 0,
				createdAt: 1700000000000,
				pieces: [],
				version: 0,
				progress: { totalPieces: 225, generatedPieces: 0, updatedAt: 1700000000000 }
			});
			(storage.failIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.commitIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) },
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token',
					'Idempotency-Key': 'abc123def456'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(201);
			// Reclaimed the failed reservation before re-reserving.
			expect(storage.failIdempotencyKey).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA_DO,
				'abc123def456',
				'failed-uuid'
			);
			// Created a replacement puzzle under the re-reserved id.
			expect(storage.createPuzzleMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.objectContaining({ id: 'replacement-uuid', idempotencyKey: 'abc123def456' })
			);
			expect(mockEnv.PUZZLE_WORKFLOW.create).toHaveBeenCalledWith({
				id: 'replacement-uuid',
				params: { puzzleId: 'replacement-uuid' }
			});
			// Committed the new reservation.
			expect(storage.commitIdempotencyKey).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA_DO,
				'abc123def456',
				'replacement-uuid'
			);
		});

		it('should not overwrite the re-reserved id when reclaiming a failed reservation whose key was concurrently re-committed to a deleted puzzle', async () => {
			// Narrow race regression: the original reservation was committed to
			// 'failed-uuid' (puzzle later failed). We fail it and try to reclaim.
			// Between our fail and our reclaim, a concurrent retry reclaimed the
			// key, committed it to 'deleted-uuid', created that puzzle, then it
			// was admin-deleted but the reservation release failed (DO outage).
			// So our reclaim sees an existing committed reservation for
			// 'deleted-uuid' with no metadata and no R2 image. We release that
			// stale reservation and re-reserve with our fresh UUID — which wins.
			// The handler MUST create the replacement under our fresh UUID (the
			// rereserved id), NOT 'deleted-uuid' (the old committed id).
			// Overwriting id with reclaimed.puzzleId would create the puzzle under
			// 'deleted-uuid' while the DO maps the key to our fresh UUID → commit
			// 409 (owner mismatch) → silent release 404 → reservation stays
			// pending → TTL expiry → retry mints yet another UUID → duplicate
			// puzzles.
			(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce({
					existing: true,
					puzzleId: 'failed-uuid',
					status: 'committed'
				})
				.mockResolvedValueOnce({
					existing: true,
					puzzleId: 'deleted-uuid',
					status: 'committed'
				})
				.mockResolvedValueOnce({
					existing: false,
					puzzleId: 'fresh-uuid',
					status: 'pending'
				});
			// First getPuzzle ('failed-uuid') returns failed metadata; second
			// ('deleted-uuid') returns null (puzzle was deleted).
			(storage.getPuzzle as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce({
					id: 'failed-uuid',
					name: 'Test Puzzle',
					pieceCount: 225,
					status: 'failed',
					aspectRatio: '1:1',
					gridCols: 15,
					gridRows: 15,
					imageWidth: 0,
					imageHeight: 0,
					createdAt: 1700000000000,
					pieces: [],
					version: 0,
					progress: { totalPieces: 225, generatedPieces: 0, updatedAt: 1700000000000 }
				})
				.mockResolvedValue(null);
			(storage.failIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.releaseIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.commitIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) },
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token',
					'Idempotency-Key': 'abc123def456'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(201);
			// Created the replacement under the rereserved id ('fresh-uuid'),
			// NOT the stale committed id ('deleted-uuid'). Overwriting id with
			// reclaimed.puzzleId was the bug.
			expect(storage.createPuzzleMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.objectContaining({ id: 'fresh-uuid', idempotencyKey: 'abc123def456' })
			);
			expect(mockEnv.PUZZLE_WORKFLOW.create).toHaveBeenCalledWith({
				id: 'fresh-uuid',
				params: { puzzleId: 'fresh-uuid' }
			});
			expect(storage.commitIdempotencyKey).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA_DO,
				'abc123def456',
				'fresh-uuid'
			);
			// Released the stale committed reservation for 'deleted-uuid' before re-reserving.
			expect(storage.releaseIdempotencyKey).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA_DO,
				'abc123def456',
				'deleted-uuid'
			);
			// failIdempotencyKey was called once to fail the ORIGINAL
			// reservation ('failed-uuid') so it became reclaimable. It must
			// NOT have been called again for the rereserved reservation — we
			// won the rereserve, so we own it and commit (not fail) it.
			expect(storage.failIdempotencyKey).toHaveBeenCalledTimes(1);
			expect(storage.failIdempotencyKey).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA_DO,
				'abc123def456',
				'failed-uuid'
			);
		});

		it('should best-effort commit a still-pending reservation when returning existing puzzle', async () => {
			// If the original create's commit failed, a retry that finds the
			// existing puzzle must commit the pending reservation so the key
			// doesn't expire into a reclaimable state that spawns a duplicate.
			// The liveness probe must report the original's workflow as alive
			// (running or complete) before committing — a dead workflow means
			// the puzzle is stuck and the key should be reclaimed instead.
			(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
				existing: true,
				puzzleId: 'original-uuid',
				status: 'pending'
			});
			(storage.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: 'original-uuid',
				name: 'Test Puzzle',
				pieceCount: 225,
				status: 'ready',
				aspectRatio: '1:1',
				gridCols: 15,
				gridRows: 15,
				imageWidth: 3840,
				imageHeight: 3840,
				createdAt: 1700000000000,
				pieces: [],
				version: 1,
				progress: { totalPieces: 225, generatedPieces: 225, updatedAt: 1700000001000 }
			});
			(storage.commitIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn(),
					get: vi.fn(() => ({
						status: vi.fn(async () => ({ status: 'complete' }))
					}))
				},
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token',
					'Idempotency-Key': 'abc123def456'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(200);
			const body = (await res.json()) as any;
			expect(body.id).toBe('original-uuid');
			expect(storage.commitIdempotencyKey).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA_DO,
				'abc123def456',
				'original-uuid'
			);
			expect(storage.createPuzzleMetadata).not.toHaveBeenCalled();
		});

		it('should return 500 when idempotency commit fails after all retries (transient)', async () => {
			// The puzzle and workflow already exist, but the reservation is
			// still pending. A transient DO failure must retain the workflow
			// and metadata so a client retry can commit.
			(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
				existing: false,
				puzzleId: 'new-uuid',
				status: 'pending'
			});
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.commitIdempotencyKey as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('DO unavailable')
			);

			const terminateFn = vi.fn().mockResolvedValue(undefined);
			const mockEnv = {
				ADMIN_PASSKEY: 'test-passkey',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn().mockResolvedValue(undefined),
					get: vi.fn(async () => ({
						status: vi.fn().mockResolvedValue({ status: 'running' }),
						terminate: terminateFn
					}))
				},
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			formData.append('pieceCount', '225');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzles', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token',
					'Idempotency-Key': 'abc123def456'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(500);
			const body = (await res.json()) as any;
			expect(body.error).toBe('internal_error');
			expect(body.message).toBe('Failed to commit idempotency reservation; retry');
			expect(storage.commitIdempotencyKey).toHaveBeenCalledTimes(3);
			expect(terminateFn).not.toHaveBeenCalled();
			expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
			expect(storage.deleteOriginalImage).not.toHaveBeenCalled();
		});
	});
});

describe('Admin Routes - Login Success/Failure', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
	});

	it('should return 200 with correct passkey', async () => {
		(auth.createSession as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');

		const mockEnv = {
			ADMIN_PASSKEY: 'correct-passkey',
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890'
		};

		const req = new Request('http://localhost/login', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'cf-connecting-ip': '127.0.0.1'
			},
			body: JSON.stringify({ passkey: 'correct-passkey' })
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.success).toBe(true);
	});

	it('should return 401 with wrong passkey', async () => {
		const mockEnv = {
			ADMIN_PASSKEY: 'correct-passkey',
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890'
		};

		const req = new Request('http://localhost/login', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'cf-connecting-ip': '127.0.0.1'
			},
			body: JSON.stringify({ passkey: 'wrong-passkey' })
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(401);
		const body = (await res.json()) as any;
		expect(body.error).toBe('unauthorized');
	});
});

describe('Admin Routes - Delete Puzzle Cases', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		dbContextMock.completionWrites.finishPuzzleDeletion.mockResolvedValue(undefined);
	});

	const mockEnv = {
		ADMIN_PASSKEY: 'test-passkey',
		JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
		PUZZLE_METADATA: {} as KVNamespace,
		PUZZLES_BUCKET: {} as R2Bucket
	};

	it('should return 400 for invalid UUID', async () => {
		const req = new Request('http://localhost/puzzle-delete/not-a-uuid', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBe('bad_request');
	});

	it('should return 404 when puzzle not found', async () => {
		(storage.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		(storage.puzzleExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

		const req = new Request('http://localhost/puzzle-delete/550e8400-e29b-41d4-a716-446655440000', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
	});

	it('should delete puzzle with corrupt metadata via puzzleExists fallback', async () => {
		// When getPuzzle throws (corrupt metadata that fails validation),
		// the DELETE route must fall back to puzzleExists and still delete
		// the puzzle instead of 500-ing. pieceCount is 0 in this case so
		// only original + thumbnail are deleted from R2.
		(storage.getPuzzle as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('Corrupt puzzle metadata: data exists but fails validation')
		);
		(storage.puzzleExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		(storage.deletePuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: true
		});
		(storage.deletePuzzleAssets as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: true,
			failedKeys: []
		});

		const req = new Request('http://localhost/puzzle-delete/550e8400-e29b-41d4-a716-446655440000', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(204);
		// KV metadata deleted (source of truth).
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(
			mockEnv.PUZZLE_METADATA,
			'550e8400-e29b-41d4-a716-446655440000'
		);
		// R2 assets deleted with pieceCount=0 (corrupt metadata → unknown).
		expect(storage.deletePuzzleAssets).toHaveBeenCalledWith(
			mockEnv.PUZZLES_BUCKET,
			'550e8400-e29b-41d4-a716-446655440000',
			0
		);
	});

	it('should return 404 when puzzle not found and metadata is corrupt but key absent', async () => {
		// getPuzzle throws AND puzzleExists returns false → genuinely gone.
		(storage.getPuzzle as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('Corrupt puzzle metadata')
		);
		(storage.puzzleExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

		const req = new Request('http://localhost/puzzle-delete/550e8400-e29b-41d4-a716-446655440000', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
	});

	it('should return 409 when puzzle is processing', async () => {
		(storage.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: '550e8400-e29b-41d4-a716-446655440000',
			name: 'Test',
			pieceCount: 4,
			status: 'processing',
			pieces: [],
			version: 0
		});

		const req = new Request('http://localhost/puzzle-delete/550e8400-e29b-41d4-a716-446655440000', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(409);
		const body = (await res.json()) as any;
		expect(body.error).toBe('conflict');
	});

	it('should return 204 on successful deletion', async () => {
		(storage.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: '550e8400-e29b-41d4-a716-446655440000',
			name: 'Test',
			pieceCount: 4,
			status: 'ready',
			pieces: [],
			version: 0
		});
		(storage.deletePuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: true
		});
		(storage.deletePuzzleAssets as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: true,
			failedKeys: []
		});

		const req = new Request('http://localhost/puzzle-delete/550e8400-e29b-41d4-a716-446655440000', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(204);
		const { getWorkerDbContext } = await import('../../db.worker');
		expect(getWorkerDbContext).toHaveBeenCalledWith(mockEnv);
		expect(deletePuzzleOwnership).toHaveBeenCalledWith(
			dbContextMock.db,
			'550e8400-e29b-41d4-a716-446655440000'
		);
		expect(dbContextMock.completionWrites.finishPuzzleDeletion).toHaveBeenCalledWith(
			'550e8400-e29b-41d4-a716-446655440000'
		);
		expect(
			(storage.deletePuzzleMetadata as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
		).toBeLessThan(dbContextMock.completionWrites.finishPuzzleDeletion.mock.invocationCallOrder[0]);
	});

	it('still returns 204 when atomic completion cleanup fails after KV deletion', async () => {
		(storage.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: '550e8400-e29b-41d4-a716-446655440000',
			name: 'Test',
			pieceCount: 4,
			status: 'ready',
			pieces: [],
			version: 0
		});
		(storage.deletePuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: true
		});
		(storage.deletePuzzleAssets as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: true,
			failedKeys: []
		});
		dbContextMock.completionWrites.finishPuzzleDeletion.mockRejectedValueOnce(
			new Error('D1 completion cleanup failed')
		);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const req = new Request('http://localhost/puzzle-delete/550e8400-e29b-41d4-a716-446655440000', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(204);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Failed to delete stats rows'),
			expect.any(Error)
		);
		expect(
			(storage.deletePuzzleMetadata as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
		).toBeLessThan(dbContextMock.completionWrites.finishPuzzleDeletion.mock.invocationCallOrder[0]);
		consoleSpy.mockRestore();
	});
});

describe('Admin Routes - Session Check', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const mockEnv = {
		ADMIN_PASSKEY: 'test-passkey',
		JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890'
	};

	it('should return authenticated: false when no token', async () => {
		(auth.getSessionToken as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

		const req = new Request('http://localhost/session', {
			method: 'GET'
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.authenticated).toBe(false);
	});

	it('should return authenticated: false for invalid token', async () => {
		(auth.getSessionToken as ReturnType<typeof vi.fn>).mockReturnValue('invalid-token');
		(auth.verifySession as ReturnType<typeof vi.fn>).mockResolvedValue(null);

		const req = new Request('http://localhost/session', {
			method: 'GET',
			headers: { cookie: 'session=invalid-token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.authenticated).toBe(false);
	});

	it('should return authenticated: true for valid token', async () => {
		(auth.getSessionToken as ReturnType<typeof vi.fn>).mockReturnValue('valid-token');
		(auth.verifySession as ReturnType<typeof vi.fn>).mockResolvedValue({
			userId: 'admin',
			username: 'admin',
			role: 'admin'
		});

		const req = new Request('http://localhost/session', {
			method: 'GET',
			headers: { cookie: 'session=valid-token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.authenticated).toBe(true);
	});
});

describe('Admin Routes - Metadata Creation Failure Cleanup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should cleanup R2 image when metadata creation fails', async () => {
		(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('KV write failed')
		);
		(storage.deleteOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: true
		});

		const mockEnv = {
			ADMIN_PASSKEY: 'test-passkey',
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLES_BUCKET: {} as R2Bucket,
			PUZZLE_WORKFLOW: { create: vi.fn() }
		};

		const formData = new FormData();
		formData.append('name', 'Test Puzzle');
		formData.append('pieceCount', '225');
		const blob = new Blob([PNG_HEADER], { type: 'image/png' });
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		expect(storage.deleteOriginalImage).toHaveBeenCalledTimes(1);
	});

	it('fails reservation (not release) when R2 image cleanup fails after metadata creation failure', async () => {
		// When metadata creation fails AND R2 image cleanup also fails, the
		// orphaned original remains in R2. Releasing the reservation would
		// let a retry mint a replacement alongside the orphan. Fail the
		// reservation instead so the key is retained in a recoverable state
		// and a retry reclaims through the DO's serialized path.
		(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
			existing: false,
			puzzleId: 'reserved-uuid',
			status: 'pending'
		});
		(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('KV write failed')
		);
		(storage.deleteOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: false,
			error: new Error('R2 cleanup failed')
		});
		(storage.failIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(storage.releaseIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		const mockEnv = {
			ADMIN_PASSKEY: 'test-passkey',
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLES_BUCKET: {} as R2Bucket,
			// Committed + processing now probes workflow liveness before
			// acknowledging 200 (P2 #3/#4). The puzzle is genuinely live,
			// so the workflow reports 'running'.
			PUZZLE_WORKFLOW: {
				create: vi.fn(),
				get: vi.fn(async () => ({
					status: vi.fn().mockResolvedValue({ status: 'running' })
				}))
			},
			PUZZLE_METADATA_DO: {} as DurableObjectNamespace
		};

		const formData = new FormData();
		formData.append('name', 'Test Puzzle');
		formData.append('pieceCount', '225');
		const blob = new Blob([PNG_HEADER], { type: 'image/png' });
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: {
				cookie: 'session=valid.token',
				'Idempotency-Key': 'abc123def456'
			},
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		// R2 cleanup attempted.
		expect(storage.deleteOriginalImage).toHaveBeenCalledTimes(1);
		// Reservation FAILED (not released) because R2 cleanup failed.
		expect(storage.failIdempotencyKey).toHaveBeenCalledWith(
			mockEnv.PUZZLE_METADATA_DO,
			'abc123def456',
			'reserved-uuid'
		);
		expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
	});

	it('releases reservation when R2 image cleanup succeeds after metadata creation failure', async () => {
		// When metadata creation fails but R2 image cleanup SUCCEEDS, there
		// is no orphan — release the reservation so a retry can create fresh.
		(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
			existing: false,
			puzzleId: 'reserved-uuid',
			status: 'pending'
		});
		(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('KV write failed')
		);
		(storage.deleteOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: true
		});
		(storage.releaseIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(storage.failIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		const mockEnv = {
			ADMIN_PASSKEY: 'test-passkey',
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLES_BUCKET: {} as R2Bucket,
			PUZZLE_WORKFLOW: { create: vi.fn() },
			PUZZLE_METADATA_DO: {} as DurableObjectNamespace
		};

		const formData = new FormData();
		formData.append('name', 'Test Puzzle');
		formData.append('pieceCount', '225');
		const blob = new Blob([PNG_HEADER], { type: 'image/png' });
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: {
				cookie: 'session=valid.token',
				'Idempotency-Key': 'abc123def456'
			},
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		// Reservation released (cleanup succeeded, no orphan).
		expect(storage.releaseIdempotencyKey).toHaveBeenCalledWith(
			mockEnv.PUZZLE_METADATA_DO,
			'abc123def456',
			'reserved-uuid'
		);
		expect(storage.failIdempotencyKey).not.toHaveBeenCalled();
	});
});

describe('Admin Routes - GET /puzzles', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const mockEnv = {
		ADMIN_PASSKEY: 'test-passkey',
		JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
		PUZZLE_METADATA: {} as KVNamespace
	};

	it('should return list of puzzles', async () => {
		const mockPuzzleList = [
			{ id: '550e8400-e29b-41d4-a716-446655440000', name: 'Test', pieceCount: 4, status: 'ready' }
		];
		(storage.listPuzzles as ReturnType<typeof vi.fn>).mockResolvedValue({
			puzzles: mockPuzzleList
		});

		const req = new Request('http://localhost/puzzles', {
			method: 'GET',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.puzzles).toEqual(mockPuzzleList);
	});

	it('should return 500 when listPuzzles throws', async () => {
		(storage.listPuzzles as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('KV error'));

		const req = new Request('http://localhost/puzzles', {
			method: 'GET',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
	});
});

describe('Admin Routes - Force Delete', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const mockEnv = {
		ADMIN_PASSKEY: 'test-passkey',
		JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
		PUZZLE_METADATA: {} as KVNamespace,
		PUZZLE_METADATA_DO: {} as DurableObjectNamespace,
		PUZZLES_BUCKET: {} as R2Bucket,
		// Workflow already in a terminal state — terminateAndAwaitStopped
		// reads status first and returns true immediately without calling
		// terminate(), so the safe lifecycle proceeds to tombstone + R2 + KV.
		PUZZLE_WORKFLOW: {
			get: vi.fn().mockResolvedValue({
				status: vi.fn().mockResolvedValue({ status: 'errored' }),
				terminate: vi.fn()
			})
		}
	};

	it('should allow force deletion of processing puzzle with force=true', async () => {
		(storage.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: '550e8400-e29b-41d4-a716-446655440000',
			name: 'Stuck Puzzle',
			pieceCount: 4,
			status: 'processing',
			pieces: [],
			version: 0
		});
		(storage.deletePuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: true
		});
		(storage.deletePuzzleAssets as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: true,
			failedKeys: []
		});

		const req = new Request(
			'http://localhost/puzzle-delete/550e8400-e29b-41d4-a716-446655440000?force=true',
			{
				method: 'POST',
				headers: { cookie: 'session=valid.token' }
			}
		);

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(204);
		// Safe lifecycle: workflow terminated (confirmed stopped), DO
		// tombstoned, R2 deleted, then KV deleted — not the old KV-first
		// ordering that could resurrect a deleted processing puzzle.
		expect(storage.deleteMetadataDO).toHaveBeenCalledWith(
			mockEnv.PUZZLE_METADATA_DO,
			'550e8400-e29b-41d4-a716-446655440000'
		);
		expect(storage.deletePuzzleAssets).toHaveBeenCalledWith(
			mockEnv.PUZZLES_BUCKET,
			'550e8400-e29b-41d4-a716-446655440000',
			4
		);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(
			mockEnv.PUZZLE_METADATA,
			'550e8400-e29b-41d4-a716-446655440000'
		);
	});

	it('should defer to reaper when force-delete cannot confirm workflow stopped', async () => {
		// Workflow status read fails — terminateAndAwaitStopped returns false,
		// so the route tombstones the DO best-effort, writes a cleanup record,
		// and defers R2/KV cleanup to the reaper instead of deleting assets
		// while the workflow may still be writing to R2.
		(storage.getPuzzle as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: '550e8400-e29b-41d4-a716-446655440000',
			name: 'Stuck Puzzle',
			pieceCount: 4,
			status: 'processing',
			pieces: [],
			version: 0
		});
		const failingEnv = {
			...mockEnv,
			PUZZLE_WORKFLOW: {
				get: vi.fn().mockResolvedValue({
					status: vi.fn().mockRejectedValue(new Error('workflow API unavailable')),
					terminate: vi.fn()
				})
			}
		};

		const req = new Request(
			'http://localhost/puzzle-delete/550e8400-e29b-41d4-a716-446655440000?force=true',
			{
				method: 'POST',
				headers: { cookie: 'session=valid.token' }
			}
		);

		const res = await admin.fetch(req, failingEnv as any);

		expect(res.status).toBe(500);
		// Best-effort DO tombstone attempted before deferring.
		expect(storage.deleteMetadataDO).toHaveBeenCalled();
		// Cleanup record written so the reaper retries after the workflow
		// finally terminates.
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			mockEnv.PUZZLE_METADATA,
			expect.objectContaining({ puzzleId: '550e8400-e29b-41d4-a716-446655440000' })
		);
		// R2 and KV are NOT touched — the workflow may still write R2
		// objects, and KV must remain so the reaper can discover the puzzle.
		expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
		expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
	});
});

describe('Admin Routes - Category Validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const mockEnv = {
		ADMIN_PASSKEY: 'test-passkey',
		JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
		PUZZLE_METADATA: {} as KVNamespace,
		PUZZLES_BUCKET: {} as R2Bucket,
		PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) }
	};

	it('should return 400 for an invalid category', async () => {
		const formData = new FormData();
		formData.append('name', 'Test Puzzle');
		formData.append('pieceCount', '225');
		formData.append('category', 'InvalidCategory');
		const blob = new Blob([PNG_HEADER], { type: 'image/png' });
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBe('bad_request');
		expect(body.message).toContain('Invalid category');
	});

	it('should accept a valid category and return 201', async () => {
		(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		const formData = new FormData();
		formData.append('name', 'Nature Puzzle');
		formData.append('pieceCount', '225');
		formData.append('category', 'Nature');
		const blob = new Blob([PNG_HEADER], { type: 'image/png' });
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(201);
		expect(storage.createPuzzleMetadata).toHaveBeenCalledWith(
			mockEnv.PUZZLE_METADATA,
			expect.objectContaining({ category: 'Nature' })
		);
	});
});
