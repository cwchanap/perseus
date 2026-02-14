/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import puzzles from '../puzzles.worker';
import * as storage from '../../services/storage.worker';

vi.mock('../../services/storage.worker');

describe('Puzzle Routes - UUID Validation', () => {
	const mockEnv = {
		PUZZLE_METADATA: {} as KVNamespace,
		PUZZLES_BUCKET: {} as R2Bucket
	};

	describe('GET / - List puzzles', () => {
		it('should only return ready puzzles', async () => {
			const mockPuzzles = [
				{
					id: '550e8400-e29b-41d4-a716-446655440001',
					name: 'Ready Puzzle',
					pieceCount: 4,
					status: 'ready'
				},
				{
					id: '550e8400-e29b-41d4-a716-446655440002',
					name: 'Processing Puzzle',
					pieceCount: 4,
					status: 'processing'
				},
				{
					id: '550e8400-e29b-41d4-a716-446655440003',
					name: 'Failed Puzzle',
					pieceCount: 4,
					status: 'failed'
				}
			];
			vi.mocked(storage.listPuzzles).mockResolvedValue({
				puzzles: mockPuzzles,
				invalidCount: 0
			} as any);

			const req = new Request('http://localhost/');
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(200);
			expect(body.puzzles).toHaveLength(1);
			expect(body.puzzles[0].id).toBe('550e8400-e29b-41d4-a716-446655440001');
			expect(body.puzzles[0].status).toBe('ready');
		});

		it('should return empty array when no ready puzzles exist', async () => {
			const mockPuzzles = [
				{
					id: '550e8400-e29b-41d4-a716-446655440002',
					name: 'Processing Puzzle',
					pieceCount: 4,
					status: 'processing'
				}
			];
			vi.mocked(storage.listPuzzles).mockResolvedValue({
				puzzles: mockPuzzles,
				invalidCount: 0
			} as any);

			const req = new Request('http://localhost/');
			const res = await puzzles.fetch(req, mockEnv);
			const body = (await res.json()) as any;

			expect(res.status).toBe(200);
			expect(body.puzzles).toHaveLength(0);
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
