import { describe, expect, it } from 'vitest';
import {
	createPuzzleSession,
	createSessionStorageAdapter,
	serializeSession,
	validationContextFrom,
	type Clock,
	type SessionKeyValueStore,
	type SessionPuzzleSpec,
	type SessionStorageAdapter
} from '@perseus/game-core';
import type { PuzzlePiece, ReadyPuzzle } from '@perseus/types';
import { createDownloadManifest, type DownloadedAssetFiles } from './downloadManifest';
import {
	createDownloadStore,
	type AssetDownloadResult,
	type DownloadFileOps,
	type InstalledDownload
} from './downloadStore';
import { actionsForProgress, buildDownloadedRows, classifyProgress } from './downloadedLibrary';

const IDS = [2, 7, 11, 19] as const;
const PUZZLE_ID = 'p1';
const RUN_ID = '11111111-1111-4111-8111-111111111111';

const canonicalPieces = IDS.map((id, index) => ({
	id,
	correctX: index % 2,
	correctY: Math.floor(index / 2)
}));

class ManualClock implements Clock {
	monotonicNow(): number {
		return 0;
	}

	wallNow(): number {
		return 1_000;
	}

	setInterval(callback: () => void, milliseconds: number): unknown {
		return { callback, milliseconds };
	}

	clearInterval(_handle: unknown): void {}
}

class MemorySessionStore implements SessionKeyValueStore {
	private readonly values = new Map<string, string>();

	getItem(puzzleId: string): string | null {
		return this.values.get(puzzleId) ?? null;
	}

	setItem(puzzleId: string, value: string): void {
		this.values.set(puzzleId, value);
	}

	removeItem(puzzleId: string): void {
		this.values.delete(puzzleId);
	}
}

function sessionSpec(): SessionPuzzleSpec {
	return {
		puzzleId: PUZZLE_ID,
		source: 'api',
		pieceCount: IDS.length,
		gridCols: 2,
		gridRows: 2,
		pieces: canonicalPieces
	};
}

function makePuzzle(): ReadyPuzzle {
	return {
		id: PUZZLE_ID,
		name: 'Test Puzzle',
		category: 'Nature',
		pieceCount: IDS.length,
		gridCols: 2,
		gridRows: 2,
		imageWidth: 1024,
		imageHeight: 1024,
		createdAt: 1720000000000,
		pieces: canonicalPieces.map(
			({ id, correctX, correctY }): PuzzlePiece => ({
				id,
				puzzleId: PUZZLE_ID,
				correctX,
				correctY,
				edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' },
				imagePath: `pieces/${PUZZLE_ID}/${id}.png`
			})
		),
		version: 1,
		status: 'ready'
	};
}

function validFiles(): DownloadedAssetFiles {
	return {
		thumbnailFile: 'thumbnail.png',
		referenceFile: 'reference.png',
		pieceFiles: Object.fromEntries(IDS.map((id) => [String(id), `pieces/${id}.png`]))
	};
}

function installedDownload(): InstalledDownload {
	const manifest = createDownloadManifest(makePuzzle(), validFiles(), 1);
	return {
		kind: 'installed',
		packagePath: `/downloads/${PUZZLE_ID}`,
		manifest,
		thumbnailPath: `/downloads/${PUZZLE_ID}/thumbnail.png`,
		referencePath: `/downloads/${PUZZLE_ID}/reference.png`,
		piecePaths: Object.fromEntries(
			IDS.map((id) => [id, `/downloads/${PUZZLE_ID}/pieces/${id}.png`])
		)
	};
}

function makeStorage(): {
	storage: SessionStorageAdapter;
	store: MemorySessionStore;
} {
	const store = new MemorySessionStore();
	return { store, storage: createSessionStorageAdapter({ store }) };
}

function makeSession() {
	return createPuzzleSession({
		metadata: sessionSpec(),
		clock: new ManualClock(),
		runIdFactory: { create: () => RUN_ID },
		initialTrayOrder: [...IDS]
	});
}

function saveSessionSnapshot(
	session: ReturnType<typeof makeSession>,
	storage: SessionStorageAdapter
) {
	const snapshot = serializeSession(session.getState(), 1_000);
	expect(snapshot).not.toBeNull();
	if (!snapshot) throw new Error('expected a serializable session');
	storage.saveSession(PUZZLE_ID, snapshot);
	return snapshot;
}

