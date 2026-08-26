import type { ReadyPuzzle } from '@perseus/types';
import type { PuzzleApi } from '../api/puzzleApi';
import {
	createDownloadManifest,
	parseDownloadManifest,
	type DownloadManifestV1,
	type DownloadedAssetFiles
} from './downloadManifest';

export interface DownloadCancellation {
	cancelled: boolean;
}

export interface DownloadFileOps {
	join(...parts: string[]): string;
	ensureDir(path: string): Promise<void>;
	directoryExists(path: string): Promise<boolean>;
	removeDir(path: string): Promise<void>;
	moveDir(fromPath: string, toPath: string): Promise<void>;
	readText(path: string): Promise<string | null>;
	writeText(path: string, content: string): Promise<void>;
	listDirectories(path: string): Promise<string[]>;
	fileSize(path: string): Promise<number | null>;
}

export type DownloadedAsset = {
	kind: 'downloaded';
	extension: '.png' | '.jpg' | '.webp';
	bytes: number;
};

export type AssetDownloadResult = DownloadedAsset | { kind: 'not_found' };

export type AssetDownloader = (
	url: string,
	destinationBasePath: string
) => Promise<AssetDownloadResult>;

export interface InstalledDownload {
	kind: 'installed';
	packagePath: string;
	manifest: DownloadManifestV1;
	thumbnailPath: string;
	referencePath?: string;
	piecePaths: Record<number, string>;
}

export interface CorruptDownload {
	kind: 'corrupt';
	puzzleId: string;
	packagePath: string;
	reason: string;
}

export type DownloadScanEntry = InstalledDownload | CorruptDownload;

export interface DownloadStore {
	cleanupStaleStaging(): Promise<void>;
	downloadPuzzle(
		puzzle: ReadyPuzzle,
		cancellation?: DownloadCancellation,
		onProgress?: (done: number, total: number) => void
	): Promise<InstalledDownload>;
	scanDownloads(): Promise<DownloadScanEntry[]>;
	removeDownload(puzzleId: string): Promise<void>;
}

interface AssetRequest {
	url: string;
	destinationBasePath: string;
	allowNotFound: boolean;
}

const ASSET_CHUNK_SIZE = 5;
const STAGING_DIR_NAME = '.staging';
const MANIFEST_FILE_NAME = 'manifest.json';

function isSafePathSegment(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value !== '.' &&
		value !== '..' &&
		value !== STAGING_DIR_NAME &&
		!value.includes('/') &&
		!value.includes('\\')
	);
}

function folderNameOf(path: string): string {
	const withoutTrailingSlashes = path.replace(/\/+$/, '');
	return withoutTrailingSlashes.slice(withoutTrailingSlashes.lastIndexOf('/') + 1);
}

function requireSafePuzzleId(puzzleId: string): void {
	if (!isSafePathSegment(puzzleId)) throw new Error('invalid_puzzle_id');
}

function requireDownloadedAsset(result: AssetDownloadResult): DownloadedAsset {
	if (result.kind !== 'downloaded') throw new Error('required_asset_not_found');
	return result;
}

