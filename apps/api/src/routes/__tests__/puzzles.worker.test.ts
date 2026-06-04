/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import puzzles from '../puzzles.worker';
import * as storage from '../../services/storage.worker';
import * as playerAuth from '../../services/player-auth.worker';

vi.mock('../../services/storage.worker');
vi.mock('../../services/player-auth.worker', () => ({
	getPlayerSession: vi.fn()
}));

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);

describe('Puzzle Routes - UUID Validation', () => {
	const mockEnv = {
		PUZZLE_METADATA: {} as KVNamespace,
		PUZZLES_BUCKET: {} as R2Bucket,
		PUZZLE_WORKFLOW: {
			create: vi.fn().mockResolvedValue({ id: 'workflow-id' })
		}
	};

	describe('POST / - Upload puzzle for player', () => {
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

		it('creates a processing puzzle when the player session is valid', async () => {
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
			expect(storage.createPuzzleMetadata).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.objectContaining({
					name: 'Player Puzzle',
					pieceCount: 48,
					aspectRatio: '3:4',
					category: 'Art',
					status: 'processing'
				})
			);
			expect(mockEnv.PUZZLE_WORKFLOW.create).toHaveBeenCalledWith({
				id: body.id,
				params: { puzzleId: body.id }
			});
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
		it('should return image with correct Content-Type and Cache-Control', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			vi.mocked(storage.getPuzzle).mockResolvedValueOnce({
				id: validUuid,
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
		it('should return image with correct Content-Type and Cache-Control', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			vi.mocked(storage.getPuzzle).mockResolvedValueOnce({
				id: validUuid,
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
		it('should return image data on success', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			vi.mocked(storage.getPuzzle).mockResolvedValueOnce({
				id: validUuid,
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
