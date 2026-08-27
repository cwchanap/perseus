import { describe, expect, it } from 'vitest';
import type { PuzzleMetadata, PuzzlePiece, ReadyPuzzle } from '@perseus/types';
import { getDifficultyPieceCount } from '@perseus/types';
import { createPuzzleApi } from './puzzleApi';

const FAMILY_ID = '123e4567-e89b-42d3-a456-426614174000';
const VARIANT_ID = '223e4567-e89b-42d3-a456-426614174001';

function makePiece(id: number): PuzzlePiece {
	return {
		id,
		puzzleId: VARIANT_ID,
		correctX: id % 2,
		correctY: Math.floor(id / 2),
		edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' },
		imagePath: `pieces/${VARIANT_ID}/${id}.png`
	};
}

function readyPuzzle(): ReadyPuzzle {
	return {
		id: VARIANT_ID,
		familyId: FAMILY_ID,
		difficulty: 'normal',
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

function makeFamilyEnvelope() {
	const aspectRatio = '4:3' as const;
	return {
		families: [
			{
				id: FAMILY_ID,
				name: 'Mountain Vista',
				aspectRatio,
				status: 'ready',
				createdAt: 1716500000000,
				variants: {
					easy: {
						id: VARIANT_ID,
						difficulty: 'easy',
						pieceCount: getDifficultyPieceCount(aspectRatio, 'easy'),
						status: 'ready'
					},
					normal: {
						id: '323e4567-e89b-42d3-a456-426614174002',
						difficulty: 'normal',
						pieceCount: getDifficultyPieceCount(aspectRatio, 'normal'),
						status: 'ready'
					},
					hard: {
						id: '423e4567-e89b-42d3-a456-426614174003',
						difficulty: 'hard',
						pieceCount: getDifficultyPieceCount(aspectRatio, 'hard'),
						status: 'ready'
					}
				}
			}
		],
		total: 1,
		offset: 0,
		limit: 20
	};
}

describe('createPuzzleApi', () => {
	it('normalizes a trailing base slash and propagates the existing cursor', async () => {
		const urls: string[] = [];
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test/',
			requestJson: async (url) => {
				urls.push(url);
				return { families: [], total: 0, offset: 0, limit: 20, nextCursor: 'next' };
			}
		});

		await api.listPuzzleFamilies('cursor-1');

		expect(urls).toEqual(['https://api.example.test/api/puzzle-families?cursor=cursor-1']);
	});

	it('preserves an empty-string cursor as a cursor parameter', async () => {
		const urls: string[] = [];
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async (url) => {
				urls.push(url);
				return { families: [], total: 0, offset: 0, limit: 20 };
			}
		});

		await api.listPuzzleFamilies('');

		expect(urls).toEqual(['https://api.example.test/api/puzzle-families?cursor=']);
	});

	it('returns the list envelope when no cursor is given', async () => {
		const urls: string[] = [];
		const envelope = { families: [], total: 0, offset: 0, limit: 20, nextCursor: 'next' };
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async (url) => {
				urls.push(url);
				return envelope;
			}
		});

		await expect(api.listPuzzleFamilies()).resolves.toEqual(envelope);
		expect(urls).toEqual(['https://api.example.test/api/puzzle-families']);
	});

	it('returns a populated, validated list envelope', async () => {
		const envelope = makeFamilyEnvelope();
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => envelope
		});

		await expect(api.listPuzzleFamilies()).resolves.toEqual(envelope);
	});

	it('rejects a non-array families field', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => ({ families: 'not-an-array', total: 0, offset: 0, limit: 20 })
		});

		await expect(api.listPuzzleFamilies()).rejects.toThrow('invalid_puzzle_family_list_response');
	});

	it('rejects a family summary with a missing id', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => ({
				families: [
					{ name: 'No ID', aspectRatio: '4:3', status: 'ready', createdAt: 1, variants: {} }
				],
				total: 1,
				offset: 0,
				limit: 20
			})
		});

		await expect(api.listPuzzleFamilies()).rejects.toThrow('invalid_puzzle_family_list_response');
	});

	it('rejects a non-number total', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => ({ families: [], total: '0', offset: 0, limit: 20 })
		});

		await expect(api.listPuzzleFamilies()).rejects.toThrow('invalid_puzzle_family_list_response');
	});

	it('rejects a non-string nextCursor', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => ({ families: [], total: 0, offset: 0, limit: 20, nextCursor: 42 })
		});

		await expect(api.listPuzzleFamilies()).rejects.toThrow('invalid_puzzle_family_list_response');
	});

	it('rejects a non-object response body', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => 'oops'
		});

		await expect(api.listPuzzleFamilies()).rejects.toThrow('invalid_puzzle_family_list_response');
	});

	it('rejects malformed metadata through validatePuzzleMetadata', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => ({ ...readyPuzzle(), gridCols: 3 })
		});

		await expect(api.getPuzzle(VARIANT_ID)).rejects.toThrow('invalid_puzzle_response');
	});

	it('rejects a valid non-ready detail before assets are scheduled', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => processingPuzzle()
		});

		await expect(api.getPuzzle(VARIANT_ID)).rejects.toThrow('puzzle_not_ready');
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

		await expect(api.getPuzzle(VARIANT_ID)).resolves.toEqual(readyPuzzle());
	});

	it('builds variant asset urls against the normalized base', () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test///',
			requestJson: async () => null
		});

		expect(api.thumbnailUrl(VARIANT_ID)).toBe(
			`https://api.example.test/api/puzzles/${VARIANT_ID}/thumbnail`
		);
		expect(api.referenceUrl(VARIANT_ID)).toBe(
			`https://api.example.test/api/puzzles/${VARIANT_ID}/reference`
		);
		expect(api.pieceImageUrl(VARIANT_ID, 2)).toBe(
			`https://api.example.test/api/puzzles/${VARIANT_ID}/pieces/2/image`
		);
	});

	it('encodes puzzle ids with url-special characters in variant asset urls', () => {
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

	it('builds family thumbnail urls against the normalized base', () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test///',
			requestJson: async () => null
		});

		expect(api.familyThumbnailUrl(FAMILY_ID)).toBe(
			'https://api.example.test/api/puzzle-families/123e4567-e89b-42d3-a456-426614174000/thumbnail'
		);
	});

	it('encodes family ids with url-special characters in thumbnail urls', () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => null
		});

		expect(api.familyThumbnailUrl('a/b c')).toBe(
			'https://api.example.test/api/puzzle-families/a%2Fb%20c/thumbnail'
		);
	});
});
