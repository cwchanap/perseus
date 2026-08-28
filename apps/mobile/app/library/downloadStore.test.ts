import { describe, expect, it, vi } from 'vitest';
import type { PuzzlePiece, ReadyPuzzle } from '@perseus/types';
import { createDownloadManifest } from './downloadManifest';
import {
	createDownloadStore,
	type AssetDownloadResult,
	type AssetDownloader,
	type DownloadFileOps,
	type InstalledDownload
} from './downloadStore';

const ROOT = '/downloads';
const THUMBNAIL_URL = 'http://api.test/puzzles/p1/thumbnail';
const REFERENCE_URL = 'http://api.test/puzzles/p1/reference';

function pieceUrl(id: number): string {
	return `http://api.test/puzzles/p1/pieces/${id}/image`;
}

const DOWNLOADED_PNG: AssetDownloadResult = { kind: 'downloaded', extension: '.png', bytes: 128 };

type AssetBehavior = (
	url: string,
	destinationBasePath: string
) => AssetDownloadResult | Promise<AssetDownloadResult>;

class FakeFileOps implements DownloadFileOps {
	directories = new Set<string>();
	files = new Map<string, string | number>();
	removedDirectories: string[] = [];
	failMove = false;
	manifestWriteOperation: number | null = null;
	moveOperation: number | null = null;
	private operationCounter = 0;

	record(operation: string): number {
		this.operationCounter += 1;
		void operation;
		return this.operationCounter;
	}

	join(...parts: string[]): string {
		return parts.join('/');
	}

	async ensureDir(dirPath: string): Promise<void> {
		let current = dirPath.startsWith('/') ? '' : '.';
		for (const segment of dirPath.split('/').filter(Boolean)) {
			current =
				current === '' ? `/${segment}` : current === '.' ? segment : `${current}/${segment}`;
			this.directories.add(current);
		}
	}

	async directoryExists(dirPath: string): Promise<boolean> {
		return this.directories.has(dirPath);
	}

	async removeDir(dirPath: string): Promise<void> {
		this.removedDirectories.push(dirPath);
		for (const dir of [...this.directories]) {
			if (dir === dirPath || dir.startsWith(`${dirPath}/`)) this.directories.delete(dir);
		}
		for (const key of [...this.files.keys()]) {
			if (key === dirPath || key.startsWith(`${dirPath}/`)) this.files.delete(key);
		}
	}

	async moveDir(fromPath: string, toPath: string): Promise<void> {
		if (this.failMove) throw new Error('download_directory_move_failed');
		this.moveOperation = this.record(`move:${fromPath}->${toPath}`);
		this.directories.delete(fromPath);
		this.directories.add(toPath);
		for (const dir of [...this.directories]) {
			if (dir.startsWith(`${fromPath}/`)) {
				this.directories.delete(dir);
				this.directories.add(`${toPath}${dir.slice(fromPath.length)}`);
			}
		}
		for (const [key, value] of [...this.files]) {
			if (key.startsWith(`${fromPath}/`)) {
				this.files.delete(key);
				this.files.set(`${toPath}${key.slice(fromPath.length)}`, value);
			}
		}
	}

	async readText(filePath: string): Promise<string | null> {
		const entry = this.files.get(filePath);
		return typeof entry === 'string' ? entry : null;
	}

	async writeText(filePath: string, content: string): Promise<void> {
		if (filePath.endsWith('manifest.json')) {
			this.manifestWriteOperation = this.record(`write:${filePath}`);
		} else {
			this.record(`write:${filePath}`);
		}
		this.files.set(filePath, content);
	}

	async listDirectories(dirPath: string): Promise<string[]> {
		return [...this.directories].filter(
			(dir) => dir.startsWith(`${dirPath}/`) && !dir.slice(dirPath.length + 1).includes('/')
		);
	}

	async fileSize(filePath: string): Promise<number | null> {
		const entry = this.files.get(filePath);
		if (entry === undefined) return null;
		return typeof entry === 'number' ? entry : entry.length;
	}
}

interface Harness {
	fileOps: FakeFileOps;
	store: ReturnType<typeof createDownloadStore>;
	puzzle: ReadyPuzzle;
	calls: Array<{ url: string; destinationBasePath: string }>;
	setBehavior(behavior: AssetBehavior): void;
	lastAssetOperation(): number;
}

