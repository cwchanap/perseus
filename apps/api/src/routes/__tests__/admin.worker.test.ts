/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbContextMock = vi.hoisted(() => ({
	db: {},
	completionWrites: {
		write: vi.fn(),
		deletePuzzleCompletionData: vi.fn(async () => undefined),
		beginPuzzleDeletion: vi.fn(async () => undefined),
		finishPuzzleDeletion: vi.fn(async () => undefined),
		isPuzzleTombstoned: vi.fn().mockResolvedValue(false)
	}
}));

// Mock storage before importing admin
vi.mock('../../services/storage.worker', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/storage.worker')>();
	return {
		...actual,
		getPuzzle: vi.fn(),
		getFamily: vi.fn(),
		deletePuzzleAssets: vi.fn(),
		deleteFamilyCleanupAssets: vi.fn().mockResolvedValue({ success: true, failedKeys: [] }),
		deletePuzzleMetadata: vi.fn().mockResolvedValue({ success: true }),
		createPuzzleMetadata: vi.fn().mockResolvedValue(undefined),
		createFamilyMetadata: vi.fn().mockResolvedValue(undefined),
		deleteFamilyMetadata: vi.fn().mockResolvedValue({ success: true }),
		uploadOriginalImage: vi.fn().mockResolvedValue(undefined),
		deleteOriginalImage: vi.fn().mockResolvedValue({ success: true }),
		originalImageExists: vi.fn().mockResolvedValue(false),
		puzzleExists: vi.fn().mockResolvedValue(false),
		listFamilies: vi.fn(),
		enrichFamilySummary: vi.fn(),
		reserveIdempotencyKey: vi.fn(),
		commitIdempotencyKey: vi.fn(),
		failIdempotencyKey: vi.fn(),
		releaseIdempotencyKey: vi.fn(),
		deleteMetadataDO: vi.fn().mockResolvedValue(undefined),
		writeCleanupRecord: vi.fn().mockResolvedValue(undefined),
		deleteCleanupRecord: vi.fn().mockResolvedValue(undefined)
	};
});

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

import {
	cleanupRecordMatcher,
	makeFamilyMetadata,
	PIECE_COUNTS_1_1,
	variantIdsForFamily,
	DELETE_FAMILY_ID
} from './helpers/family-fixtures';
import admin from '../admin.worker';
import * as storage from '../../services/storage.worker';
import * as playerAuth from '../../services/player-auth.worker';
import {
	insertPuzzleFamilyOwnership,
	deletePuzzleFamilyOwnership,
	SYSTEM_OWNER_ID
} from '@perseus/shared';

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

describe('Admin Routes - Removed application auth endpoints', () => {
	it.each([
		['POST', '/login'],
		['GET', '/session'],
		['POST', '/logout']
	])('returns 404 for %s %s', async (method, path) => {
		const res = await admin.fetch(new Request(`http://localhost${path}`, { method }), {} as never);

		expect(res.status).toBe(404);
	});
});