class FakeFileOps implements DownloadFileOps {
	directories = new Set<string>();
	files = new Map<string, string | number>();

	join(...parts: string[]): string {
		return parts.join('/');
	}

	async ensureDir(path: string): Promise<void> {
		this.directories.add(path);
	}

	async directoryExists(path: string): Promise<boolean> {
		return this.directories.has(path);
	}

	async removeDir(path: string): Promise<void> {
		this.directories.delete(path);
		for (const file of [...this.files.keys()]) {
			if (file === path || file.startsWith(`${path}/`)) this.files.delete(file);
		}
	}

	async moveDir(fromPath: string, toPath: string): Promise<void> {
		this.directories.delete(fromPath);
		this.directories.add(toPath);
		for (const [file, value] of [...this.files]) {
			if (file.startsWith(`${fromPath}/`)) {
				this.files.delete(file);
				this.files.set(`${toPath}${file.slice(fromPath.length)}`, value);
			}
		}
	}

	async readText(path: string): Promise<string | null> {
		const value = this.files.get(path);
		return typeof value === 'string' ? value : null;
	}

	async writeText(path: string, content: string): Promise<void> {
		this.files.set(path, content);
	}

	async listDirectories(path: string): Promise<string[]> {
		return [...this.directories].filter((entry) => entry.startsWith(`${path}/`));
	}

	async fileSize(path: string): Promise<number | null> {
		const value = this.files.get(path);
		if (value === undefined) return null;
		return typeof value === 'number' ? value : value.length;
	}
}

function makeDownloadStore(fileOps: FakeFileOps) {
	const downloaded: AssetDownloadResult = { kind: 'downloaded', extension: '.png', bytes: 1 };
	return createDownloadStore({
		rootPath: '/downloads',
		fileOps,
		downloadAsset: async (_url, destinationBasePath) => {
			fileOps.files.set(`${destinationBasePath}.png`, 1);
			return downloaded;
		},
		assetUrls: {
			thumbnailUrl: (id) => `/api/puzzles/${id}/thumbnail`,
			referenceUrl: (id) => `/api/puzzles/${id}/reference`,
			pieceImageUrl: (id, pieceId) => `/api/puzzles/${id}/pieces/${pieceId}/image`
		},
		now: () => 1
	});
}

describe('classifyProgress', () => {
	it('classifies a missing session as none', () => {
		const { storage } = makeStorage();

		expect(classifyProgress({ status: 'missing' }, storage)).toEqual({ kind: 'none' });
	});

	it('classifies a real zero-activity snapshot as none', () => {
		const { storage } = makeStorage();
		const session = makeSession();
		session.dispatch({ type: 'start' });
		const snapshot = saveSessionSnapshot(session, storage);
		const loaded = storage.peekSession(PUZZLE_ID, validationContextFrom(sessionSpec()));

		expect(loaded.status).toBe('loaded');
		if (loaded.status === 'loaded') {
			const zeroActivitySnapshot = loaded.snapshot;
			expect(zeroActivitySnapshot.hasUserActivity).toBe(false);
			expect(
				classifyProgress({ status: 'loaded', snapshot: zeroActivitySnapshot }, storage)
			).toEqual({
				kind: 'none'
			});
		}
		expect(snapshot.hasUserActivity).toBe(false);
	});

	it('classifies a real partial placement as resumable', () => {
		const { storage } = makeStorage();
		const session = makeSession();
		session.dispatch({ type: 'start' });
		session.dispatch({ type: 'attempt_placement', pieceId: IDS[0], x: 0, y: 0 });
		saveSessionSnapshot(session, storage);

		const loaded = storage.peekSession(PUZZLE_ID, validationContextFrom(sessionSpec()));
		expect(loaded.status).toBe('loaded');
		if (loaded.status === 'loaded') {
			expect(classifyProgress(loaded, storage)).toEqual({ kind: 'resumable' });
		}
	});

	it('classifies a real sealed completion as protected', () => {
		const { storage } = makeStorage();
		const session = makeSession();
		session.dispatch({ type: 'start' });
		for (const piece of canonicalPieces) {
			session.dispatch({
				type: 'attempt_placement',
				pieceId: piece.id,
				x: piece.correctX,
				y: piece.correctY
			});
		}
		const completedSnapshot = saveSessionSnapshot(session, storage);
		const loaded = storage.peekSession(PUZZLE_ID, validationContextFrom(sessionSpec()));

		expect(completedSnapshot.sealedCompletion).not.toBeNull();
		expect(loaded.status).toBe('loaded');
		if (loaded.status === 'loaded') {
			expect(classifyProgress(loaded, storage)).toEqual({ kind: 'protected' });
		}
	});

	it('reports changed canonical metadata as invalid through peekSession', () => {
		const { storage } = makeStorage();
		const session = makeSession();
		session.dispatch({ type: 'start' });
		session.dispatch({ type: 'attempt_placement', pieceId: IDS[0], x: 0, y: 0 });
		saveSessionSnapshot(session, storage);
		const changedSpec: SessionPuzzleSpec = {
			...sessionSpec(),
			pieces: canonicalPieces.map((piece) =>
				piece.id === IDS[0] ? { ...piece, correctX: 1 } : piece
			)
		};

		const loaded = storage.peekSession(PUZZLE_ID, validationContextFrom(changedSpec));

		expect(loaded).toEqual({ status: 'invalid', reason: 'cross_field_violation' });
		expect(classifyProgress(loaded, storage)).toEqual({
			kind: 'invalid',
			reason: 'cross_field_violation'
		});
	});
});