function makePiece(id: number, index: number, puzzleId: string): PuzzlePiece {
	return {
		id,
		puzzleId,
		correctX: index,
		correctY: 0,
		edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' },
		imagePath: `pieces/${puzzleId}/${id}.png`
	};
}

function readyPuzzle(pieceIds: number[], id = 'p1'): ReadyPuzzle {
	return {
		id,
		name: 'Test Puzzle',
		pieceCount: pieceIds.length,
		gridCols: pieceIds.length,
		gridRows: 1,
		imageWidth: 1024,
		imageHeight: 1024,
		createdAt: 1720000000000,
		pieces: pieceIds.map((pieceId, index) => makePiece(pieceId, index, id)),
		version: 1,
		status: 'ready'
	};
}

function makeHarness(pieceIds: number[] = [1, 2, 3, 4, 5, 6, 7]): Harness {
	const fileOps = new FakeFileOps();
	const calls: Array<{ url: string; destinationBasePath: string }> = [];
	let lastAssetOperation = 0;
	let behavior: AssetBehavior = () => DOWNLOADED_PNG;

	const downloader: AssetDownloader = async (url, destinationBasePath) => {
		calls.push({ url, destinationBasePath });
		const result = await behavior(url, destinationBasePath);
		lastAssetOperation = fileOps.record(`asset:${url}`);
		if (result.kind === 'downloaded') {
			fileOps.files.set(`${destinationBasePath}${result.extension}`, result.bytes);
		}
		return result;
	};

	return {
		fileOps,
		calls,
		setBehavior(next) {
			behavior = next;
		},
		lastAssetOperation: () => lastAssetOperation,
		puzzle: readyPuzzle(pieceIds),
		store: createDownloadStore({
			rootPath: ROOT,
			fileOps,
			downloadAsset: downloader,
			assetUrls: {
				thumbnailUrl: (id) => `http://api.test/puzzles/${id}/thumbnail`,
				referenceUrl: (id) => `http://api.test/puzzles/${id}/reference`,
				pieceImageUrl: (id, pieceId) => `http://api.test/puzzles/${id}/pieces/${pieceId}/image`
			},
			now: () => 1720000000000
		})
	};
}

async function seedValidPackage(
	harness: Harness,
	puzzle: ReadyPuzzle,
	packageFolder = puzzle.id
): Promise<string> {
	const root = `${ROOT}/${packageFolder}`;
	await harness.fileOps.ensureDir(`${root}/pieces`);
	const pieceFiles: Record<string, string> = {};
	for (const piece of puzzle.pieces) {
		harness.fileOps.files.set(`${root}/pieces/${piece.id}.png`, 100);
		pieceFiles[String(piece.id)] = `pieces/${piece.id}.png`;
	}
	harness.fileOps.files.set(`${root}/thumbnail.png`, 500);
	harness.fileOps.files.set(`${root}/reference.png`, 900);
	harness.fileOps.files.set(
		`${root}/manifest.json`,
		JSON.stringify(
			createDownloadManifest(
				puzzle,
				{ thumbnailFile: 'thumbnail.png', referenceFile: 'reference.png', pieceFiles },
				7
			)
		)
	);
	return root;
}