describe('Admin Routes - Puzzle Deletion', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('DELETE /puzzle-family-delete/:familyId', () => {
		it('should return 500 when some assets fail to delete', async () => {
			const familyId = DELETE_FAMILY_ID;
			(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue(
				makeFamilyMetadata(familyId, 'ready')
			);
			(storage.deleteFamilyCleanupAssets as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: false,
				failedKeys: ['puzzles/test-puzzle/pieces/0.png', 'puzzles/test-puzzle/pieces/1.png']
			});

			const mockEnv = {
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket
			};

			const req = new Request(`http://localhost/puzzle-family-delete/${familyId}`, {
				method: 'POST',
				headers: { cookie: 'session=valid.token' }
			});

			const res = await admin.fetch(req, mockEnv);

			expect(res.status).toBe(500);
			const body = (await res.json()) as any;
			expect(body.error).toBe('internal_error');
			expect(body.message).toContain('R2 cleanup partial');
			expect(body).not.toHaveProperty('partialSuccess');
			expect(body).not.toHaveProperty('failedAssets');
			expect(storage.deleteFamilyMetadata).not.toHaveBeenCalled();
			expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				cleanupRecordMatcher(familyId)
			);
			for (const difficulty of ['easy', 'normal', 'hard'] as const) {
				expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
					`${familyId}-${difficulty}`,
					expect.any(Number)
				);
			}
			expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
			const { deletePuzzleFamilyOwnership } = await import('@perseus/shared');
			expect(deletePuzzleFamilyOwnership).not.toHaveBeenCalled();
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

	describe('POST /puzzle-families', () => {
		it('should reject pieceCount in the form', async () => {
			const mockEnv = {
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
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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
			expect(body.message).toMatch(/pieceCount/i);
		});

		it('should accept a portrait aspect ratio and store matching grid metadata', async () => {
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn().mockResolvedValue(undefined)
				}
			};

			const formData = new FormData();
			formData.append('name', 'Portrait Puzzle');
			formData.append('aspectRatio', '3:4');
			const blob = new Blob([PNG_3X4], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
				method: 'POST',
				headers: {
					cookie: 'session=valid.token'
				},
				body: formData
			});

			const res = await admin.fetch(req, mockEnv as any);

			expect(res.status).toBe(201);
			expect(storage.createFamilyMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.objectContaining({
					name: 'Portrait Puzzle',
					aspectRatio: '3:4'
				})
			);
			expect(storage.createPuzzleMetadata).toHaveBeenCalledTimes(3);
			// Admin-created puzzles are mirrored into D1 with a system sentinel
			// owner so listPlayerStats can resolve their names.
			expect(insertPuzzleFamilyOwnership).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					ownerId: SYSTEM_OWNER_ID,
					name: 'Portrait Puzzle',
					aspectRatio: '3:4',
					status: 'processing'
				})
			);
		});

		it('rejects a tombstoned generated ID before publishing Worker data', async () => {
			const generatedId = '550e8400-e29b-41d4-a716-446655440000';
			const uuidSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValue(generatedId);
			dbContextMock.completionWrites.isPuzzleTombstoned.mockResolvedValueOnce(true);
			const mockEnv = {
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn()
				}
			};
			const formData = new FormData();
			formData.append('name', 'Tombstoned Puzzle');
			formData.append('aspectRatio', '3:4');
			formData.append('image', new Blob([PNG_3X4], { type: 'image/png' }), 'test.png');

			try {
				const res = await admin.fetch(
					new Request('http://localhost/puzzle-families', {
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
				expect(insertPuzzleFamilyOwnership).not.toHaveBeenCalled();
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
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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

			const createdFamilyMetadata = (storage.createFamilyMetadata as ReturnType<typeof vi.fn>).mock
				.calls[0][1];

			expect(storage.deleteFamilyMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				createdFamilyMetadata.id
			);
			expect(storage.deletePuzzleMetadata).toHaveBeenCalledTimes(3);
			expect(storage.deleteOriginalImage).toHaveBeenCalledWith(
				mockEnv.PUZZLES_BUCKET,
				createdFamilyMetadata.id
			);
			// Ownership row inserted before the workflow trigger must also be cleaned up.
			expect(deletePuzzleFamilyOwnership).toHaveBeenCalledWith(
				expect.anything(),
				createdFamilyMetadata.id
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
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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
			const createdFamilyMetadata = (storage.createFamilyMetadata as ReturnType<typeof vi.fn>).mock
				.calls[0][1];

			expect(storage.deleteFamilyMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				createdFamilyMetadata.id
			);
			expect(storage.deletePuzzleMetadata).toHaveBeenCalledTimes(3);
			expect(storage.deleteOriginalImage).toHaveBeenCalledWith(
				mockEnv.PUZZLES_BUCKET,
				createdFamilyMetadata.id
			);
			// Ownership row inserted before the workflow binding check must also be cleaned up.
			expect(deletePuzzleFamilyOwnership).toHaveBeenCalledWith(
				expect.anything(),
				createdFamilyMetadata.id
			);
		});
	});
});

