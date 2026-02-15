import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { deletePuzzle } from '../api';

describe('API Service - deletePuzzle', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns partial deletion details for 207 responses', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						success: false,
						partialSuccess: true,
						warning: 'Puzzle metadata deleted but some assets failed to delete',
						failedAssets: ['puzzles/abc/pieces/0.png']
					}),
					{
						status: 207,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			)
		);

		const result = await deletePuzzle('abc');

		expect(result).toEqual({
			success: false,
			partialSuccess: true,
			warning: 'Puzzle metadata deleted but some assets failed to delete',
			failedAssets: ['puzzles/abc/pieces/0.png']
		});
	});

	it('returns null for 204 responses', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(null, {
					status: 204
				})
			)
		);

		const result = await deletePuzzle('abc');

		expect(result).toBeNull();
	});
});