describe('downloadStore.downloadPuzzle', () => {
	it('installs a finalized package with manifest, assets, and absolute paths', async () => {
		const h = makeHarness([1, 2, 3]);
		const result = await h.store.downloadPuzzle(h.puzzle);

		expect(result.kind).toBe('installed');
		expect(result.packagePath).toBe(`${ROOT}/p1`);
		expect(result.thumbnailPath).toBe(`${ROOT}/p1/thumbnail.png`);
		expect(result.referencePath).toBe(`${ROOT}/p1/reference.png`);
		expect(result.piecePaths).toEqual({
			1: `${ROOT}/p1/pieces/1.png`,
			2: `${ROOT}/p1/pieces/2.png`,
			3: `${ROOT}/p1/pieces/3.png`
		});
		expect(result.manifest.downloadedAt).toBe(1720000000000);
		expect(h.calls.map((call) => call.url)).toEqual([
			THUMBNAIL_URL,
			REFERENCE_URL,
			pieceUrl(1),
			pieceUrl(2),
			pieceUrl(3)
		]);

		expect(await h.fileOps.directoryExists(`${ROOT}/p1`)).toBe(true);
		expect(await h.fileOps.directoryExists(`${ROOT}/.staging/p1`)).toBe(false);
		expect(await h.fileOps.readText(`${ROOT}/p1/manifest.json`)).toBe(
			JSON.stringify(result.manifest)
		);
		expect(h.fileOps.removedDirectories).toEqual([]);
	});

	it('keeps at most five asset requests in flight', async () => {
		const h = makeHarness(); // thumbnail + reference + 7 pieces = 9 requests
		const held: Array<(result: AssetDownloadResult) => void> = [];
		let beyondFirstChunk = false;
		h.setBehavior(() => {
			if (h.calls.length <= 5) {
				return new Promise<AssetDownloadResult>((resolve) => held.push(resolve));
			}
			beyondFirstChunk = true;
			return DOWNLOADED_PNG;
		});

		const downloading = h.store.downloadPuzzle(h.puzzle);
		await vi.waitFor(() => expect(held.length).toBe(5));

		expect(h.calls).toHaveLength(5);
		expect(beyondFirstChunk).toBe(false);

		for (const resolve of held) resolve(DOWNLOADED_PNG);
		await vi.waitFor(() => expect(beyondFirstChunk).toBe(true));

		await downloading;
		expect(h.calls).toHaveLength(9);
	});

	it('reports progress from zero to the full request count', async () => {
		const h = makeHarness();
		const progress: Array<[number, number]> = [];
		await h.store.downloadPuzzle(h.puzzle, undefined, (done, total) =>
			progress.push([done, total])
		);

		expect(progress[0]).toEqual([0, 9]);
		expect(progress.at(-1)).toEqual([9, 9]);
		expect(progress).toHaveLength(10);
	});

	it('writes the manifest last and moves staging into place afterwards', async () => {
		const h = makeHarness([1, 2, 3]);
		await h.store.downloadPuzzle(h.puzzle);

		expect(h.lastAssetOperation()).toBeLessThan(h.fileOps.manifestWriteOperation!);
		expect(h.fileOps.manifestWriteOperation!).toBeLessThan(h.fileOps.moveOperation!);
	});

	it('starts no second chunk after a failure and removes staging only after the chunk settles', async () => {
		const h = makeHarness(); // chunk 1: thumbnail, reference, pieces 1-3
		let releasePending!: (result: AssetDownloadResult) => void;
		h.setBehavior((url) => {
			if (url === pieceUrl(3)) return Promise.reject(new Error('download_http_500'));
			if (url === pieceUrl(2)) {
				return new Promise<AssetDownloadResult>((resolve) => {
					releasePending = resolve;
				});
			}
			return DOWNLOADED_PNG;
		});

		const downloading = h.store.downloadPuzzle(h.puzzle);
		await vi.waitFor(() => expect(releasePending).toBeDefined());
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(h.calls).toHaveLength(5);
		expect(h.fileOps.removedDirectories).not.toContain(`${ROOT}/.staging/p1`);

		releasePending(DOWNLOADED_PNG);
		await expect(downloading).rejects.toThrow('download_http_500');

		expect(h.calls).toHaveLength(5);
		expect(h.fileOps.removedDirectories).toContain(`${ROOT}/.staging/p1`);
	});

	it('downloads nothing when already cancelled', async () => {
		const h = makeHarness([1, 2, 3]);
		await expect(h.store.downloadPuzzle(h.puzzle, { cancelled: true })).rejects.toThrow(
			'download_cancelled'
		);
		expect(h.calls).toHaveLength(0);
		expect(h.fileOps.removedDirectories).toContain(`${ROOT}/.staging/p1`);
	});

	it('stops before the next chunk when cancelled mid-download', async () => {
		const h = makeHarness();
		const cancellation = { cancelled: false };
		await expect(
			h.store.downloadPuzzle(h.puzzle, cancellation, (done) => {
				if (done >= 5) cancellation.cancelled = true;
			})
		).rejects.toThrow('download_cancelled');

		expect(h.calls).toHaveLength(5);
		expect(h.fileOps.removedDirectories).toContain(`${ROOT}/.staging/p1`);
	});

	it('rejects a zero-byte required asset', async () => {
		const h = makeHarness([1, 2, 3]);
		h.setBehavior((url) =>
			url === pieceUrl(2) ? { kind: 'downloaded', extension: '.png', bytes: 0 } : DOWNLOADED_PNG
		);
		await expect(h.store.downloadPuzzle(h.puzzle)).rejects.toThrow('download_file_empty');
		expect(h.fileOps.removedDirectories).toContain(`${ROOT}/.staging/p1`);
	});

	it('cleans staging when the final move fails', async () => {
		const h = makeHarness([1, 2, 3]);
		h.fileOps.failMove = true;
		await expect(h.store.downloadPuzzle(h.puzzle)).rejects.toThrow(
			'download_directory_move_failed'
		);
		expect(h.fileOps.removedDirectories).toContain(`${ROOT}/.staging/p1`);
		expect(await h.fileOps.directoryExists(`${ROOT}/p1`)).toBe(false);
	});

	it('rejects when the final directory already exists', async () => {
		const h = makeHarness([1, 2, 3]);
		await h.fileOps.ensureDir(`${ROOT}/p1`);
		await expect(h.store.downloadPuzzle(h.puzzle)).rejects.toThrow('download_already_installed');
		expect(h.calls).toHaveLength(0);
	});

	it('rejects an unsafe puzzle id before any IO', async () => {
		const h = makeHarness([1, 2, 3]);
		await expect(h.store.downloadPuzzle({ ...h.puzzle, id: '../evil' })).rejects.toThrow(
			'invalid_puzzle_id'
		);
		await expect(h.store.downloadPuzzle({ ...h.puzzle, id: '.staging' })).rejects.toThrow(
			'invalid_puzzle_id'
		);
		expect(h.calls).toHaveLength(0);
		expect(h.fileOps.removedDirectories).toEqual([]);
	});

	it('clears a stale staging directory for the same puzzle before downloading', async () => {
		const h = makeHarness([1, 2, 3]);
		await h.fileOps.ensureDir(`${ROOT}/.staging/p1`);
		await h.fileOps.writeText(`${ROOT}/.staging/p1/leftover.txt`, 'stale');
		await h.store.downloadPuzzle(h.puzzle);

		expect(h.fileOps.removedDirectories).toContain(`${ROOT}/.staging/p1`);
		expect(await h.fileOps.readText(`${ROOT}/p1/leftover.txt`)).toBeNull();
	});

	it('rejects duplicate piece ids before building piece mappings', async () => {
		const h = makeHarness([1, 1, 2]);
		await expect(h.store.downloadPuzzle(h.puzzle)).rejects.toThrow('duplicate_piece_ids');
		expect(h.calls).toHaveLength(0);
		expect(h.fileOps.removedDirectories).toEqual([]);
		expect(await h.fileOps.directoryExists(`${ROOT}/.staging/p1`)).toBe(false);
		expect(await h.fileOps.directoryExists(`${ROOT}/p1`)).toBe(false);
	});
});