describe('Admin Routes - Magic Bytes Validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('POST /puzzle-families', () => {
		it('should reject file with spoofed MIME type but invalid magic bytes', async () => {
			const mockEnv = {
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn()
				}
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			// File claims to be PNG but has invalid magic bytes
			const blob = new Blob(['fake image data'], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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
			const blob = new Blob([jpegHeader], { type: 'image/jpeg' });
			formData.append('image', blob, 'test.jpg');

			const req = new Request('http://localhost/puzzle-families', {
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
				familyId: 'original-uuid'
			});
			(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue(existingPuzzle);

			const mockEnv = {
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: { create: vi.fn() },
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: { create: vi.fn() }
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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
				familyId: 'new-uuid',
				status: 'pending'
			});
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createFamilyMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.commitIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) },
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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
			expect(storage.createFamilyMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.objectContaining({ id: 'new-uuid', idempotencyKey: 'abc123def456' })
			);
			expect(storage.createPuzzleMetadata).toHaveBeenCalledTimes(3);
		});

		it('fails reservation (not release) when metadata cleanup fails after workflow trigger', async () => {
			// When the workflow trigger fails AND metadata cleanup also fails,
			// the reservation must be FAILED (not released) so a retry reclaims
			// through the DO's serialized path. Releasing would let a same-key
			// retry mint a replacement alongside the orphaned processing
			// metadata. The orphan remains in KV for operator force-delete.
			(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
				existing: false,
				familyId: 'reserved-uuid',
				status: 'pending'
			});
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createFamilyMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.deleteFamilyMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: false,
				error: new Error('KV delete failed')
			});
			(storage.deleteOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true
			});
			(storage.failIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
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
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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
				familyId: 'reserved-uuid',
				status: 'pending'
			});
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createFamilyMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.deleteFamilyMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true
			});
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
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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
				familyId: 'reserved-uuid',
				status: 'pending'
			});
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createFamilyMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.deleteFamilyMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true
			});
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
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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
				familyId: 'original-uuid',
				status: 'pending'
			});
			(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue(null);

			const mockEnv = {
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: { create: vi.fn() },
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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
				familyId: 'original-uuid',
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
			(storage.getFamily as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce(null)
				.mockResolvedValue(existingPuzzle);

			const mockEnv = {
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
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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
					familyId: 'deleted-uuid',
					status: 'committed'
				})
				.mockResolvedValueOnce({
					existing: false,
					familyId: 'replacement-uuid',
					status: 'pending'
				});
			// Both reads (initial + retry) return null — puzzle is gone.
			(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue(null);
			(storage.releaseIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createFamilyMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.commitIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) },
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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
			// Created a replacement family under the re-reserved id.
			expect(storage.createFamilyMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.objectContaining({ id: 'replacement-uuid' })
			);
		});

		it('should 409 (not release) when R2 probe fails for a stale committed reservation', async () => {
			// A transient R2 `head` failure must NOT be interpreted as "object
			// gone" — that would release the reservation and mint a duplicate
			// of a live puzzle. Fail closed: 409 so the client retries.
			(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				existing: true,
				familyId: 'live-uuid',
				status: 'committed'
			});
			(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue(null);
			(storage.originalImageExists as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
				new Error('R2 internal error')
			);
			(storage.releaseIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) },
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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
					familyId: 'failed-uuid',
					status: 'committed'
				})
				.mockResolvedValueOnce({
					existing: false,
					familyId: 'replacement-uuid',
					status: 'pending'
				});
			(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: 'failed-uuid',
				name: 'Test Puzzle',
				status: 'failed',
				aspectRatio: '1:1',
				variants: {
					easy: '423e4567-e89b-42d3-a456-426614174010',
					normal: '523e4567-e89b-42d3-a456-426614174011',
					hard: '623e4567-e89b-42d3-a456-426614174012'
				},
				createdAt: 1700000000000
			});
			(storage.failIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createFamilyMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.commitIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) },
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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
			// Created a replacement family under the re-reserved id.
			expect(storage.createFamilyMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.objectContaining({ id: 'replacement-uuid' })
			);
			expect(mockEnv.PUZZLE_WORKFLOW.create).toHaveBeenCalledWith({
				id: 'replacement-uuid',
				params: { familyId: 'replacement-uuid' }
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
					familyId: 'failed-uuid',
					status: 'committed'
				})
				.mockResolvedValueOnce({
					existing: true,
					familyId: 'deleted-uuid',
					status: 'committed'
				})
				.mockResolvedValueOnce({
					existing: false,
					familyId: 'fresh-uuid',
					status: 'pending'
				});
			// First getPuzzle ('failed-uuid') returns failed metadata; second
			// ('deleted-uuid') returns null (puzzle was deleted).
			(storage.getFamily as ReturnType<typeof vi.fn>)
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
			(storage.createFamilyMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.commitIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			const mockEnv = {
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) },
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Test Puzzle');
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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
			// reclaimed.familyId was the bug.
			expect(storage.createFamilyMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.objectContaining({ id: 'fresh-uuid' })
			);
			expect(mockEnv.PUZZLE_WORKFLOW.create).toHaveBeenCalledWith({
				id: 'fresh-uuid',
				params: { familyId: 'fresh-uuid' }
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
				familyId: 'original-uuid',
				status: 'pending'
			});
			(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue({
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
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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
				familyId: 'new-uuid',
				status: 'pending'
			});
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.commitIdempotencyKey as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('DO unavailable')
			);

			const terminateFn = vi.fn().mockResolvedValue(undefined);
			const mockEnv = {
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
			const blob = new Blob([PNG_HEADER], { type: 'image/png' });
			formData.append('image', blob, 'test.png');

			const req = new Request('http://localhost/puzzle-families', {
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
			expect(storage.deleteFamilyMetadata).not.toHaveBeenCalled();
			expect(storage.deleteOriginalImage).not.toHaveBeenCalled();
		});

		it('fences and finishes a losing creation before removing its cleanup record', async () => {
			(storage.reserveIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
				existing: false,
				familyId: 'losing-uuid',
				status: 'pending'
			});
			(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createFamilyMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(storage.commitIdempotencyKey as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('Cannot committed reservation in status failed')
			);
			(storage.deleteFamilyCleanupAssets as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true,
				failedKeys: []
			});
			(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue(
				makeFamilyMetadata('losing-uuid', 'processing')
			);

			const mockEnv = {
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				PUZZLE_METADATA: {} as KVNamespace,
				PUZZLES_BUCKET: {} as R2Bucket,
				PUZZLE_WORKFLOW: {
					create: vi.fn().mockResolvedValue(undefined),
					get: vi.fn(async () => ({
						status: vi.fn().mockResolvedValue({ status: 'complete' })
					}))
				},
				PUZZLE_METADATA_DO: {} as DurableObjectNamespace
			};

			const formData = new FormData();
			formData.append('name', 'Losing Puzzle');
			formData.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'test.png');

			const response = await admin.fetch(
				new Request('http://localhost/puzzle-families', {
					method: 'POST',
					headers: {
						cookie: 'session=valid.token',
						'Idempotency-Key': 'losing-create-key'
					},
					body: formData
				}),
				mockEnv as any
			);

			expect(response.status).toBe(500);
			for (const difficulty of ['easy', 'normal', 'hard'] as const) {
				expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
					`losing-uuid-${difficulty}`,
					expect.any(Number)
				);
				expect(dbContextMock.completionWrites.finishPuzzleDeletion).toHaveBeenCalledWith(
					`losing-uuid-${difficulty}`
				);
			}
			expect(
				dbContextMock.completionWrites.beginPuzzleDeletion.mock.invocationCallOrder[0]
			).toBeLessThan(
				(storage.deleteMetadataDO as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
			);
			expect(
				dbContextMock.completionWrites.finishPuzzleDeletion.mock.invocationCallOrder[0]
			).toBeLessThan(
				(storage.deleteCleanupRecord as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
			);
			expect(deletePuzzleFamilyOwnership).toHaveBeenCalledWith(dbContextMock.db, 'losing-uuid');
		});
	});
});

