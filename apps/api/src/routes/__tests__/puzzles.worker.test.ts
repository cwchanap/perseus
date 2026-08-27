/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import puzzles from '../puzzles.worker';
import * as storage from '../../services/storage.worker';
import * as playerAuth from '../../services/player-auth.worker';
import { insertPuzzleFamilyOwnership } from '@perseus/shared';

const dbContextMock = vi.hoisted(() => ({
	db: {},
	completionWrites: {
		isPuzzleTombstoned: vi.fn().mockResolvedValue(false)
	}
}));

vi.mock('../../db.worker', () => ({
	getWorkerDb: vi.fn(() => dbContextMock.db),
	getWorkerDbContext: vi.fn(() => dbContextMock)
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	return {
		...actual,
		validateImageEndMarker: vi.fn().mockResolvedValue(true),
		insertPuzzleFamilyOwnership: vi.fn().mockResolvedValue(undefined),
		deletePuzzleFamilyOwnership: vi.fn().mockResolvedValue(undefined),
		insertPuzzleOwnership: vi.fn().mockResolvedValue(undefined),
		deletePuzzleOwnership: vi.fn().mockResolvedValue(undefined)
	};
});

vi.mock('../../services/storage.worker', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/storage.worker')>();
	return {
		...actual,
		uploadOriginalImage: vi.fn(),
		createFamilyMetadata: vi.fn(),
		createPuzzleMetadata: vi.fn(),
		deleteFamilyMetadata: vi.fn(),
		deletePuzzleMetadata: vi.fn(),
		deleteOriginalImage: vi.fn(),
		getPuzzle: vi.fn(),
		listPuzzlesPage: vi.fn(),
		getImage: vi.fn(),
		resolveVariantReferenceKey: vi.fn()
	};
});
vi.mock('../../services/player-auth.worker', () => ({
	getPlayerSession: vi.fn()
}));

// Minimal valid PNG: 8-byte signature + 13-byte IHDR chunk (width=3, height=4, 3:4 ratio)
// PNG layout: [signature 8B][length 4B][IHDR 4B][width 4B][height 4B][depth+color+compress+filter+interlace 5B][CRC 4B]
const PNG_HEADER = new Uint8Array([
	0x89,
	0x50,
	0x4e,
	0x47,
	0x0d,
	0x0a,
	0x1a,
	0x0a, // PNG signature
	0x00,
	0x00,
	0x00,
	0x0d, // IHDR chunk length = 13
	0x49,
	0x48,
	0x44,
	0x52, // "IHDR"
	0x00,
	0x00,
	0x00,
	0x03, // width = 3
	0x00,
	0x00,
	0x00,
	0x04, // height = 4
	0x08,
	0x02,
	0x00,
	0x00,
	0x00, // bit depth=8, color type=2 (RGB), compression=0, filter=0, interlace=0
	0x45,
	0x48,
	0xcc,
	0x42 // CRC
]);