describe('actionsForProgress', () => {
	it.each([
		[{ kind: 'none' }, ['start', 'remove_download']],
		[{ kind: 'resumable' }, ['resume', 'discard_progress', 'remove_download']],
		[{ kind: 'protected' }, ['discard_progress', 'remove_download']],
		[{ kind: 'invalid', reason: 'cross_field_violation' }, ['discard_progress', 'remove_download']]
	] as const)('maps %j to the intended actions', (progress, actions) => {
		expect(actionsForProgress(progress)).toEqual(actions);
	});
});

describe('buildDownloadedRows', () => {
	it('uses peekSession and derives a row for an installed download', () => {
		const { storage } = makeStorage();
		const session = makeSession();
		session.dispatch({ type: 'start' });
		session.dispatch({ type: 'attempt_placement', pieceId: IDS[0], x: 0, y: 0 });
		saveSessionSnapshot(session, storage);
		const calls = { peek: 0, load: 0 };
		const trackingStorage: SessionStorageAdapter = {
			...storage,
			peekSession(puzzleId, context) {
				calls.peek += 1;
				return storage.peekSession(puzzleId, context);
			},
			loadSession(puzzleId, context) {
				calls.load += 1;
				return storage.loadSession(puzzleId, context);
			}
		};
		const install = installedDownload();

		expect(buildDownloadedRows([install], trackingStorage)).toEqual([
			{ install, progress: { kind: 'resumable' } }
		]);
		expect(calls).toEqual({ peek: 1, load: 0 });
	});
});

describe('download removal and re-download', () => {
	it('preserves a session when the finalized package is removed and reinstalled', async () => {
		const { storage, store: sessionStore } = makeStorage();
		const fileOps = new FakeFileOps();
		const downloadStore = makeDownloadStore(fileOps);
		const puzzle = makePuzzle();
		const session = makeSession();
		session.dispatch({ type: 'start' });
		session.dispatch({ type: 'attempt_placement', pieceId: IDS[0], x: 0, y: 0 });
		saveSessionSnapshot(session, storage);

		const installed = await downloadStore.downloadPuzzle(puzzle);
		await downloadStore.removeDownload(PUZZLE_ID);

		expect(await fileOps.directoryExists(installed.packagePath)).toBe(false);
		expect(sessionStore.getItem(PUZZLE_ID)).not.toBeNull();

		const redownloaded = await downloadStore.downloadPuzzle(puzzle);
		expect(buildDownloadedRows([redownloaded], storage)).toEqual([
			{ install: redownloaded, progress: { kind: 'resumable' } }
		]);
	});
});