describe('downloadStore opportunistic reference', () => {
	it('omits the reference file when the reference 404s but keeps the install', async () => {
		const h = makeHarness([1, 2, 3]);
		h.setBehavior((url) => (url === REFERENCE_URL ? { kind: 'not_found' } : DOWNLOADED_PNG));

		const result = await h.store.downloadPuzzle(h.puzzle);

		expect(result.manifest.files.referenceFile).toBeUndefined();
		expect(result.referencePath).toBeUndefined();
		expect(result.manifest.files.thumbnailFile).toBe('thumbnail.png');
	});

	it('always attempts the reference request', async () => {
		const h = makeHarness([1, 2, 3]);
		await h.store.downloadPuzzle(h.puzzle);

		expect(h.calls.map((call) => call.url)).toContain(REFERENCE_URL);
	});

	it('fails the install when a required asset 404s', async () => {
		const thumbnailMissing = makeHarness([1, 2, 3]);
		thumbnailMissing.setBehavior((url) =>
			url === THUMBNAIL_URL ? { kind: 'not_found' } : DOWNLOADED_PNG
		);
		await expect(thumbnailMissing.store.downloadPuzzle(thumbnailMissing.puzzle)).rejects.toThrow(
			'required_asset_not_found'
		);

		const pieceMissing = makeHarness([1, 2, 3]);
		pieceMissing.setBehavior((url) =>
			url === pieceUrl(2) ? { kind: 'not_found' } : DOWNLOADED_PNG
		);
		await expect(pieceMissing.store.downloadPuzzle(pieceMissing.puzzle)).rejects.toThrow(
			'required_asset_not_found'
		);
	});

	it('fails the install when the reference request errors with a non-404', async () => {
		const h = makeHarness([1, 2, 3]);
		h.setBehavior((url) =>
			url === REFERENCE_URL ? Promise.reject(new Error('download_http_500')) : DOWNLOADED_PNG
		);
		await expect(h.store.downloadPuzzle(h.puzzle)).rejects.toThrow('download_http_500');
		expect(h.fileOps.removedDirectories).toContain(`${ROOT}/.staging/p1`);
	});
});