describe('Puzzle Routes - UUID Validation', () => {
	const mockEnv = {
		PUZZLE_METADATA: {} as KVNamespace,
		PUZZLES_BUCKET: {} as R2Bucket,
		PUZZLE_WORKFLOW: {
			create: vi.fn().mockResolvedValue({ id: 'workflow-id' })
		}
	};

	describe('POST / - Upload puzzle for player', () => {
		beforeEach(() => {
			dbContextMock.completionWrites.isPuzzleTombstoned.mockResolvedValue(false);
		});

		it('returns 401 when the player session cookie is missing', async () => {
			const formData = new FormData();
			formData.append('name', 'Player Puzzle');
			formData.append('pieceCount', '48');
			formData.append('aspectRatio', '3:4');
			formData.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'test.png');

			const res = await puzzles.fetch(
				new Request('http://localhost/', {
					method: 'POST',
					body: formData
				}),
				mockEnv as any
			);

			expect(res.status).toBe(401);
			const body = (await res.json()) as any;
			expect(body).toEqual({
				error: 'unauthorized',
				message: 'Player authentication required'
			});
			expect(storage.createPuzzleMetadata).not.toHaveBeenCalled();
		});

		it('creates a processing puzzle family when the player session is valid', async () => {
			vi.mocked(playerAuth.getPlayerSession).mockResolvedValue({
				sessionHash: 'session-hash',
				user: {
					id: 'player-1',
					email: 'player@example.com',
					createdAt: 1000,
					lastLoginAt: 2000
				},
				createdAt: 2000,
				expiresAt: Date.now() + 1000
			});
			vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
			vi.mocked(storage.createFamilyMetadata).mockResolvedValue(undefined);
			vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);

			const formData = new FormData();
			formData.append('name', 'Player Puzzle');
			formData.append('pieceCount', '48');
			formData.append('aspectRatio', '3:4');
			formData.append('category', 'Art');
			formData.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'test.png');

			const res = await puzzles.fetch(
				new Request('http://localhost/', {
					method: 'POST',
					headers: { Cookie: 'perseus_player_session=player-token' },
					body: formData
				}),
				mockEnv as any
			);

			expect(res.status).toBe(201);
			const body = (await res.json()) as any;
			expect(playerAuth.getPlayerSession).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				'player-token'
			);
			expect(storage.createFamilyMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.objectContaining({
					name: 'Player Puzzle',
					aspectRatio: '3:4',
					category: 'Art',
					status: 'processing'
				})
			);
			expect(storage.createPuzzleMetadata).toHaveBeenCalledTimes(3);
			expect(mockEnv.PUZZLE_WORKFLOW.create).toHaveBeenCalledWith({
				id: body.id,
				params: { familyId: body.id }
			});
			expect(insertPuzzleFamilyOwnership).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					ownerId: 'player-1',
					status: 'processing'
				})
			);
			expect(insertPuzzleFamilyOwnership).toHaveBeenCalledBefore(
				mockEnv.PUZZLE_WORKFLOW.create as any
			);
		});

		it('rejects a tombstoned generated ID before publishing Worker data', async () => {
			vi.clearAllMocks();
			vi.mocked(playerAuth.getPlayerSession).mockResolvedValue({
				sessionHash: 'session-hash',
				user: {
					id: 'player-1',
					email: 'player@example.com',
					createdAt: 1000,
					lastLoginAt: 2000
				},
				createdAt: 2000,
				expiresAt: Date.now() + 1000
			});
			const generatedId = '550e8400-e29b-41d4-a716-446655440000';
			const uuidSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValue(generatedId);
			dbContextMock.completionWrites.isPuzzleTombstoned.mockResolvedValue(true);
			const formData = new FormData();
			formData.append('name', 'Player Puzzle');
			formData.append('pieceCount', '48');
			formData.append('aspectRatio', '3:4');
			formData.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'test.png');

			try {
				const res = await puzzles.fetch(
					new Request('http://localhost/', {
						method: 'POST',
						headers: { Cookie: 'perseus_player_session=player-token' },
						body: formData
					}),
					mockEnv as any
				);

				expect(res.status).toBe(500);
				expect(await res.json()).toEqual({
					error: 'internal_error',
					message: 'Failed to allocate puzzle family ID'
				});
				expect(dbContextMock.completionWrites.isPuzzleTombstoned).toHaveBeenCalledWith(generatedId);
				expect(storage.uploadOriginalImage).not.toHaveBeenCalled();
				expect(storage.createFamilyMetadata).not.toHaveBeenCalled();
				expect(insertPuzzleFamilyOwnership).not.toHaveBeenCalled();
				expect(mockEnv.PUZZLE_WORKFLOW.create).not.toHaveBeenCalled();
			} finally {
				uuidSpy.mockRestore();
			}
		});

		it('rejects when dimensions cannot be parsed (corrupted or truncated)', async () => {
			vi.mocked(playerAuth.getPlayerSession).mockResolvedValue({
				sessionHash: 'session-hash',
				user: {
					id: 'player-1',
					email: 'player@example.com',
					createdAt: 1000,
					lastLoginAt: 2000
				},
				createdAt: 2000,
				expiresAt: Date.now() + 1000
			});

			// PNG with valid magic bytes but truncated (too short for parseImageDimensions)
			const truncatedPng = new Uint8Array([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00
			]);
			const formData = new FormData();
			formData.append('name', 'Truncated Puzzle');
			formData.append('pieceCount', '48');
			formData.append('aspectRatio', '3:4');
			formData.append('image', new Blob([truncatedPng], { type: 'image/png' }), 'test.png');

			const res = await puzzles.fetch(
				new Request('http://localhost/', {
					method: 'POST',
					headers: { Cookie: 'perseus_player_session=player-token' },
					body: formData
				}),
				mockEnv as any
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as any;
			expect(body.message).toBe('Image is corrupted or truncated');
		});

		it('rejects image with mismatched aspect ratio when dimensions are parseable', async () => {
			vi.mocked(playerAuth.getPlayerSession).mockResolvedValue({
				sessionHash: 'session-hash',
				user: {
					id: 'player-1',
					email: 'player@example.com',
					createdAt: 1000,
					lastLoginAt: 2000
				},
				createdAt: 2000,
				expiresAt: Date.now() + 1000
			});

			// Build a 4x4 PNG (1:1 ratio) but request 3:4 — should reject on aspect ratio mismatch
			const squarePng = new Uint8Array([
				0x89,
				0x50,
				0x4e,
				0x47,
				0x0d,
				0x0a,
				0x1a,
				0x0a, // PNG signature
				0x00,
				0x00,
				0x00,
				0x0d, // IHDR chunk length = 13
				0x49,
				0x48,
				0x44,
				0x52, // "IHDR"
				0x00,
				0x00,
				0x00,
				0x04, // width = 4
				0x00,
				0x00,
				0x00,
				0x04, // height = 4
				0x08,
				0x02,
				0x00,
				0x00,
				0x00, // bit depth=8, color type=2 (RGB), compression=0, filter=0, interlace=0
				0x00,
				0x00,
				0x00,
				0x00 // placeholder CRC
			]);
			const formData = new FormData();
			formData.append('name', 'Mismatched Puzzle');
			formData.append('pieceCount', '48');
			formData.append('aspectRatio', '3:4');
			formData.append('image', new Blob([squarePng], { type: 'image/png' }), 'test.png');

			const res = await puzzles.fetch(
				new Request('http://localhost/', {
					method: 'POST',
					headers: { Cookie: 'perseus_player_session=player-token' },
					body: formData
				}),
				mockEnv as any
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as any;
			expect(body.message).toContain('aspect ratio');
		});
	});

	describe('POST / - Validation rejections', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			vi.mocked(playerAuth.getPlayerSession).mockResolvedValue({
				sessionHash: 'session-hash',
				user: {
					id: 'player-1',
					email: 'player@example.com',
					createdAt: 1000,
					lastLoginAt: 2000
				},
				createdAt: 2000,
				expiresAt: Date.now() + 1000
			});
		});

		function buildForm(overrides: Record<string, any> = {}): FormData {
			const fd = new FormData();
			fd.append('name', overrides.name ?? 'Player Puzzle');
			fd.append('pieceCount', String(overrides.pieceCount ?? 48));
			fd.append('aspectRatio', overrides.aspectRatio ?? '3:4');
			if (overrides.category !== undefined) fd.append('category', overrides.category);
			fd.append(
				'image',
				overrides.image ?? new Blob([PNG_HEADER], { type: 'image/png' }),
				'test.png'
			);
			return fd;
		}

		async function post(fd: FormData, env: any = mockEnv): Promise<Response> {
			return puzzles.fetch(
				new Request('http://localhost/', {
					method: 'POST',
					headers: { Cookie: 'perseus_player_session=player-token' },
					body: fd
				}),
				env as any
			);
		}

		it('rejects when name is missing', async () => {
			const fd = buildForm({ name: '' });
			const res = await post(fd);
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).message).toContain('Name is required');
		});

		it('rejects when name exceeds 255 characters', async () => {
			const fd = buildForm({ name: 'x'.repeat(256) });
			const res = await post(fd);
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).message).toContain('255 characters');
		});

		it('rejects when pieceCount is missing', async () => {
			const fd = new FormData();
			fd.append('name', 'No Pieces');
			fd.append('aspectRatio', '3:4');
			fd.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'test.png');
			const res = await post(fd);
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).message).toContain('Piece count is required');
		});

		it('rejects when aspectRatio is invalid', async () => {
			const fd = buildForm({ aspectRatio: '5:6' });
			const res = await post(fd);
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).message).toContain('Invalid aspect ratio');
		});

		it('rejects when pieceCount is not an integer', async () => {
			const fd = buildForm({ pieceCount: 4.5 });
			const res = await post(fd);
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).message).toContain('Invalid piece count');
		});

		it('rejects when pieceCount is below minimum', async () => {
			const fd = buildForm({ pieceCount: 3 });
			const res = await post(fd);
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).message).toContain('Piece count must be between');
		});

		it('rejects when pieceCount is invalid for aspect ratio', async () => {
			// 50 is not a valid 1:1 piece count (must be a perfect square)
			const fd = buildForm({ pieceCount: 50, aspectRatio: '1:1' });
			const res = await post(fd);
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).message).toContain('Invalid piece count for 1:1');
		});

		it('rejects when image is missing', async () => {
			const fd = new FormData();
			fd.append('name', 'No Image');
			fd.append('pieceCount', '48');
			fd.append('aspectRatio', '3:4');
			const res = await post(fd);
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).message).toContain('Image file is required');
		});

		it('rejects when category is invalid', async () => {
			const fd = buildForm({ category: 'Bogus' });
			const res = await post(fd);
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).message).toContain('Invalid category');
		});

		it('rejects when file size exceeds 10MB', async () => {
			const oversized = new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/png' });
			const fd = buildForm({ image: oversized });
			const res = await post(fd);
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).message).toContain('10MB');
		});

		it('rejects when magic bytes do not match any allowed type', async () => {
			// text file with .png extension — MIME spoofing
			const textBlob = new Blob([new TextEncoder().encode('not an image')], {
				type: 'image/png'
			});
			const fd = buildForm({ image: textBlob });
			const res = await post(fd);
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).message).toContain('Invalid file type');
		});

		it('returns 400 when form data cannot be parsed', async () => {
			const res = await puzzles.fetch(
				new Request('http://localhost/', {
					method: 'POST',
					headers: {
						Cookie: 'perseus_player_session=player-token',
						'Content-Type': 'application/json'
					},
					body: '{"name":"oops"}'
				}),
				mockEnv as any
			);
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).message).toBe('Invalid form data');
		});
	});

	describe('POST / - Resource rollback', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			vi.mocked(playerAuth.getPlayerSession).mockResolvedValue({
				sessionHash: 'session-hash',
				user: {
					id: 'player-1',
					email: 'player@example.com',
					createdAt: 1000,
					lastLoginAt: 2000
				},
				createdAt: 2000,
				expiresAt: Date.now() + 1000
			});
			vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
			vi.mocked(storage.createFamilyMetadata).mockResolvedValue(undefined);
			vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);
			vi.mocked(storage.deleteFamilyMetadata).mockResolvedValue({ success: true });
			vi.mocked(storage.deleteOriginalImage).mockResolvedValue({ success: true });
			vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true });
			mockEnv.PUZZLE_WORKFLOW.create = vi.fn().mockResolvedValue({ id: 'workflow-id' });
		});

		function buildForm(): FormData {
			const fd = new FormData();
			fd.append('name', 'Rollback Puzzle');
			fd.append('pieceCount', '48');
			fd.append('aspectRatio', '3:4');
			fd.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'test.png');
			return fd;
		}

		async function post(fd: FormData, env: any = mockEnv): Promise<Response> {
			return puzzles.fetch(
				new Request('http://localhost/', {
					method: 'POST',
					headers: { Cookie: 'perseus_player_session=player-token' },
					body: fd
				}),
				env as any
			);
		}

		it('returns 500 when uploadOriginalImage throws', async () => {
			vi.mocked(storage.uploadOriginalImage).mockRejectedValue(new Error('R2 down'));
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const res = await post(buildForm());

			expect(res.status).toBe(500);
			expect(((await res.json()) as any).message).toBe('Failed to upload image');
			expect(storage.createPuzzleMetadata).not.toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('rolls back R2 image when createFamilyMetadata throws', async () => {
			vi.mocked(storage.createFamilyMetadata).mockRejectedValue(new Error('KV down'));
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const res = await post(buildForm());

			expect(res.status).toBe(500);
			expect(((await res.json()) as any).message).toBe('Failed to create puzzle metadata');
			expect(storage.deleteOriginalImage).toHaveBeenCalledWith(
				mockEnv.PUZZLES_BUCKET,
				expect.any(String)
			);
			expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
			expect(mockEnv.PUZZLE_WORKFLOW.create).not.toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('rolls back family and written variants when a later createPuzzleMetadata throws', async () => {
			vi.mocked(storage.createPuzzleMetadata)
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error('KV write failed'));
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const res = await post(buildForm());

			expect(res.status).toBe(500);
			expect(((await res.json()) as any).message).toBe('Failed to create puzzle metadata');
			expect(storage.deleteFamilyMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.any(String)
			);
			expect(storage.deletePuzzleMetadata).toHaveBeenCalledTimes(3);
			expect(storage.deleteOriginalImage).toHaveBeenCalledWith(
				mockEnv.PUZZLES_BUCKET,
				expect.any(String)
			);
			expect(mockEnv.PUZZLE_WORKFLOW.create).not.toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('returns 500 and rolls back when ownership insert fails (before workflow)', async () => {
			vi.mocked(insertPuzzleFamilyOwnership).mockRejectedValueOnce(new Error('D1 down'));
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const res = await post(buildForm());

			expect(res.status).toBe(500);
			expect(((await res.json()) as any).message).toBe('Failed to record puzzle ownership');
			expect(storage.deleteFamilyMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.any(String)
			);
			expect(storage.deletePuzzleMetadata).toHaveBeenCalled();
			expect(storage.deleteOriginalImage).toHaveBeenCalledWith(
				mockEnv.PUZZLES_BUCKET,
				expect.any(String)
			);
			expect(mockEnv.PUZZLE_WORKFLOW.create).not.toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('returns 503 and rolls back both resources when PUZZLE_WORKFLOW is missing', async () => {
			const envWithoutWorkflow = {
				PUZZLE_METADATA: mockEnv.PUZZLE_METADATA,
				PUZZLES_BUCKET: mockEnv.PUZZLES_BUCKET
			};
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const res = await post(buildForm(), envWithoutWorkflow);

			expect(res.status).toBe(503);
			expect(((await res.json()) as any).error).toBe('service_unavailable');
			expect(storage.deleteOriginalImage).toHaveBeenCalledWith(
				mockEnv.PUZZLES_BUCKET,
				expect.any(String)
			);
			expect(storage.deleteFamilyMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.any(String)
			);
			expect(storage.deletePuzzleMetadata).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('returns 503 when PUZZLE_WORKFLOW.create is not a function', async () => {
			const envWithBadWorkflow = {
				...mockEnv,
				PUZZLE_WORKFLOW: {} as any
			};
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const res = await post(buildForm(), envWithBadWorkflow);

			expect(res.status).toBe(503);
			expect(storage.deleteOriginalImage).toHaveBeenCalled();
			expect(storage.deletePuzzleMetadata).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('rolls back both resources when workflow.create throws', async () => {
			mockEnv.PUZZLE_WORKFLOW.create = vi.fn().mockRejectedValue(new Error('workflow down'));
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const res = await post(buildForm());

			expect(res.status).toBe(500);
			expect(((await res.json()) as any).message).toBe('Failed to start puzzle processing');
			expect(storage.deleteOriginalImage).toHaveBeenCalledWith(
				mockEnv.PUZZLES_BUCKET,
				expect.any(String)
			);
			expect(storage.deleteFamilyMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.any(String)
			);
			expect(storage.deletePuzzleMetadata).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('logs cleanup failures but still returns 500 when rollback fails', async () => {
			vi.mocked(storage.createFamilyMetadata).mockRejectedValue(new Error('KV down'));
			vi.mocked(storage.deleteOriginalImage).mockResolvedValue({
				success: false,
				error: new Error('R2 also down')
			});
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const res = await post(buildForm());

			expect(res.status).toBe(500);
			expect(consoleSpy).toHaveBeenCalledWith(
				'Failed to cleanup original image after metadata creation failure:',
				new Error('R2 also down')
			);
			consoleSpy.mockRestore();
		});
	});

	describe('GET / - List puzzles', () => {
		it('should return a paginated response with search and category filters', async () => {
			const result = {
				puzzles: [
					{
						id: '550e8400-e29b-41d4-a716-446655440001',
						name: 'Ready Puzzle',
						pieceCount: 4,
						status: 'ready'
					}
				],
				total: 1,
				offset: 10,
				limit: 5
			};
			vi.mocked(storage.listPuzzlesPage).mockResolvedValue(result as any);

			const req = new Request('http://localhost/?q=ready&category=Nature&offset=10&limit=5');
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(200);
			expect(body).toEqual(result);
			expect(vi.mocked(storage.listPuzzlesPage)).toHaveBeenCalledWith(mockEnv.PUZZLE_METADATA, {
				q: 'ready',
				category: 'Nature',
				offset: 10,
				limit: 5
			});
		});

		it('should pass undefined for invalid category and clamp offset and limit', async () => {
			vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
				puzzles: [],
				total: 0,
				offset: 0,
				limit: 20
			} as any);

			const req = new Request('http://localhost/?category=invalid&offset=-5&limit=200');
			const res = await puzzles.fetch(req, mockEnv);

			expect(res.status).toBe(200);
			expect(vi.mocked(storage.listPuzzlesPage)).toHaveBeenCalledWith(mockEnv.PUZZLE_METADATA, {
				q: undefined,
				category: undefined,
				offset: 0,
				limit: 20
			});
		});

		it('should parse offset and limit from query string', async () => {
			vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
				puzzles: [],
				total: 0,
				offset: 3,
				limit: 7
			} as any);

			const req = new Request('http://localhost/?offset=3&limit=7');
			const res = await puzzles.fetch(req, mockEnv);

			expect(res.status).toBe(200);
			expect(vi.mocked(storage.listPuzzlesPage)).toHaveBeenCalledWith(mockEnv.PUZZLE_METADATA, {
				q: undefined,
				category: undefined,
				offset: 3,
				limit: 7
			});
		});

		it('should return 500 when storage fails', async () => {
			vi.mocked(storage.listPuzzlesPage).mockRejectedValue(new Error('storage failure'));

			const req = new Request('http://localhost/');
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(500);
			expect(body.error).toBe('internal_error');
			expect(body.message).toBe('Failed to list puzzles');
		});

		it('should reject offset with trailing non-numeric characters', async () => {
			vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
				puzzles: [],
				total: 0,
				offset: 0,
				limit: 20
			} as any);

			const req = new Request('http://localhost/?offset=10abc');
			const res = await puzzles.fetch(req, mockEnv);

			expect(res.status).toBe(200);
			expect(vi.mocked(storage.listPuzzlesPage)).toHaveBeenCalledWith(mockEnv.PUZZLE_METADATA, {
				q: undefined,
				category: undefined,
				offset: 0,
				limit: 20
			});
		});

		it('should reject limit with trailing non-numeric characters', async () => {
			vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
				puzzles: [],
				total: 0,
				offset: 0,
				limit: 20
			} as any);

			const req = new Request('http://localhost/?limit=5foo');
			const res = await puzzles.fetch(req, mockEnv);

			expect(res.status).toBe(200);
			expect(vi.mocked(storage.listPuzzlesPage)).toHaveBeenCalledWith(mockEnv.PUZZLE_METADATA, {
				q: undefined,
				category: undefined,
				offset: 0,
				limit: 20
			});
		});

		it('should reject decimal offset and limit values', async () => {
			vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
				puzzles: [],
				total: 0,
				offset: 0,
				limit: 20
			} as any);

			const req = new Request('http://localhost/?offset=3.5&limit=7.9');
			const res = await puzzles.fetch(req, mockEnv);

			expect(res.status).toBe(200);
			expect(vi.mocked(storage.listPuzzlesPage)).toHaveBeenCalledWith(mockEnv.PUZZLE_METADATA, {
				q: undefined,
				category: undefined,
				offset: 0,
				limit: 20
			});
		});

		it('should reject scientific notation offset and limit', async () => {
			vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
				puzzles: [],
				total: 0,
				offset: 0,
				limit: 20
			} as any);

			const req = new Request('http://localhost/?offset=1e2&limit=2e1');
			const res = await puzzles.fetch(req, mockEnv);

			expect(res.status).toBe(200);
			expect(vi.mocked(storage.listPuzzlesPage)).toHaveBeenCalledWith(mockEnv.PUZZLE_METADATA, {
				q: undefined,
				category: undefined,
				offset: 0,
				limit: 20
			});
		});

		it('should reject hex offset and limit', async () => {
			vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
				puzzles: [],
				total: 0,
				offset: 0,
				limit: 20
			} as any);

			const req = new Request('http://localhost/?offset=0x10&limit=0xff');
			const res = await puzzles.fetch(req, mockEnv);

			expect(res.status).toBe(200);
			expect(vi.mocked(storage.listPuzzlesPage)).toHaveBeenCalledWith(mockEnv.PUZZLE_METADATA, {
				q: undefined,
				category: undefined,
				offset: 0,
				limit: 20
			});
		});

		it('should reject whitespace-padded offset and limit', async () => {
			vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
				puzzles: [],
				total: 0,
				offset: 0,
				limit: 20
			} as any);

			const req = new Request('http://localhost/?offset=%2010%20&limit=%205%20');
			const res = await puzzles.fetch(req, mockEnv);

			expect(res.status).toBe(200);
			expect(vi.mocked(storage.listPuzzlesPage)).toHaveBeenCalledWith(mockEnv.PUZZLE_METADATA, {
				q: undefined,
				category: undefined,
				offset: 0,
				limit: 20
			});
		});

		it('treats empty ?q= param as no filter (passes undefined, not empty string)', async () => {
			vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
				puzzles: [],
				total: 0,
				offset: 0,
				limit: 20
			} as any);

			const req = new Request('http://localhost/?q=');
			await puzzles.fetch(req, mockEnv);

			const calls = vi.mocked(storage.listPuzzlesPage).mock.calls;
			expect(calls.length).toBeGreaterThan(0);
			const [, params] = calls[calls.length - 1];
			expect(params.q).toBeUndefined();
		});
	});

	describe('GET /:id', () => {
		it('should return 400 for invalid UUID format', async () => {
			const req = new Request('http://localhost/not-a-uuid');
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(400);
			expect(body.error).toBe('bad_request');
			expect(body.message).toContain('Invalid puzzle ID format');
		});

		it('should return 400 for non-v4 UUID format', async () => {
			// Version nibble is "1" here, not "4"
			const req = new Request('http://localhost/550e8400-e29b-11d4-a716-446655440000');
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(400);
			expect(body.error).toBe('bad_request');
		});

		it('should return 400 for space character ID', async () => {
			const req = new Request('http://localhost/%20');
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(400);
			expect(body.error).toBe('bad_request');
		});

		it('should return 404 for non-ready puzzle metadata', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			vi.mocked(storage.getPuzzle).mockResolvedValueOnce({
				id: validUuid,
				name: 'Processing Puzzle',
				pieceCount: 4,
				gridCols: 2,
				gridRows: 2,
				imageWidth: 100,
				imageHeight: 100,
				createdAt: Date.now(),
				status: 'processing',
				pieces: [],
				version: 0,
				progress: {
					totalPieces: 4,
					generatedPieces: 0,
					updatedAt: Date.now()
				}
			} as any);

			const req = new Request(`http://localhost/${validUuid}`);
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(404);
			expect(body.error).toBe('not_found');
		});
	});

	describe('GET /:id/thumbnail', () => {
		it('should return 400 for invalid UUID format', async () => {
			const req = new Request('http://localhost/invalid-uuid/thumbnail');
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(400);
			expect(body.error).toBe('bad_request');
		});

		it('should return 404 for non-ready puzzle', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			vi.mocked(storage.getPuzzle).mockResolvedValueOnce({
				id: validUuid,
				name: 'Processing Puzzle',
				pieceCount: 4,
				gridCols: 2,
				gridRows: 2,
				imageWidth: 100,
				imageHeight: 100,
				createdAt: Date.now(),
				status: 'processing',
				pieces: [],
				version: 0,
				progress: {
					totalPieces: 4,
					generatedPieces: 0,
					updatedAt: Date.now()
				}
			} as any);

			const req = new Request(`http://localhost/${validUuid}/thumbnail`);
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(404);
			expect(body.error).toBe('not_found');
		});
	});

	describe('GET /:id/pieces/:pieceId/image', () => {
		it('should return 400 for invalid UUID format', async () => {
			const req = new Request('http://localhost/not-uuid/pieces/0/image');
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(400);
			expect(body.error).toBe('bad_request');
		});

		it('should return 400 for negative pieceId', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			const req = new Request(`http://localhost/${validUuid}/pieces/-1/image`);
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(400);
			expect(body.error).toBe('invalid_piece_id');
		});

		it('should return 409 when puzzle metadata is incomplete', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			vi.mocked(storage.getPuzzle).mockResolvedValueOnce({
				id: validUuid,
				name: 'Broken Ready Puzzle',
				pieceCount: undefined,
				gridCols: 2,
				gridRows: 2,
				imageWidth: 100,
				imageHeight: 100,
				createdAt: Date.now(),
				status: 'ready',
				pieces: [],
				version: 0
			} as any);
			const req = new Request(`http://localhost/${validUuid}/pieces/0/image`);
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(409);
			expect(body.error).toBe('unavailable');
		});

		it('should return 404 for non-ready puzzle', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			vi.mocked(storage.getPuzzle).mockResolvedValueOnce({
				id: validUuid,
				name: 'Failed Puzzle',
				pieceCount: 4,
				gridCols: 2,
				gridRows: 2,
				imageWidth: 100,
				imageHeight: 100,
				createdAt: Date.now(),
				status: 'failed',
				pieces: [],
				version: 0,
				error: { message: 'failed' }
			} as any);

			const req = new Request(`http://localhost/${validUuid}/pieces/0/image`);
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(404);
			expect(body.error).toBe('not_found');
		});

		it('should return 400 for pieceId exceeding maximum', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			const req = new Request(`http://localhost/${validUuid}/pieces/10001/image`);
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(400);
			expect(body.error).toBe('invalid_piece_id');
		});

		it('should return 400 for pieceId with trailing characters (parseInt coercion)', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			const req = new Request(`http://localhost/${validUuid}/pieces/1abc/image`);
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(400);
			expect(body.error).toBe('invalid_piece_id');
		});

		it('should return 400 for decimal pieceId', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			const req = new Request(`http://localhost/${validUuid}/pieces/1.5/image`);
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(400);
			expect(body.error).toBe('invalid_piece_id');
		});
	});

	describe('GET /:id/reference', () => {
		beforeEach(() => {
			vi.mocked(storage.getPuzzle).mockReset();
			vi.mocked(storage.getImage).mockReset();
			vi.mocked(storage.resolveVariantReferenceKey).mockReset();
		});

		it('should return 400 for invalid UUID format', async () => {
			const req = new Request('http://localhost/invalid-uuid/reference');
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(400);
			expect(body.error).toBe('bad_request');
		});

		it('should return 404 for non-ready puzzle', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			vi.mocked(storage.getPuzzle).mockResolvedValueOnce({
				id: validUuid,
				name: 'Processing Puzzle',
				pieceCount: 4,
				gridCols: 2,
				gridRows: 2,
				imageWidth: 100,
				imageHeight: 100,
				createdAt: Date.now(),
				status: 'processing',
				pieces: [],
				version: 0,
				progress: {
					totalPieces: 4,
					generatedPieces: 0,
					updatedAt: Date.now()
				}
			} as any);

			const req = new Request(`http://localhost/${validUuid}/reference`);
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(404);
			expect(body.error).toBe('not_found');
		});

		it('should return 404 when original image is missing', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			vi.mocked(storage.getPuzzle).mockResolvedValueOnce({
				id: validUuid,
				familyId: '223e4567-e89b-42d3-a456-426614174000',
				difficulty: 'easy',
				name: 'Test',
				pieceCount: 4,
				gridCols: 2,
				gridRows: 2,
				imageWidth: 100,
				imageHeight: 100,
				createdAt: Date.now(),
				status: 'ready',
				pieces: [],
				version: 0
			} as any);
			vi.mocked(storage.resolveVariantReferenceKey).mockResolvedValueOnce(
				'families/223e4567-e89b-42d3-a456-426614174000/original'
			);
			vi.mocked(storage.getImage).mockResolvedValueOnce(null);

			const req = new Request(`http://localhost/${validUuid}/reference`);
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(404);
			expect(body.error).toBe('not_found');
			expect(body.message).toBe('Reference image not found');
		});
	});

	describe('GET /:id/reference - success path', () => {
		const familyId = '223e4567-e89b-42d3-a456-426614174000';
		it('should return image with correct Content-Type and Cache-Control', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			vi.mocked(storage.getPuzzle).mockResolvedValueOnce({
				id: validUuid,
				familyId,
				difficulty: 'easy',
				name: 'Test',
				pieceCount: 16,
				gridCols: 4,
				gridRows: 4,
				imageWidth: 100,
				imageHeight: 100,
				createdAt: Date.now(),
				status: 'ready',
				pieces: [],
				version: 0
			} as any);
			vi.mocked(storage.resolveVariantReferenceKey).mockResolvedValueOnce(
				`families/${familyId}/original`
			);
			vi.mocked(storage.getImage).mockResolvedValueOnce({
				data: new ArrayBuffer(8),
				contentType: 'image/jpeg'
			});

			const req = new Request(`http://localhost/${validUuid}/reference`);
			const res = await puzzles.fetch(req, mockEnv);

			expect(res.status).toBe(200);
			expect(res.headers.get('Content-Type')).toBe('image/jpeg');
			expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
		});
	});

	describe('GET /:id/reference - null puzzle path', () => {
		it('should return 404 when getPuzzle resolves to null', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			vi.mocked(storage.getPuzzle).mockResolvedValueOnce(null);

			const req = new Request(`http://localhost/${validUuid}/reference`);
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(404);
			expect(body.error).toBe('not_found');
			expect(body.message).toBe('Puzzle not found');
		});
	});

	describe('GET /:id/reference - unexpected error path', () => {
		it('should return 500 when getPuzzle throws an unexpected error', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			vi.mocked(storage.getPuzzle).mockRejectedValueOnce(new Error('Database connection failed'));

			const req = new Request(`http://localhost/${validUuid}/reference`);
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(500);
			expect(body.error).toBe('internal_error');
			expect(body.message).toBe('Failed to retrieve reference image');
		});
	});

	describe('GET /:id/thumbnail - success path', () => {
		const familyId = '223e4567-e89b-42d3-a456-426614174000';

		beforeEach(() => {
			vi.mocked(storage.getPuzzle).mockReset();
			vi.mocked(storage.getImage).mockReset();
		});

		it('should return image with correct Content-Type and Cache-Control', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			vi.mocked(storage.getPuzzle).mockResolvedValueOnce({
				id: validUuid,
				familyId,
				difficulty: 'easy',
				name: 'Test',
				pieceCount: 16,
				gridCols: 4,
				gridRows: 4,
				imageWidth: 100,
				imageHeight: 100,
				createdAt: Date.now(),
				status: 'ready',
				pieces: [],
				version: 0
			} as any);
			vi.mocked(storage.getImage).mockResolvedValueOnce({
				data: new ArrayBuffer(8),
				contentType: 'image/jpeg'
			});

			const req = new Request(`http://localhost/${validUuid}/thumbnail`);
			const res = await puzzles.fetch(req, mockEnv);

			expect(res.status).toBe(200);
			expect(res.headers.get('Content-Type')).toBe('image/jpeg');
			expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
		});
	});

	describe('GET /:id/pieces/:pieceId/image - success path', () => {
		beforeEach(() => {
			vi.mocked(storage.getPuzzle).mockReset();
			vi.mocked(storage.getImage).mockReset();
		});

		it('should return image data on success', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			vi.mocked(storage.getPuzzle).mockResolvedValueOnce({
				id: validUuid,
				familyId: '223e4567-e89b-42d3-a456-426614174000',
				difficulty: 'easy',
				name: 'Test',
				pieceCount: 16,
				gridCols: 4,
				gridRows: 4,
				imageWidth: 100,
				imageHeight: 100,
				createdAt: Date.now(),
				status: 'ready',
				pieces: [],
				version: 0
			} as any);
			vi.mocked(storage.getImage).mockResolvedValueOnce({
				data: new ArrayBuffer(16),
				contentType: 'image/png'
			});

			const req = new Request(`http://localhost/${validUuid}/pieces/0/image`);
			const res = await puzzles.fetch(req, mockEnv);

			expect(res.status).toBe(200);
			expect(res.headers.get('Content-Type')).toBe('image/png');
			expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
		});
	});
});
