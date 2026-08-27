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