describe('downloadStore.scanDownloads and cleanupStaleStaging', () => {
	it('returns an empty list without creating the root when downloads are missing', async () => {
		const h = makeHarness([1]);
		expect(await h.store.scanDownloads()).toEqual([]);
		expect(await h.fileOps.directoryExists(ROOT)).toBe(false);
	});

	it('scans a real install as installed', async () => {
		const h = makeHarness([1, 2, 3]);
		const installed = await h.store.downloadPuzzle(h.puzzle);
		const entries = await h.store.scanDownloads();

		expect(entries).toHaveLength(1);
		const entry = entries[0] as InstalledDownload;
		expect(entry.kind).toBe('installed');
		expect(entry.packagePath).toBe(installed.packagePath);
		expect(entry.thumbnailPath).toBe(installed.thumbnailPath);
		expect(entry.referencePath).toBe(installed.referencePath);
		expect(entry.piecePaths).toEqual(installed.piecePaths);
		expect(entry.manifest.puzzle.id).toBe('p1');
	});

	it('ignores staging during scan; cleanup removes only staging children', async () => {
		const h = makeHarness([1, 2, 3]);
		await seedValidPackage(h, h.puzzle);
		await h.fileOps.ensureDir(`${ROOT}/.staging/in-progress`);
		await h.fileOps.writeText(`${ROOT}/.staging/in-progress/partial.bin`, 'x');

		const entries = await h.store.scanDownloads();
		expect(h.fileOps.removedDirectories).not.toContain(`${ROOT}/.staging/in-progress`);
		expect(entries).toHaveLength(1);

		await h.store.cleanupStaleStaging();
		expect(h.fileOps.removedDirectories).toContain(`${ROOT}/.staging/in-progress`);
		expect(h.fileOps.removedDirectories).not.toContain(`${ROOT}/p1`);
	});

	it('ensures the download roots exist during cleanup', async () => {
		const h = makeHarness([1]);
		await h.store.cleanupStaleStaging();
		expect(await h.fileOps.directoryExists(ROOT)).toBe(true);
		expect(await h.fileOps.directoryExists(`${ROOT}/.staging`)).toBe(true);
	});

	it('marks packages corrupt for missing, malformed, or unsupported manifests', async () => {
		const cases: Array<{
			name: string;
			mutate: (h: Harness, root: string) => void;
			reason: string;
		}> = [
			{
				name: 'missing manifest',
				mutate: (_h, root) => void _h.fileOps.files.delete(`${root}/manifest.json`),
				reason: 'download_manifest_missing'
			},
			{
				name: 'malformed manifest JSON',
				mutate: (h, root) => void h.fileOps.files.set(`${root}/manifest.json`, '{nope'),
				reason: 'invalid_download_manifest'
			},
			{
				name: 'unsupported schema version',
				mutate: (h, root) => {
					const manifest = JSON.parse(h.fileOps.files.get(`${root}/manifest.json`)! as string);
					manifest.schemaVersion = 2;
					h.fileOps.files.set(`${root}/manifest.json`, JSON.stringify(manifest));
				},
				reason: 'invalid_download_manifest'
			},
			{
				name: 'folder name differs from manifest puzzle id',
				mutate: async (h) => {
					await seedValidPackage(h, h.puzzle, 'p2');
				},
				reason: 'download_manifest_id_mismatch'
			}
		];

		for (const testCase of cases) {
			const h = makeHarness([1, 2, 3]);
			const root = await seedValidPackage(h, h.puzzle);
			await testCase.mutate(h, root);

			const entries = await h.store.scanDownloads();
			const entry = entries.find((candidate) => candidate.kind === 'corrupt');
			expect(entry, testCase.name).toBeDefined();
			expect(entry?.kind).toBe('corrupt');
			if (entry?.kind === 'corrupt') {
				expect(entry.reason, testCase.name).toBe(testCase.reason);
				expect(entry.packagePath, testCase.name).toBe(
					testCase.name === 'folder name differs from manifest puzzle id'
						? `${ROOT}/p2`
						: `${ROOT}/p1`
				);
			}
		}
	});

	it('marks packages corrupt for missing or zero-byte referenced files', async () => {
		const cases: Array<{ name: string; mutate: (h: Harness, root: string) => void }> = [
			{
				name: 'missing thumbnail',
				mutate: (_h, root) => void _h.fileOps.files.delete(`${root}/thumbnail.png`)
			},
			{
				name: 'zero-byte thumbnail',
				mutate: (h, root) => void h.fileOps.files.set(`${root}/thumbnail.png`, 0)
			},
			{
				name: 'missing reference',
				mutate: (_h, root) => void _h.fileOps.files.delete(`${root}/reference.png`)
			},
			{
				name: 'zero-byte reference',
				mutate: (h, root) => void h.fileOps.files.set(`${root}/reference.png`, 0)
			},
			{
				name: 'missing piece',
				mutate: (_h, root) => void _h.fileOps.files.delete(`${root}/pieces/2.png`)
			},
			{
				name: 'zero-byte piece',
				mutate: (h, root) => void h.fileOps.files.set(`${root}/pieces/3.png`, 0)
			}
		];

		for (const testCase of cases) {
			const h = makeHarness([1, 2, 3]);
			const root = await seedValidPackage(h, h.puzzle);
			await testCase.mutate(h, root);

			const entries = await h.store.scanDownloads();
			expect(entries, testCase.name).toHaveLength(1);
			const entry = entries[0]!;
			expect(entry.kind, testCase.name).toBe('corrupt');
			if (entry.kind === 'corrupt') {
				expect(entry.puzzleId, testCase.name).toBe('p1');
				expect(entry.packagePath, testCase.name).toBe(root);
			}
		}
	});

	it('never writes, creates, or removes anything during scan', async () => {
		const h = makeHarness([1, 2, 3]);
		await seedValidPackage(h, h.puzzle);
		const directoriesBefore = [...h.fileOps.directories];
		const filesBefore = [...h.fileOps.files.keys()];

		await h.store.scanDownloads();

		expect(h.fileOps.removedDirectories).toEqual([]);
		expect([...h.fileOps.directories]).toEqual(directoriesBefore);
		expect([...h.fileOps.files.keys()]).toEqual(filesBefore);
	});
});

