import { describe, expect, it } from 'vitest';
import type { PuzzleMetadata, PuzzlePiece, ReadyPuzzle } from '@perseus/types';
import { createPuzzleApi } from './puzzleApi';

function makePiece(id: number): PuzzlePiece {
	return {
		id,
		puzzleId: 'p1',
		correctX: id % 2,
		correctY: Math.floor(id / 2),
		edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' },
		imagePath: `pieces/p1/${id}.png`
	};
}

function readyPuzzle(): ReadyPuzzle {
	return {
		id: 'p1',
		name: 'Test Puzzle',
		category: 'Nature',
		pieceCount: 4,
		gridCols: 2,
		gridRows: 2,
		imageWidth: 1024,
		imageHeight: 1024,
		createdAt: 1720000000000,
		pieces: [makePiece(0), makePiece(1), makePiece(2), makePiece(3)],
		version: 1,
		status: 'ready'
	};
}

function processingPuzzle(): PuzzleMetadata {
	return {
		...readyPuzzle(),
		status: 'processing',
		progress: { totalPieces: 4, generatedPieces: 2, updatedAt: 1720000000000 }
	};
}

describe('createPuzzleApi', () => {
	it('normalizes a trailing base slash and propagates the existing cursor', async () => {
		const urls: string[] = [];
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test/',
			requestJson: async (url) => {
				urls.push(url);
				return { puzzles: [], total: 0, offset: 0, limit: 20, nextCursor: 'next' };
			}
		});

		await api.listPuzzles('cursor-1');

		expect(urls).toEqual(['https://api.example.test/api/puzzles?cursor=cursor-1']);
	});

	it('preserves an empty-string cursor as a cursor parameter', async () => {
		const urls: string[] = [];
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async (url) => {
				urls.push(url);
				return { puzzles: [], total: 0, offset: 0, limit: 20 };
			}
		});

		await api.listPuzzles('');

		expect(urls).toEqual(['https://api.example.test/api/puzzles?cursor=']);
	});

	it('returns the list envelope when no cursor is given', async () => {
		const urls: string[] = [];
		const envelope = { puzzles: [], total: 0, offset: 0, limit: 20, nextCursor: 'next' };
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async (url) => {
				urls.push(url);
				return envelope;
			}
		});

		await expect(api.listPuzzles()).resolves.toEqual(envelope);
		expect(urls).toEqual(['https://api.example.test/api/puzzles']);
	});

	it('returns a populated, validated list envelope', async () => {
		const envelope = {
			puzzles: [
				{ id: 'p1', name: 'Puzzle 1', pieceCount: 4, status: 'ready' },
				{ id: 'p2', name: 'Puzzle 2', pieceCount: 9, status: 'processing' }
			],
			total: 2,
			offset: 0,
			limit: 20
		};
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => envelope
		});

		await expect(api.listPuzzles()).resolves.toEqual(envelope);
	});

	it('rejects a non-array puzzles field', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => ({ puzzles: 'not-an-array', total: 0, offset: 0, limit: 20 })
		});

		await expect(api.listPuzzles()).rejects.toThrow('invalid_puzzle_list_response');
	});

	it('rejects a puzzle summary with a missing id', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => ({
				puzzles: [{ name: 'No ID', pieceCount: 4, status: 'ready' }],
				total: 1,
				offset: 0,
				limit: 20
			})
		});

		await expect(api.listPuzzles()).rejects.toThrow('invalid_puzzle_list_response');
	});

	it('rejects a non-number total', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => ({ puzzles: [], total: '0', offset: 0, limit: 20 })
		});

		await expect(api.listPuzzles()).rejects.toThrow('invalid_puzzle_list_response');
	});

	it('rejects a non-string nextCursor', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => ({ puzzles: [], total: 0, offset: 0, limit: 20, nextCursor: 42 })
		});

		await expect(api.listPuzzles()).rejects.toThrow('invalid_puzzle_list_response');
	});

	it('rejects a non-object response body', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => 'oops'
		});

		await expect(api.listPuzzles()).rejects.toThrow('invalid_puzzle_list_response');
	});

	it('rejects malformed metadata through validatePuzzleMetadata', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => ({ ...readyPuzzle(), gridCols: 3 })
		});

		await expect(api.getPuzzle('p1')).rejects.toThrow('invalid_puzzle_response');
	});

	it('rejects a valid non-ready detail before assets are scheduled', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => processingPuzzle()
		});

		await expect(api.getPuzzle('p1')).rejects.toThrow('puzzle_not_ready');
	});

	it('rejects a requested/detail id mismatch', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => readyPuzzle()
		});

		await expect(api.getPuzzle('other-id')).rejects.toThrow('invalid_puzzle_response');
	});

	it('returns a validated ready puzzle', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => readyPuzzle()
		});

		await expect(api.getPuzzle('p1')).resolves.toEqual(readyPuzzle());
	});

	it('builds asset urls against the normalized base', () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test///',
			requestJson: async () => null
		});

		expect(api.thumbnailUrl('p1')).toBe('https://api.example.test/api/puzzles/p1/thumbnail');
		expect(api.referenceUrl('p1')).toBe('https://api.example.test/api/puzzles/p1/reference');
		expect(api.pieceImageUrl('p1', 2)).toBe(
			'https://api.example.test/api/puzzles/p1/pieces/2/image'
		);
	});

	it('encodes puzzle ids with url-special characters in asset urls', () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => null
		});

		expect(api.thumbnailUrl('a/b c')).toBe(
			'https://api.example.test/api/puzzles/a%2Fb%20c/thumbnail'
		);
		expect(api.referenceUrl('a/b c')).toBe(
			'https://api.example.test/api/puzzles/a%2Fb%20c/reference'
		);
		expect(api.pieceImageUrl('a/b c', 2)).toBe(
			'https://api.example.test/api/puzzles/a%2Fb%20c/pieces/2/image'
		);
	});
});
