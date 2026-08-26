import type { SessionPuzzleSpec } from '@perseus/game-core';
import { validatePuzzleMetadata, type ReadyPuzzle } from '@perseus/types';

export interface DownloadedAssetFiles {
	thumbnailFile: string;
	referenceFile?: string;
	pieceFiles: Record<string, string>;
}

export interface DownloadManifestV1 {
	schemaVersion: 1;
	puzzle: ReadyPuzzle;
	files: DownloadedAssetFiles;
	downloadedAt: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeRelativeFile(value: unknown): value is string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.startsWith('/') ||
		value.includes('\\')
	) {
		return false;
	}
	return value
		.split('/')
		.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function invalid(): never {
	throw new Error('invalid_download_manifest');
}

export function createDownloadManifest(
	puzzle: ReadyPuzzle,
	files: DownloadedAssetFiles,
	downloadedAt: number
): DownloadManifestV1 {
	return parseDownloadManifest({ schemaVersion: 1, puzzle, files, downloadedAt });
}

export function parseDownloadManifest(value: unknown): DownloadManifestV1 {
	if (!isPlainObject(value) || value.schemaVersion !== 1) invalid();
	const puzzle = value.puzzle;
	if (!validatePuzzleMetadata(puzzle) || puzzle.status !== 'ready') invalid();

	const { files, downloadedAt } = value;
	if (typeof downloadedAt !== 'number' || !Number.isFinite(downloadedAt)) invalid();
	if (!isPlainObject(files)) invalid();
	if (!isSafeRelativeFile(files.thumbnailFile)) invalid();
	const referenceFile = files.referenceFile;
	if (referenceFile !== undefined && !isSafeRelativeFile(referenceFile)) invalid();
	if (!isPlainObject(files.pieceFiles)) invalid();

	const expectedIds = new Set(puzzle.pieces.map((piece) => String(piece.id)));
	const keys = Object.keys(files.pieceFiles);
	if (keys.length !== expectedIds.size || !keys.every((key) => expectedIds.has(key))) invalid();
	const pieceFiles: Record<string, string> = {};
	for (const key of keys) {
		const path = files.pieceFiles[key];
		if (!isSafeRelativeFile(path)) invalid();
		pieceFiles[key] = path;
	}

	return {
		schemaVersion: 1,
		puzzle,
		files: {
			thumbnailFile: files.thumbnailFile,
			...(referenceFile !== undefined ? { referenceFile } : {}),
			pieceFiles
		},
		downloadedAt
	};
}

export function sessionSpecFromManifest(manifest: DownloadManifestV1): SessionPuzzleSpec {
	return {
		puzzleId: manifest.puzzle.id,
		source: 'api',
		pieceCount: manifest.puzzle.pieceCount,
		gridCols: manifest.puzzle.gridCols,
		gridRows: manifest.puzzle.gridRows,
		pieces: manifest.puzzle.pieces.map(({ id, correctX, correctY }) => ({
			id,
			correctX,
			correctY
		}))
	};
}