describe('downloadStore.removeDownload', () => {
	it('removes only the finalized package directory', async () => {
		const h = makeHarness([1, 2, 3]);
		await seedValidPackage(h, h.puzzle);
		await seedValidPackage(h, readyPuzzle([1, 2], 'p2'));
		await h.fileOps.ensureDir(`${ROOT}/.staging/in-progress`);

		await h.store.removeDownload('p1');

		expect(h.fileOps.removedDirectories).toEqual([`${ROOT}/p1`]);
	});

	it('removes nested directories beneath the package directory', async () => {
		const h = makeHarness([1, 2, 3]);
		await seedValidPackage(h, h.puzzle);

		expect(await h.fileOps.directoryExists(`${ROOT}/p1/pieces`)).toBe(true);

		await h.store.removeDownload('p1');

		expect(await h.fileOps.directoryExists(`${ROOT}/p1`)).toBe(false);
		expect(await h.fileOps.directoryExists(`${ROOT}/p1/pieces`)).toBe(false);
		expect(h.fileOps.removedDirectories).toEqual([`${ROOT}/p1`]);
	});

	it('rejects unsafe puzzle ids without touching anything', async () => {
		const h = makeHarness([1, 2, 3]);
		await seedValidPackage(h, h.puzzle);

		await expect(h.store.removeDownload('../p2')).rejects.toThrow('invalid_puzzle_id');
		await expect(h.store.removeDownload('.staging')).rejects.toThrow('invalid_puzzle_id');
		await expect(h.store.removeDownload('a/b')).rejects.toThrow('invalid_puzzle_id');
		expect(h.fileOps.removedDirectories).toEqual([]);
	});
});
