import { describe, it, expect } from 'vitest';
import puzzles from '../puzzles.worker';

describe('Puzzle Routes - UUID Validation', () => {
	const mockEnv = {
		PUZZLE_METADATA: {} as KVNamespace,
		PUZZLES_BUCKET: {} as R2Bucket
	};

	describe('GET /:id', () => {
		it('should return 400 for invalid UUID format', async () => {
			const req = new Request('http://localhost/not-a-uuid');
			const res = await puzzles.fetch(req, mockEnv);
			const body = await res.json();

			expect(res.status).toBe(400);
			expect(body.error).toBe('bad_request');
			expect(body.message).toContain('Invalid puzzle ID format');
		});

		it('should return 400 for space character ID', async () => {
			const req = new Request('http://localhost/%20');
			const res = await puzzles.fetch(req, mockEnv);
			const body = await res.json();

			expect(res.status).toBe(400);
			expect(body.error).toBe('bad_request');
		});
	});

	describe('GET /:id/thumbnail', () => {
		it('should return 400 for invalid UUID format', async () => {
			const req = new Request('http://localhost/invalid-uuid/thumbnail');
			const res = await puzzles.fetch(req, mockEnv);
			const body = await res.json();

			expect(res.status).toBe(400);
			expect(body.error).toBe('bad_request');
		});
	});

	describe('GET /:id/pieces/:pieceId/image', () => {
		it('should return 400 for invalid UUID format', async () => {
			const req = new Request('http://localhost/not-uuid/pieces/0/image');
			const res = await puzzles.fetch(req, mockEnv);
			const body = await res.json();

			expect(res.status).toBe(400);
			expect(body.error).toBe('bad_request');
		});

		it('should return 400 for negative pieceId', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			const req = new Request(`http://localhost/${validUuid}/pieces/-1/image`);
			const res = await puzzles.fetch(req, mockEnv);
			const body = await res.json();

			expect(res.status).toBe(400);
			expect(body.error).toBe('invalid_piece_id');
		});

		it('should return 400 for pieceId exceeding maximum', async () => {
			const validUuid = '550e8400-e29b-41d4-a716-446655440000';
			const req = new Request(`http://localhost/${validUuid}/pieces/10001/image`);
			const res = await puzzles.fetch(req, mockEnv);
			const body = await res.json();

			expect(res.status).toBe(400);
			expect(body.error).toBe('invalid_piece_id');
		});
	});
});
