import { describe, expect, it } from 'vitest';
import type { PuzzleMetadata, PuzzlePiece, ReadyPuzzle } from '@perseus/types';
import {
	createDownloadManifest,
	parseDownloadManifest,
	sessionSpecFromManifest,
	type DownloadedAssetFiles
} from './downloadManifest';

const IDS = [2, 7, 11, 19];

function makePiece(id: number, index: number): PuzzlePiece {
	return {
		id,
		puzzleId: 'p1',
		correctX: index % 2,
		correctY: Math.floor(index / 2),
		edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' },
		imagePath: `pieces/p1/${id}.png`
	};
}

function readyPuzzleWithIds(ids: number[]): ReadyPuzzle {
	return {
		id: 'p1',
		name: 'Test Puzzle',
		category: 'Nature',
		pieceCount: ids.length,
		gridCols: 2,
		gridRows: Math.ceil(ids.length / 2),
		imageWidth: 1024,
		imageHeight: 1024,
		createdAt: 1720000000000,
		pieces: ids.map((id, index) => makePiece(id, index)),
		version: 1,
		status: 'ready'
	};
}

function validFiles(): DownloadedAssetFiles {
	return {
		thumbnailFile: 'thumbnail.webp',
		referenceFile: 'reference.webp',
		pieceFiles: {
			'2': 'pieces/2.png',
			'7': 'pieces/7.png',
			'11': 'pieces/11.png',
			'19': 'pieces/19.png'
		}
	};
}

function validManifest() {
	return createDownloadManifest(readyPuzzleWithIds(IDS), validFiles(), 1234);
}

describe('downloadManifest', () => {
	it('keeps validated server metadata and projects game-core metadata', () => {
		const manifest = createDownloadManifest(
			readyPuzzleWithIds([2, 7, 11, 19]),
			{
				thumbnailFile: 'thumbnail.webp',
				pieceFiles: {
					'2': 'pieces/2.png',
					'7': 'pieces/7.png',
					'11': 'pieces/11.png',
					'19': 'pieces/19.png'
				}
			},
			1234
		);

		expect(sessionSpecFromManifest(manifest).pieces.map((piece) => piece.id)).toEqual([
			2, 7, 11, 19
		]);
	});

	it('round-trips a parsed manifest and projects the full session spec', () => {
		const manifest = parseDownloadManifest(validManifest());

		expect(manifest).toEqual({
			schemaVersion: 1,
			puzzle: readyPuzzleWithIds(IDS),
			files: validFiles(),
			downloadedAt: 1234
		});
		expect(sessionSpecFromManifest(manifest)).toEqual({
			puzzleId: 'p1',
			source: 'api',
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2,
			pieces: [
				{ id: 2, correctX: 0, correctY: 0 },
				{ id: 7, correctX: 1, correctY: 0 },
				{ id: 11, correctX: 0, correctY: 1 },
				{ id: 19, correctX: 1, correctY: 1 }
			]
		});
	});

	it('rejects an unsupported schema version', () => {
		expect(() => parseDownloadManifest({ ...validManifest(), schemaVersion: 2 })).toThrow(
			'invalid_download_manifest'
		);
	});

	it('rejects puzzle metadata that fails shared validation', () => {
		const puzzle = { ...readyPuzzleWithIds(IDS), gridCols: 3 };

		expect(() => parseDownloadManifest({ ...validManifest(), puzzle })).toThrow(
			'invalid_download_manifest'
		);
	});

	it('rejects valid metadata that is not ready', () => {
		const puzzle: PuzzleMetadata = {
			...readyPuzzleWithIds(IDS),
			status: 'processing',
			progress: { totalPieces: 4, generatedPieces: 2, updatedAt: 1720000000000 }
		};

		expect(() => parseDownloadManifest({ ...validManifest(), puzzle })).toThrow(
			'invalid_download_manifest'
		);
	});

	it('rejects a non-finite downloadedAt', () => {
		for (const downloadedAt of [Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => parseDownloadManifest({ ...validManifest(), downloadedAt })).toThrow(
				'invalid_download_manifest'
			);
		}
	});

	it('rejects unsafe asset filenames', () => {
		const mutations: Array<(files: DownloadedAssetFiles) => DownloadedAssetFiles> = [
			(files) => ({ ...files, thumbnailFile: '/x' }),
			(files) => ({ ...files, referenceFile: '../x' }),
			(files) => ({ ...files, pieceFiles: { ...files.pieceFiles, '2': 'a\\b.png' } }),
			(files) => ({ ...files, pieceFiles: { ...files.pieceFiles, '7': 'pieces/../x' } })
		];

		for (const mutate of mutations) {
			expect(() =>
				parseDownloadManifest({ ...validManifest(), files: mutate(validFiles()) })
			).toThrow('invalid_download_manifest');
		}
	});

	it('rejects a missing piece-file entry', () => {
		const pieceFiles = { ...validFiles().pieceFiles };
		delete pieceFiles['11'];

		expect(() =>
			parseDownloadManifest({ ...validManifest(), files: { ...validFiles(), pieceFiles } })
		).toThrow('invalid_download_manifest');
	});

	it('rejects an extra piece-file entry', () => {
		const pieceFiles = { ...validFiles().pieceFiles, '23': 'pieces/23.png' };

		expect(() =>
			parseDownloadManifest({ ...validManifest(), files: { ...validFiles(), pieceFiles } })
		).toThrow('invalid_download_manifest');
	});

	it('rejects unsafe files at construction time', () => {
		expect(() =>
			createDownloadManifest(
				readyPuzzleWithIds(IDS),
				{ ...validFiles(), thumbnailFile: '/x' },
				1234
			)
		).toThrow('invalid_download_manifest');
	});
});