describe('Admin Routes - Delete Puzzle Cases', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		dbContextMock.completionWrites.beginPuzzleDeletion.mockResolvedValue(undefined);
		dbContextMock.completionWrites.finishPuzzleDeletion.mockResolvedValue(undefined);
	});

	const familyId = DELETE_FAMILY_ID;

	function metadataKvWithRaw(raw: string | null): KVNamespace {
		return { get: vi.fn().mockResolvedValue(raw) } as unknown as KVNamespace;
	}

	it('should return 400 for invalid UUID', async () => {
		const req = new Request('http://localhost/puzzle-family-delete/not-a-uuid', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLES_BUCKET: {} as R2Bucket
		} as any);

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBe('bad_request');
	});

	it('should return 404 when puzzle not found', async () => {
		(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		const mockEnv = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			PUZZLE_METADATA: metadataKvWithRaw(null),
			PUZZLES_BUCKET: {} as R2Bucket
		};

		const req = new Request(`http://localhost/puzzle-family-delete/${familyId}`, {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
	});

	it('should return 500 when family metadata is corrupt', async () => {
		(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		const mockEnv = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			PUZZLE_METADATA: metadataKvWithRaw('{"invalid": true}'),
			PUZZLES_BUCKET: {} as R2Bucket
		};

		const req = new Request(`http://localhost/puzzle-family-delete/${familyId}`, {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.message).toContain('corrupt');
		expect(storage.deleteFamilyCleanupAssets).not.toHaveBeenCalled();
	});

	it('should return 404 when family metadata key is absent', async () => {
		(storage.getFamily as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('Corrupt puzzle metadata')
		);
		const mockEnv = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			PUZZLE_METADATA: metadataKvWithRaw(null),
			PUZZLES_BUCKET: {} as R2Bucket
		};

		const req = new Request(`http://localhost/puzzle-family-delete/${familyId}`, {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
	});

	it('should return 409 when puzzle is processing', async () => {
		(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue(
			makeFamilyMetadata(familyId, 'processing')
		);
		const mockEnv = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLES_BUCKET: {} as R2Bucket
		};

		const req = new Request(`http://localhost/puzzle-family-delete/${familyId}`, {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(409);
		const body = (await res.json()) as any;
		expect(body.error).toBe('conflict');
	});

	it('should return 204 on successful deletion', async () => {
		(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue(
			makeFamilyMetadata(familyId, 'ready')
		);
		const mockEnv = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLES_BUCKET: {} as R2Bucket
		};

		const req = new Request(`http://localhost/puzzle-family-delete/${familyId}`, {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(204);
		const { getWorkerDbContext } = await import('../../db.worker');
		expect(getWorkerDbContext).toHaveBeenCalledWith(mockEnv);
		expect(deletePuzzleFamilyOwnership).toHaveBeenCalledWith(dbContextMock.db, familyId);
		for (const difficulty of ['easy', 'normal', 'hard'] as const) {
			expect(dbContextMock.completionWrites.finishPuzzleDeletion).toHaveBeenCalledWith(
				`${familyId}-${difficulty}`
			);
			expect(dbContextMock.completionWrites.beginPuzzleDeletion).toHaveBeenCalledWith(
				`${familyId}-${difficulty}`,
				expect.any(Number)
			);
		}
		expect(
			dbContextMock.completionWrites.beginPuzzleDeletion.mock.invocationCallOrder[0]
		).toBeLessThan(
			(storage.deleteMetadataDO as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
		);
		expect(
			(storage.deleteFamilyMetadata as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
		).toBeLessThan(dbContextMock.completionWrites.finishPuzzleDeletion.mock.invocationCallOrder[0]);
		expect(
			dbContextMock.completionWrites.finishPuzzleDeletion.mock.invocationCallOrder[0]
		).toBeLessThan(
			(storage.deleteCleanupRecord as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
		);
	});

	it('returns retriable 500 and retains the fence when completion cleanup fails', async () => {
		(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue(
			makeFamilyMetadata(familyId, 'ready')
		);
		dbContextMock.completionWrites.finishPuzzleDeletion.mockRejectedValueOnce(
			new Error('D1 completion cleanup failed')
		);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const mockEnv = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLES_BUCKET: {} as R2Bucket
		};

		const req = new Request(`http://localhost/puzzle-family-delete/${familyId}`, {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		expect(deletePuzzleFamilyOwnership).toHaveBeenCalledWith(dbContextMock.db, familyId);
		expect(
			(storage.deleteFamilyMetadata as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
		).toBeLessThan(dbContextMock.completionWrites.finishPuzzleDeletion.mock.invocationCallOrder[0]);
		consoleSpy.mockRestore();
	});

	it('prevents DO, R2, and KV mutation when beginning the D1 fence fails', async () => {
		(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue(
			makeFamilyMetadata(familyId, 'ready')
		);
		dbContextMock.completionWrites.beginPuzzleDeletion.mockRejectedValueOnce(
			new Error('D1 unavailable')
		);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const mockEnv = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLES_BUCKET: {} as R2Bucket
		};

		const req = new Request(`http://localhost/puzzle-family-delete/${familyId}`, {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		expect(storage.writeCleanupRecord).toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		expect(storage.deleteFamilyCleanupAssets).not.toHaveBeenCalled();
		expect(storage.deleteFamilyMetadata).not.toHaveBeenCalled();
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it('returns retriable 500 and retains the record when ownership cleanup fails', async () => {
		(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue(
			makeFamilyMetadata(familyId, 'ready')
		);
		(deletePuzzleFamilyOwnership as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('ownership cleanup failed')
		);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const mockEnv = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLES_BUCKET: {} as R2Bucket
		};

		const req = new Request(`http://localhost/puzzle-family-delete/${familyId}`, {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		expect(dbContextMock.completionWrites.finishPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteCleanupRecord).not.toHaveBeenCalled();
		expect(deletePuzzleFamilyOwnership).toHaveBeenCalledTimes(1);
		expect(consoleSpy).toHaveBeenCalledWith(
			`Failed to finish fenced cleanup for ${familyId}:`,
			expect.any(Error)
		);
		expect(storage.deleteFamilyCleanupAssets).toHaveBeenCalledTimes(1);
		consoleSpy.mockRestore();
	});
});

describe('Admin Routes - Metadata Creation Failure Cleanup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should cleanup R2 image when metadata creation fails', async () => {
		(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(storage.createFamilyMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('KV write failed')
		);
		(storage.deleteOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: true
		});

		const mockEnv = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLES_BUCKET: {} as R2Bucket,
			PUZZLE_WORKFLOW: { create: vi.fn() }
		};

		const formData = new FormData();
		formData.append('name', 'Test Puzzle');
		const blob = new Blob([PNG_HEADER], { type: 'image/png' });
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzle-families', {
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
			familyId: 'reserved-uuid',
			status: 'pending'
		});
		(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(storage.createFamilyMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
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
		const blob = new Blob([PNG_HEADER], { type: 'image/png' });
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzle-families', {
			method: 'POST',
			headers: {
				cookie: 'session=valid.token',
				'Idempotency-Key': 'abc123def456'
			},
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		expect(storage.deleteFamilyMetadata).toHaveBeenCalledWith(
			mockEnv.PUZZLE_METADATA,
			'reserved-uuid'
		);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledTimes(3);
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
			familyId: 'reserved-uuid',
			status: 'pending'
		});
		(storage.uploadOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(storage.createFamilyMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(storage.createPuzzleMetadata as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('KV write failed')
		);
		(storage.deleteOriginalImage as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: true
		});
		(storage.releaseIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(storage.failIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

		const mockEnv = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLES_BUCKET: {} as R2Bucket,
			PUZZLE_WORKFLOW: { create: vi.fn() },
			PUZZLE_METADATA_DO: {} as DurableObjectNamespace
		};

		const formData = new FormData();
		formData.append('name', 'Test Puzzle');
		const blob = new Blob([PNG_HEADER], { type: 'image/png' });
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzle-families', {
			method: 'POST',
			headers: {
				cookie: 'session=valid.token',
				'Idempotency-Key': 'abc123def456'
			},
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		expect(storage.deleteFamilyMetadata).toHaveBeenCalledWith(
			mockEnv.PUZZLE_METADATA,
			'reserved-uuid'
		);
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledTimes(3);
		// Reservation released (cleanup succeeded, no orphan).
		expect(storage.releaseIdempotencyKey).toHaveBeenCalledWith(
			mockEnv.PUZZLE_METADATA_DO,
			'abc123def456',
			'reserved-uuid'
		);
		expect(storage.failIdempotencyKey).not.toHaveBeenCalled();
	});
});

describe('Admin Routes - GET /puzzle-families', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const mockEnv = {
		JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
		PUZZLE_METADATA: {} as KVNamespace
	};

	it('returns the full family list without an application session cookie', async () => {
		const familyId = '550e8400-e29b-41d4-a716-446655440000';
		const family = makeFamilyMetadata(familyId, 'ready');
		const enriched = {
			id: familyId,
			name: 'Test',
			aspectRatio: '1:1' as const,
			status: 'ready' as const,
			createdAt: family.createdAt,
			variants: {
				easy: {
					id: family.variants.easy,
					difficulty: 'easy' as const,
					pieceCount: 16,
					status: 'ready' as const
				},
				normal: {
					id: family.variants.normal,
					difficulty: 'normal' as const,
					pieceCount: 49,
					status: 'ready' as const
				},
				hard: {
					id: family.variants.hard,
					difficulty: 'hard' as const,
					pieceCount: 100,
					status: 'ready' as const
				}
			}
		};
		(storage.listFamilies as ReturnType<typeof vi.fn>).mockResolvedValue({
			families: [
				{
					id: familyId,
					name: 'Test',
					status: 'ready',
					createdAt: family.createdAt,
					aspectRatio: '1:1'
				}
			]
		});
		(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue(family);
		(storage.enrichFamilySummary as ReturnType<typeof vi.fn>).mockResolvedValue(enriched);

		const req = new Request('http://localhost/puzzle-families');

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.families).toEqual([enriched]);
	});

	it('should return 500 when listFamilies throws', async () => {
		(storage.listFamilies as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('KV error'));

		const req = new Request('http://localhost/puzzle-families');

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string; message: string };
		expect(body).toEqual({ error: 'internal_error', message: 'Failed to list puzzle families' });
	});
});

describe('Admin Routes - Force Delete', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const mockEnv = {
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
		const forceFamilyId = DELETE_FAMILY_ID;
		(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue(
			makeFamilyMetadata(forceFamilyId, 'processing')
		);
		const mockEnv = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLE_METADATA_DO: {} as DurableObjectNamespace,
			PUZZLES_BUCKET: {} as R2Bucket,
			PUZZLE_WORKFLOW: {
				get: vi.fn().mockResolvedValue({
					status: vi.fn().mockResolvedValue({ status: 'errored' }),
					terminate: vi.fn()
				})
			}
		};

		const req = new Request(`http://localhost/puzzle-family-delete/${forceFamilyId}?force=true`, {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(204);
		expect(storage.deleteMetadataDO).toHaveBeenCalledWith(
			mockEnv.PUZZLE_METADATA_DO,
			forceFamilyId
		);
		expect(storage.deleteFamilyCleanupAssets).toHaveBeenCalledWith(
			mockEnv.PUZZLES_BUCKET,
			forceFamilyId,
			variantIdsForFamily(forceFamilyId),
			PIECE_COUNTS_1_1
		);
		expect(storage.deleteFamilyMetadata).toHaveBeenCalledWith(
			mockEnv.PUZZLE_METADATA,
			forceFamilyId
		);
	});

	it('should defer to reaper when force-delete cannot confirm workflow stopped', async () => {
		const forceFamilyId = DELETE_FAMILY_ID;
		(storage.getFamily as ReturnType<typeof vi.fn>).mockResolvedValue(
			makeFamilyMetadata(forceFamilyId, 'processing')
		);
		const baseForceEnv = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			PUZZLE_METADATA: {} as KVNamespace,
			PUZZLE_METADATA_DO: {} as DurableObjectNamespace,
			PUZZLES_BUCKET: {} as R2Bucket,
			PUZZLE_WORKFLOW: {
				get: vi.fn().mockResolvedValue({
					status: vi.fn().mockResolvedValue({ status: 'errored' }),
					terminate: vi.fn()
				})
			}
		};
		const failingEnv = {
			...baseForceEnv,
			PUZZLE_WORKFLOW: {
				get: vi.fn().mockResolvedValue({
					status: vi.fn().mockRejectedValue(new Error('workflow API unavailable')),
					terminate: vi.fn()
				})
			}
		};

		const req = new Request(`http://localhost/puzzle-family-delete/${forceFamilyId}?force=true`, {
			method: 'POST',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, failingEnv as any);

		expect(res.status).toBe(500);
		// Liveness is still uncertain, so deletion has not committed: neither
		// the D1 fence nor source mutations may occur.
		expect(dbContextMock.completionWrites.beginPuzzleDeletion).not.toHaveBeenCalled();
		expect(storage.deleteMetadataDO).not.toHaveBeenCalled();
		// Cleanup record written so the reaper retries after the workflow
		// finally terminates.
		expect(storage.writeCleanupRecord).toHaveBeenCalledWith(
			mockEnv.PUZZLE_METADATA,
			cleanupRecordMatcher('550e8400-e29b-41d4-a716-446655440000')
		);
		const workflow = await failingEnv.PUZZLE_WORKFLOW.get();
		expect(vi.mocked(storage.writeCleanupRecord).mock.invocationCallOrder[0]).toBeLessThan(
			workflow.status.mock.invocationCallOrder[0]
		);
		// R2 and KV are NOT touched — the workflow may still write R2
		// objects, and KV must remain so the reaper can discover the puzzle.
		expect(storage.deleteFamilyCleanupAssets).not.toHaveBeenCalled();
		expect(storage.deleteFamilyMetadata).not.toHaveBeenCalled();
	});
});

describe('Admin Routes - Category Validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const mockEnv = {
		JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
		PUZZLE_METADATA: {} as KVNamespace,
		PUZZLES_BUCKET: {} as R2Bucket,
		PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) }
	};

	it('should return 400 for an invalid category', async () => {
		const formData = new FormData();
		formData.append('name', 'Test Puzzle');
		formData.append('category', 'InvalidCategory');
		const blob = new Blob([PNG_HEADER], { type: 'image/png' });
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzle-families', {
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
		formData.append('category', 'Nature');
		const blob = new Blob([PNG_HEADER], { type: 'image/png' });
		formData.append('image', blob, 'test.png');

		const req = new Request('http://localhost/puzzle-families', {
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