export function createDownloadStore(options: {
	rootPath: string;
	fileOps: DownloadFileOps;
	downloadAsset: AssetDownloader;
	assetUrls: Pick<PuzzleApi, 'thumbnailUrl' | 'referenceUrl' | 'pieceImageUrl'>;
	now: () => number;
}): DownloadStore {
	const { fileOps } = options;
	const stagingRootPath = fileOps.join(options.rootPath, STAGING_DIR_NAME);

	async function downloadOne(request: AssetRequest): Promise<AssetDownloadResult> {
		const result = await options.downloadAsset(request.url, request.destinationBasePath);
		if (result.kind === 'not_found' && !request.allowNotFound) {
			throw new Error('required_asset_not_found');
		}
		return result;
	}

	async function downloadInChunks(
		requests: readonly AssetRequest[],
		cancellation: DownloadCancellation | undefined,
		onProgress: ((done: number, total: number) => void) | undefined
	): Promise<AssetDownloadResult[]> {
		const results: AssetDownloadResult[] = [];
		let done = 0;
		onProgress?.(0, requests.length);

		for (let offset = 0; offset < requests.length; offset += ASSET_CHUNK_SIZE) {
			if (cancellation?.cancelled) throw new Error('download_cancelled');

			const chunk = requests.slice(offset, offset + ASSET_CHUNK_SIZE);
			const settled = await Promise.allSettled(chunk.map((request) => downloadOne(request)));

			let firstFailure: unknown;
			let hasFailure = false;
			for (let index = 0; index < settled.length; index += 1) {
				const outcome = settled[index]!;
				done += 1;
				onProgress?.(done, requests.length);
				if (outcome.status === 'rejected') {
					if (!hasFailure) firstFailure = outcome.reason;
					hasFailure = true;
					continue;
				}
				results.push(outcome.value);
			}

			if (hasFailure) throw firstFailure;
			if (cancellation?.cancelled) throw new Error('download_cancelled');
		}

		return results;
	}

	async function requireNonEmptyFile(path: string): Promise<void> {
		const size = await fileOps.fileSize(path);
		if (size === null) throw new Error('download_file_missing');
		if (!(size > 0)) throw new Error('download_file_empty');
	}

	async function removeStagingOnFailure(stagingPath: string): Promise<void> {
		try {
			await fileOps.removeDir(stagingPath);
		} catch {
			// Best effort: startup cleanupStaleStaging() will retry.
		}
	}

	async function scanPackage(packagePath: string): Promise<DownloadScanEntry> {
		const puzzleId = folderNameOf(packagePath);
		try {
			const raw = await fileOps.readText(fileOps.join(packagePath, MANIFEST_FILE_NAME));
			if (raw === null) throw new Error('download_manifest_missing');

			let manifest: DownloadManifestV1;
			try {
				manifest = parseDownloadManifest(JSON.parse(raw));
			} catch {
				throw new Error('invalid_download_manifest');
			}
			if (puzzleId !== manifest.puzzle.id) throw new Error('download_manifest_id_mismatch');

			const thumbnailPath = fileOps.join(packagePath, manifest.files.thumbnailFile);
			await requireNonEmptyFile(thumbnailPath);

			let referencePath: string | undefined;
			if (manifest.files.referenceFile !== undefined) {
				referencePath = fileOps.join(packagePath, manifest.files.referenceFile);
				await requireNonEmptyFile(referencePath);
			}

			const piecePaths: Record<number, string> = {};
			for (const piece of manifest.puzzle.pieces) {
				const piecePath = fileOps.join(packagePath, manifest.files.pieceFiles[String(piece.id)]!);
				await requireNonEmptyFile(piecePath);
				piecePaths[piece.id] = piecePath;
			}

			return {
				kind: 'installed',
				packagePath,
				manifest,
				thumbnailPath,
				...(referencePath !== undefined ? { referencePath } : {}),
				piecePaths
			};
		} catch (error) {
			return {
				kind: 'corrupt',
				puzzleId,
				packagePath,
				reason: error instanceof Error ? error.message : String(error)
			};
		}
	}

	return {
		async cleanupStaleStaging(): Promise<void> {
			await fileOps.ensureDir(options.rootPath);
			await fileOps.ensureDir(stagingRootPath);
			for (const child of await fileOps.listDirectories(stagingRootPath)) {
				await fileOps.removeDir(child);
			}
		},

		async downloadPuzzle(puzzle, cancellation, onProgress): Promise<InstalledDownload> {
			requireSafePuzzleId(puzzle.id);
			const packagePath = fileOps.join(options.rootPath, puzzle.id);
			const stagingPath = fileOps.join(stagingRootPath, puzzle.id);
			const piecesDirPath = fileOps.join(stagingPath, 'pieces');

			if (await fileOps.directoryExists(packagePath)) {
				throw new Error('download_already_installed');
			}

			let finalized = false;
			let stagingPrepared = false;
			try {
				if (await fileOps.directoryExists(stagingPath)) {
					await fileOps.removeDir(stagingPath);
				}
				stagingPrepared = true;
				await fileOps.ensureDir(piecesDirPath);

				const requests: AssetRequest[] = [
					{
						url: options.assetUrls.thumbnailUrl(puzzle.id),
						destinationBasePath: fileOps.join(stagingPath, 'thumbnail'),
						allowNotFound: false
					},
					{
						url: options.assetUrls.referenceUrl(puzzle.id),
						destinationBasePath: fileOps.join(stagingPath, 'reference'),
						allowNotFound: true
					},
					...puzzle.pieces.map((piece) => ({
						url: options.assetUrls.pieceImageUrl(puzzle.id, piece.id),
						destinationBasePath: fileOps.join(piecesDirPath, String(piece.id)),
						allowNotFound: false
					}))
				];

				const settled = await downloadInChunks(requests, cancellation, onProgress);
				const thumbnail = requireDownloadedAsset(settled[0]!);
				const reference = settled[1]!;
				const pieceAssets = settled.slice(2).map((result) => requireDownloadedAsset(result));

				const thumbnailFile = `thumbnail${thumbnail.extension}`;
				const referenceFile =
					reference.kind === 'downloaded' ? `reference${reference.extension}` : undefined;
				if (new Set(puzzle.pieces.map((piece) => piece.id)).size !== puzzle.pieces.length) {
					throw new Error('duplicate_piece_ids');
				}
				const pieceFiles: Record<string, string> = {};
				const piecePaths: Record<number, string> = {};
				for (let index = 0; index < puzzle.pieces.length; index += 1) {
					const piece = puzzle.pieces[index]!;
					const relativeFile = `pieces/${piece.id}${pieceAssets[index]!.extension}`;
					pieceFiles[String(piece.id)] = relativeFile;
					piecePaths[piece.id] = fileOps.join(packagePath, relativeFile);
				}

				await requireNonEmptyFile(fileOps.join(stagingPath, thumbnailFile));
				if (referenceFile !== undefined) {
					await requireNonEmptyFile(fileOps.join(stagingPath, referenceFile));
				}
				for (const relativeFile of Object.values(pieceFiles)) {
					await requireNonEmptyFile(fileOps.join(stagingPath, relativeFile));
				}

				const files: DownloadedAssetFiles = {
					thumbnailFile,
					...(referenceFile !== undefined ? { referenceFile } : {}),
					pieceFiles
				};
				const manifest = createDownloadManifest(puzzle, files, options.now());
				await fileOps.writeText(
					fileOps.join(stagingPath, MANIFEST_FILE_NAME),
					JSON.stringify(manifest)
				);
				await fileOps.moveDir(stagingPath, packagePath);
				finalized = true;

				const referencePath =
					referenceFile === undefined ? undefined : fileOps.join(packagePath, referenceFile);
				return {
					kind: 'installed',
					packagePath,
					manifest,
					thumbnailPath: fileOps.join(packagePath, thumbnailFile),
					...(referencePath !== undefined ? { referencePath } : {}),
					piecePaths
				};
			} finally {
				if (stagingPrepared && !finalized) {
					await removeStagingOnFailure(stagingPath);
				}
			}
		},

		async scanDownloads(): Promise<DownloadScanEntry[]> {
			if (!(await fileOps.directoryExists(options.rootPath))) return [];
			const entries: DownloadScanEntry[] = [];
			for (const packagePath of await fileOps.listDirectories(options.rootPath)) {
				if (folderNameOf(packagePath) === STAGING_DIR_NAME) continue;
				entries.push(await scanPackage(packagePath));
			}
			return entries;
		},

		async removeDownload(puzzleId: string): Promise<void> {
			requireSafePuzzleId(puzzleId);
			await fileOps.removeDir(fileOps.join(options.rootPath, puzzleId));
		}
	};
}
