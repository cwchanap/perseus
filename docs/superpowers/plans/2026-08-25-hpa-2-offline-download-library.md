# HPA-2 Explicit Downloads and Offline Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the HPA-1 bundled fixture with an explicit-download mobile gallery and filesystem-derived Downloaded library that can start and resume finalized puzzle packages completely offline.

**Architecture:** Keep all new behavior mobile-local. A narrow API service fetches existing public puzzle contracts, a versioned mobile manifest describes one finalized package, `DownloadStore` stages/finalizes assets with five-way bounded concurrency, and the Downloaded view is rebuilt by scanning manifests plus the existing session adapter. `App.svelte` owns only local screen/service composition; downloaded packages feed the existing HPA-1 Canvas/PuzzleSession path.

**Tech Stack:** NativeScript 9, Svelte Native 4, TypeScript 5.9, `@nativescript/core` `Http`/FileSystem, `@perseus/types`, `@perseus/game-core`, Vitest 4, Bun 1.3.14.

**Spec:** `docs/superpowers/specs/2026-08-25-hpa-2-offline-download-library-design.md`

## Global Constraints

- Deliver HPA-2 as **one implementation PR**. The commits below are review checkpoints inside that PR, not separate PRs.
- Use only the existing public `/api/puzzles` and asset endpoints. Do not change `apps/api`, `apps/workflows`, Cloudflare infrastructure, or a database schema.
- Add no new third-party runtime dependency. `@perseus/types` is an existing workspace package and is the only dependency addition expected in `apps/mobile/package.json`.
- Keep `@perseus/game-core` unchanged unless implementation proves an existing exported contract is unusable; stop and revise the design before expanding shared-core scope.
- One puzzle download at a time; exactly **5** concurrent asset requests inside that download.
- `manifest.json` is written last in staging; only a successful same-volume directory move makes a package installed.
- Unknown manifest schema versions are corrupt; do not add compatibility migration code.
- The Downloaded library is derived by scanning files every load/refresh. Do not add SQLite, `downloads.json`, a session index, or another derived catalog.
- Download removal never deletes progress. Progress deletion uses the existing `SessionStorageAdapter.clearSession()` explicitly.
- Downloaded server puzzles keep `SessionPuzzleSpec.source = 'api'`.
- No resumable partial downloads, ZIP endpoint, background download service, search/category parity, auth/sync, portrait work, or HPA-3 production gameplay parity.
- Keep the existing HPA-1 board interaction/layout during this ticket; delete the HPA-1 fixture code/assets once dynamic installed-package assets work.

---

### Task 1: Add the mobile public-puzzle API boundary

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `apps/mobile/webpack.config.js`
- Create: `apps/mobile/types/globals.d.ts`
- Create: `apps/mobile/app/api/puzzleApi.ts`
- Create: `apps/mobile/app/api/puzzleApi.test.ts`
- Create: `apps/mobile/app/api/nativePuzzleHttp.ts`

**Interfaces:**
- Produces:

```ts
export interface PublicReadyPuzzle extends ReadyPuzzle {
	hasReference?: boolean;
}

export type PuzzleJsonRequest = (url: string) => Promise<unknown>;

export interface PuzzleApi {
	listPuzzles(cursor?: string): Promise<PuzzleListResponse>;
	getPuzzle(puzzleId: string): Promise<PublicReadyPuzzle>;
	thumbnailUrl(puzzleId: string): string;
	referenceUrl(puzzleId: string): string;
	pieceImageUrl(puzzleId: string, pieceId: number): string;
}

export function createPuzzleApi(options: {
	baseUrl: string;
	requestJson: PuzzleJsonRequest;
}): PuzzleApi;

export const nativePuzzleJsonRequest: PuzzleJsonRequest;
```

- Later tasks consume `PuzzleApi`, `PublicReadyPuzzle`, and `__PERSEUS_API_BASE__`.

- [ ] **Step 1: Add the shared API type dependency and build-time API base declaration**

Add `"@perseus/types": "workspace:*"` next to `@perseus/game-core` in `apps/mobile/package.json`.

Create `apps/mobile/types/globals.d.ts`:

```ts
declare const __PERSEUS_API_BASE__: string;
```

Extend the existing webpack config after `webpack.init(env)` without replacing its current aliases:

```js
const apiBase = process.env.PERSEUS_MOBILE_API_BASE ?? 'http://localhost:4690';

webpack.chainWebpack((config) => {
	config.plugin('DefinePlugin').tap((args) => {
		args[0].__PERSEUS_API_BASE__ = JSON.stringify(apiBase);
		return args;
	});
});
```

Do not add runtime settings or dotenv code.

- [ ] **Step 2: Write failing API service tests**

Create `apps/mobile/app/api/puzzleApi.test.ts` with a reusable request recorder and these assertions:

```ts
import { describe, expect, it } from 'vitest';
import { createPuzzleApi } from './puzzleApi';

function readyPuzzle(id = 'p1') {
	return {
		id,
		name: 'Test Puzzle',
		pieceCount: 4,
		gridCols: 2,
		gridRows: 2,
		imageWidth: 800,
		imageHeight: 800,
		createdAt: 1,
		pieces: [
			{ id: 0, puzzleId: id, correctX: 0, correctY: 0, edges: {}, imagePath: 'ignored' },
			{ id: 1, puzzleId: id, correctX: 1, correctY: 0, edges: {}, imagePath: 'ignored' },
			{ id: 2, puzzleId: id, correctX: 0, correctY: 1, edges: {}, imagePath: 'ignored' },
			{ id: 3, puzzleId: id, correctX: 1, correctY: 1, edges: {}, imagePath: 'ignored' }
		],
		version: 1,
		status: 'ready' as const,
		hasReference: true
	};
}

describe('createPuzzleApi', () => {
	it('uses the server cursor without adding mobile pagination state', async () => {
		const urls: string[] = [];
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async (url) => {
				urls.push(url);
				return { puzzles: [], total: 20, offset: 0, limit: 20, nextCursor: 'next-1' };
			}
		});

		await api.listPuzzles('cursor-1');
		expect(urls).toEqual(['https://api.example.test/api/puzzles?cursor=cursor-1']);
	});

	it('accepts only a ready puzzle detail response', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => readyPuzzle()
		});
		await expect(api.getPuzzle('p1')).resolves.toMatchObject({ id: 'p1', status: 'ready' });
	});

	it('rejects a non-ready puzzle before download orchestration', async () => {
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test',
			requestJson: async () => ({ ...readyPuzzle(), status: 'processing' })
		});
		await expect(api.getPuzzle('p1')).rejects.toThrow('puzzle_not_ready');
	});
});
```

Use complete `EdgeConfig` values (`flat` on the outer edges and any valid complementary values internally) in the final fixture so it satisfies the `PuzzlePiece` type; do not weaken shared types with casts to `any`.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
bun run --cwd apps/mobile test:unit -- app/api/puzzleApi.test.ts
```

Expected: FAIL because `./puzzleApi` does not exist.

- [ ] **Step 4: Implement the API service**

In `puzzleApi.ts`, keep validation deliberately bounded to fields HPA-2 relies on. Normalize one optional trailing slash from `baseUrl`, encode puzzle IDs, and reject response shapes that cannot safely drive a download.

Core shape:

```ts
import type { PuzzleListResponse, ReadyPuzzle } from '@perseus/types';

export interface PublicReadyPuzzle extends ReadyPuzzle {
	hasReference?: boolean;
}

export type PuzzleJsonRequest = (url: string) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function createPuzzleApi(options: {
	baseUrl: string;
	requestJson: PuzzleJsonRequest;
}): PuzzleApi {
	const baseUrl = options.baseUrl.replace(/\/$/, '');

	return {
		async listPuzzles(cursor) {
			const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
			const value = record(await options.requestJson(`${baseUrl}/api/puzzles${query}`));
			if (!value || !Array.isArray(value.puzzles) || typeof value.total !== 'number') {
				throw new Error('invalid_puzzle_list_response');
			}
			return value as unknown as PuzzleListResponse;
		},
		async getPuzzle(puzzleId) {
			const value = record(
				await options.requestJson(`${baseUrl}/api/puzzles/${encodeURIComponent(puzzleId)}`)
			);
			if (!value || value.status !== 'ready' || value.id !== puzzleId || !Array.isArray(value.pieces)) {
				throw new Error(value?.status === 'ready' ? 'invalid_puzzle_response' : 'puzzle_not_ready');
			}
			return value as unknown as PublicReadyPuzzle;
		},
		thumbnailUrl: (puzzleId) => `${baseUrl}/api/puzzles/${encodeURIComponent(puzzleId)}/thumbnail`,
		referenceUrl: (puzzleId) => `${baseUrl}/api/puzzles/${encodeURIComponent(puzzleId)}/reference`,
		pieceImageUrl: (puzzleId, pieceId) =>
			`${baseUrl}/api/puzzles/${encodeURIComponent(puzzleId)}/pieces/${pieceId}/image`
	};
}
```

Do not copy the web `ApiError`/auth/admin client into mobile.

- [ ] **Step 5: Implement the NativeScript JSON request adapter**

Create `nativePuzzleHttp.ts`:

```ts
import { Http } from '@nativescript/core';
import type { PuzzleJsonRequest } from './puzzleApi';

export const nativePuzzleJsonRequest: PuzzleJsonRequest = async (url) => {
	const response = await Http.request({ url, method: 'GET' });
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(`puzzle_api_http_${response.statusCode}`);
	}
	return response.content?.toJSON();
};
```

Do not add retry/auth behavior here.

- [ ] **Step 6: Run tests and TypeScript check**

Run:

```bash
bun run --cwd apps/mobile test:unit -- app/api/puzzleApi.test.ts
bunx tsc --project apps/mobile/tsconfig.json --noEmit
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/package.json apps/mobile/webpack.config.js apps/mobile/types/globals.d.ts apps/mobile/app/api
git commit -m "feat(mobile): add public puzzle API client"
```

---

### Task 2: Define and validate the finalized download manifest

**Files:**
- Create: `apps/mobile/app/library/downloadManifest.ts`
- Create: `apps/mobile/app/library/downloadManifest.test.ts`

**Interfaces:**
- Consumes: `PublicReadyPuzzle` from Task 1.
- Produces:

```ts
export interface DownloadManifestV1 { /* exact schema from spec */ }

export interface DownloadedAssetFiles {
	thumbnailFile: string;
	referenceFile?: string;
	pieceFiles: Record<string, string>;
}

export function createDownloadManifest(
	puzzle: PublicReadyPuzzle,
	files: DownloadedAssetFiles,
	downloadedAt: number
): DownloadManifestV1;

export function parseDownloadManifest(value: unknown): DownloadManifestV1;
export function sessionSpecFromManifest(manifest: DownloadManifestV1): SessionPuzzleSpec;
```

- [ ] **Step 1: Write manifest RED tests**

Create tests for one 2x2 ready puzzle:

```ts
it('drops remote image paths and projects an api SessionPuzzleSpec', () => {
	const manifest = createDownloadManifest(readyPuzzle(), {
		thumbnailFile: 'thumbnail.webp',
		referenceFile: 'reference.jpg',
		pieceFiles: {
			'0': 'pieces/0.png',
			'1': 'pieces/1.png',
			'2': 'pieces/2.png',
			'3': 'pieces/3.png'
		}
	}, 1234);

	expect(manifest.schemaVersion).toBe(1);
	expect(JSON.stringify(manifest)).not.toContain('imagePath');
	expect(sessionSpecFromManifest(manifest)).toEqual({
		puzzleId: 'p1',
		source: 'api',
		pieceCount: 4,
		gridCols: 2,
		gridRows: 2,
		pieces: [
			{ id: 0, correctX: 0, correctY: 0 },
			{ id: 1, correctX: 1, correctY: 0 },
			{ id: 2, correctX: 0, correctY: 1 },
			{ id: 3, correctX: 1, correctY: 1 }
		]
	});
});
```

Add separate rejection tests for:

- `schemaVersion: 2`;
- piece count not matching `gridCols * gridRows`;
- duplicate/missing piece ID;
- duplicate/out-of-bounds canonical cell;
- missing piece-file mapping;
- absolute path, backslash path, or any `.`/`..` path segment.

- [ ] **Step 2: Run the manifest test and verify RED**

```bash
bun run --cwd apps/mobile test:unit -- app/library/downloadManifest.test.ts
```

Expected: FAIL because `downloadManifest.ts` does not exist.

- [ ] **Step 3: Implement the v1 contract and safe-path validator**

Use the exact schema in the design. Keep the validator local and explicit:

```ts
function isSafeRelativeFile(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\\')) {
		return false;
	}
	return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}
```

`parseDownloadManifest()` must require:

```ts
manifest.pieceCount === manifest.gridCols * manifest.gridRows
manifest.pieces.length === manifest.pieceCount
new Set(manifest.pieces.map((piece) => piece.id)).size === manifest.pieceCount
new Set(manifest.pieces.map((piece) => `${piece.correctX}:${piece.correctY}`)).size === manifest.pieceCount
Object.keys(manifest.pieceFiles).length === manifest.pieceCount
```

Also require IDs exactly `0..pieceCount - 1`, integer in-bounds coordinates, finite positive image dimensions, and safe filenames.

`createDownloadManifest()` should construct the small local shape from the server detail and immediately call `parseDownloadManifest()` before returning it. Do not persist `status`, `version`, `imagePath`, or `idempotencyKey`.

- [ ] **Step 4: Implement the game-core projection**

```ts
export function sessionSpecFromManifest(manifest: DownloadManifestV1): SessionPuzzleSpec {
	return {
		puzzleId: manifest.puzzleId,
		source: 'api',
		pieceCount: manifest.pieceCount,
		gridCols: manifest.gridCols,
		gridRows: manifest.gridRows,
		pieces: manifest.pieces.map(({ id, correctX, correctY }) => ({ id, correctX, correctY }))
	};
}
```

- [ ] **Step 5: Run focused and full mobile unit tests**

```bash
bun run --cwd apps/mobile test:unit -- app/library/downloadManifest.test.ts
bun run --cwd apps/mobile test:unit
```

Expected: PASS, including the pre-existing board/session tests.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/library/downloadManifest.ts apps/mobile/app/library/downloadManifest.test.ts
git commit -m "feat(mobile): define offline download manifest"
```

---

### Task 3: Stage, finalize, scan, and remove filesystem packages

**Files:**
- Create: `apps/mobile/app/library/downloadStore.ts`
- Create: `apps/mobile/app/library/downloadStore.test.ts`
- Create: `apps/mobile/app/library/nativeDownloadFiles.ts`

**Interfaces:**
- Consumes: `PuzzleApi`, `PublicReadyPuzzle`, manifest functions from Tasks 1-2.
- Produces:

```ts
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

export interface DownloadedAsset {
	extension: '.png' | '.jpg' | '.webp';
	bytes: number;
}

export type AssetDownloader = (
	url: string,
	destinationBasePath: string
) => Promise<DownloadedAsset>;

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
	downloadPuzzle(puzzle: PublicReadyPuzzle, cancellation?: DownloadCancellation): Promise<InstalledDownload>;
	scanDownloads(): Promise<DownloadScanEntry[]>;
	removeDownload(puzzleId: string): Promise<void>;
}
```

- `createNativeDownloadFileOps()` and `downloadNativeAsset()` provide the production NativeScript implementation.

- [ ] **Step 1: Write RED tests for the atomic lifecycle**

Build an in-memory fake that records every operation and tracks directories/files. The first test must pin ordering, not NativeScript internals:

```ts
it('writes manifest last and moves staging only after every asset verifies', async () => {
	const operations: string[] = [];
	const store = createDownloadStore(fixtureDependencies(operations));

	await store.downloadPuzzle(readyPuzzle());

	const manifestWrite = operations.findIndex((entry) => entry.startsWith('write:') && entry.endsWith('/manifest.json'));
	const finalMove = operations.findIndex((entry) => entry.startsWith('move:') && entry.includes('/.staging/p1->'));
	const lastAsset = Math.max(...operations.map((entry, index) => entry.startsWith('asset:') ? index : -1));

	expect(lastAsset).toBeLessThan(manifestWrite);
	expect(manifestWrite).toBeLessThan(finalMove);
});
```

Add tests that assert:

- maximum observed active asset downloader calls is exactly `<= 5` on a puzzle with at least 12 pieces;
- any asset rejection removes `.staging/p1` and never calls `moveDir`;
- `cancellation.cancelled = true` prevents finalization and removes staging;
- a zero-byte/missing expected file prevents manifest write/finalization;
- `removeDownload('p1')` touches only `downloads/p1`, never `sessions/`.

- [ ] **Step 2: Write RED tests for direct scan/corruption behavior**

Seed the fake filesystem with finalized package directories and assert:

```ts
it('derives installed downloads from manifests without an index', async () => {
	const entries = await store.scanDownloads();
	expect(entries).toEqual([
		expect.objectContaining({ kind: 'installed', manifest: expect.objectContaining({ puzzleId: 'p1' }) })
	]);
	expect(fake.readPaths).not.toContain(expect.stringContaining('downloads.json'));
});
```

Add cases for:

- stale `.staging/p1` is removed before results are returned;
- missing `manifest.json` => `kind: 'corrupt'`;
- invalid JSON/unsupported schema => corrupt;
- valid manifest with one missing/zero-byte piece => corrupt;
- corrupt rows are never returned as `InstalledDownload`.

- [ ] **Step 3: Run the store tests and verify RED**

```bash
bun run --cwd apps/mobile test:unit -- app/library/downloadStore.test.ts
```

Expected: FAIL because `downloadStore.ts` does not exist.

- [ ] **Step 4: Implement bounded download scheduling**

Use one private constant and one private scheduler in `downloadStore.ts`:

```ts
const ASSET_CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T) => Promise<R>,
	cancelled: () => boolean
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;

	async function runWorker(): Promise<void> {
		while (nextIndex < items.length) {
			if (cancelled()) throw new Error('download_cancelled');
			const index = nextIndex++;
			results[index] = await worker(items[index]!);
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () => runWorker())
	);
	return results;
}
```

Build one asset list containing thumbnail, optional reference, and every piece. Destination bases are `thumbnail`, `reference`, and `pieces/<id>`; the native downloader chooses the extension from Content-Type.

Wrap the full staging operation in `try/finally` with a `finalized` boolean. If `finalized` is false, remove only that puzzle's staging directory. Do not keep failed-download metadata.

Before writing the manifest, call `fileSize()` for every returned final asset path and require a positive value. Then create/validate the manifest, write `manifest.json`, move staging to the final package directory, set `finalized = true`, and return the resolved installed package.

- [ ] **Step 5: Implement direct scan and remove**

`scanDownloads()` must:

1. ensure `downloads/` and `downloads/.staging/` exist;
2. remove every direct child of `.staging/`;
3. enumerate only direct child directories of `downloads/` excluding `.staging`;
4. parse each `manifest.json`;
5. require the folder name to equal `manifest.puzzleId`;
6. require every referenced file to have `fileSize > 0`;
7. resolve local absolute paths into `InstalledDownload`;
8. return a `CorruptDownload` on any package-local failure rather than aborting the whole scan.

`removeDownload(puzzleId)` joins only `downloads/<puzzleId>` and removes that directory. Validate `puzzleId` is a single safe path segment before joining it.

- [ ] **Step 6: Implement the NativeScript filesystem/asset adapter**

Use documented `File`, `Folder`, `Http`, and `path` APIs in `nativeDownloadFiles.ts`.

Content-Type mapping is fixed:

```ts
function imageExtension(contentType: string | undefined): DownloadedAsset['extension'] {
	switch (contentType?.split(';', 1)[0]?.trim().toLowerCase()) {
		case 'image/png': return '.png';
		case 'image/jpeg': return '.jpg';
		case 'image/webp': return '.webp';
		default: throw new Error('unsupported_download_image_type');
	}
}
```

`downloadNativeAsset()` performs one `Http.request({ url, method: 'GET' })`, rejects non-2xx, picks the extension, saves `response.content.toFile(destinationBasePath + extension)`, and returns the saved file size. A missing response content object is `download_empty_response`.

For `moveDir(fromPath, toPath)`, use the platform's same-volume native rename/move rather than copy/delete:

- iOS: `NSFileManager.defaultManager.moveItemAtPathToPathError(fromPath, toPath, null)` and verify `Folder.exists(toPath)` afterward;
- Android: `new java.io.File(fromPath).renameTo(new java.io.File(toPath))` and require `true`.

Throw `download_directory_move_failed` if the move cannot be verified. Do not add a generic cross-platform filesystem package.

- [ ] **Step 7: Run store tests, all mobile tests, and TypeScript**

```bash
bun run --cwd apps/mobile test:unit -- app/library/downloadStore.test.ts
bun run --cwd apps/mobile test:unit
bunx tsc --project apps/mobile/tsconfig.json --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/app/library/downloadStore.ts apps/mobile/app/library/downloadStore.test.ts apps/mobile/app/library/nativeDownloadFiles.ts
git commit -m "feat(mobile): add atomic puzzle downloads"
```

---

### Task 4: Revalidate saved progress against downloaded metadata

**Files:**
- Create: `apps/mobile/app/library/downloadedLibrary.ts`
- Create: `apps/mobile/app/library/downloadedLibrary.test.ts`

**Interfaces:**
- Consumes: `InstalledDownload`, `SessionStorageAdapter`, `sessionSpecFromManifest()`, `validationContextFrom()`.
- Produces:

```ts
export type ProgressState =
	| { kind: 'none' }
	| { kind: 'resumable' }
	| { kind: 'invalid'; reason: string };

export interface DownloadedPuzzleRow {
	install: InstalledDownload;
	progress: ProgressState;
}

export interface GameplayLaunch {
	install: InstalledDownload;
	mode: 'start' | 'resume';
}

export function buildDownloadedRows(
	installed: readonly InstalledDownload[],
	storage: SessionStorageAdapter
): DownloadedPuzzleRow[];
```

- [ ] **Step 1: Write RED tests for the three progress states**

Use a real `createSessionStorageAdapter()` with an in-memory `SessionKeyValueStore` so the tests exercise the shared validator instead of reimplementing it.

Create one valid persisted snapshot by constructing a real `PuzzleSession` from the 2x2 `SessionPuzzleSpec`, dispatching `start`, placing piece 0 correctly, and calling `serializeSession(session.getState())`. Save it through the adapter.

Assert:

```ts
expect(buildDownloadedRows([matchingInstall], storage)[0]?.progress).toEqual({ kind: 'resumable' });
expect(buildDownloadedRows([installWithoutSave], emptyStorage)[0]?.progress).toEqual({ kind: 'none' });
```

Then change piece 0's canonical coordinate in a second manifest while keeping the same stable `puzzleId`; assert the retained snapshot produces `kind: 'invalid'` rather than `resumable`.

- [ ] **Step 2: Run the test and verify RED**

```bash
bun run --cwd apps/mobile test:unit -- app/library/downloadedLibrary.test.ts
```

Expected: FAIL because `downloadedLibrary.ts` does not exist.

- [ ] **Step 3: Implement progress projection using game-core only**

```ts
import { validationContextFrom, type SessionStorageAdapter } from '@perseus/game-core';
import { sessionSpecFromManifest } from './downloadManifest';

export function buildDownloadedRows(
	installed: readonly InstalledDownload[],
	storage: SessionStorageAdapter
): DownloadedPuzzleRow[] {
	return installed.map((install) => {
		const context = validationContextFrom(sessionSpecFromManifest(install.manifest));
		const loaded = storage.peekSession(install.manifest.puzzleId, context);

		if (loaded.status === 'invalid') {
			return { install, progress: { kind: 'invalid', reason: loaded.reason } };
		}
		if (loaded.status === 'loaded' && storage.isResumable(loaded.snapshot)) {
			return { install, progress: { kind: 'resumable' } };
		}
		return { install, progress: { kind: 'none' } };
	});
}
```

Do not delete invalid sessions in this function. Do not add a second session parser.

- [ ] **Step 4: Prove Remove Download / re-download independence**

Extend the test to:

1. create/save resumable progress;
2. call `downloadStore.removeDownload(puzzleId)` on the filesystem fake;
3. assert `storage.peekSession()` still returns `loaded` when given the retained matching context;
4. seed a newly downloaded matching manifest and assert `buildDownloadedRows()` returns `resumable` again.

This is the HPA-2 regression fence that download deletion never owns session deletion.

- [ ] **Step 5: Run mobile unit tests**

```bash
bun run --cwd apps/mobile test:unit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/library/downloadedLibrary.ts apps/mobile/app/library/downloadedLibrary.test.ts
git commit -m "feat(mobile): derive downloaded progress state"
```

---

### Task 5: Add the concrete Gallery / Downloaded library page

**Files:**
- Modify: `apps/mobile/app/App.svelte`
- Modify: `apps/mobile/app/app.css`
- Create: `apps/mobile/app/library/Library.svelte`
- Create: `apps/mobile/app/library/Gallery.svelte`
- Create: `apps/mobile/app/library/Downloaded.svelte`

**Interfaces:**
- Consumes all Task 1-4 services/types.
- `Library.svelte` props:

```ts
export let puzzleApi: PuzzleApi;
export let downloadStore: DownloadStore;
export let sessionStorage: SessionStorageAdapter;
export let onLaunch: (launch: GameplayLaunch) => void;
```

- `App.svelte` produces one local screen state:

```ts
type MobileScreen =
	| { kind: 'library' }
	| { kind: 'gameplay'; launch: GameplayLaunch };
```

- [ ] **Step 1: Move service composition to `App.svelte`**

Construct the existing session adapter once in the app root using the same HPA-1 paths/implementations:

```ts
const perseusRoot = path.join(knownFolders.documents().path, 'perseus');
const sessionsRoot = path.join(perseusRoot, 'sessions');
const downloadsRoot = path.join(perseusRoot, 'downloads');

const sessionStorage = createSessionStorageAdapter({
	store: createFileSessionKeyValueStore({
		rootPath: sessionsRoot,
		fileOps: createNativeSessionFileOps()
	})
});

const puzzleApi = createPuzzleApi({
	baseUrl: __PERSEUS_API_BASE__,
	requestJson: nativePuzzleJsonRequest
});

const downloadStore = createDownloadStore({
	rootPath: downloadsRoot,
	fileOps: createNativeDownloadFileOps(),
	downloadAsset: downloadNativeAsset,
	assetUrls: puzzleApi,
	now: () => Date.now()
});
```

Keep these as concrete values; do not add a service container/context/global store.

Render `<Library ... />` or `<Gameplay ... />` directly from the local `screen` discriminant inside the existing `<frame>`.

- [ ] **Step 2: Implement Gallery as a presentation component**

`Gallery.svelte` receives `puzzles`, `installedIds`, `downloadingPuzzleId`, and callbacks. Render a `scrollView`/`stackLayout` with one row per `PuzzleSummary`:

```svelte
{#each puzzles as puzzle (puzzle.id)}
	<gridLayout columns="96,*,auto" rows="auto,auto" class="library-row">
		<image rowSpan="2" width="88" height="88" stretch="aspectFill" src={thumbnailUrl(puzzle.id)} />
		<label col="1" text={puzzle.name} class="library-title" />
		<label col="1" row="1" text={`${puzzle.pieceCount} pieces`} class="library-meta" />
		<button
			col="2"
			rowSpan="2"
			text={installedIds.has(puzzle.id) ? 'DOWNLOADED' : downloadingPuzzleId === puzzle.id ? 'DOWNLOADING…' : 'DOWNLOAD'}
			isEnabled={!installedIds.has(puzzle.id) && downloadingPuzzleId === null}
			on:tap={() => onDownload(puzzle.id)}
		/>
	</gridLayout>
{/each}
```

Add a `LOAD MORE` button only when `nextCursor` exists. Do not add search/category controls.

- [ ] **Step 3: Implement Downloaded as a presentation component**

For each valid row:

- show local thumbnail/name/piece count;
- show **RESUME** only for `progress.kind === 'resumable'`;
- otherwise show **START**, except when `progress.kind === 'invalid'`, where **START** stays disabled until the player taps **DISCARD PROGRESS**;
- show **REMOVE DOWNLOAD** independently;
- show **DISCARD PROGRESS** for `resumable` or `invalid`.

For `CorruptDownload`, render its puzzle ID and reason plus only **REMOVE & DOWNLOAD AGAIN** and **REMOVE DOWNLOAD**. Do not pass it to `onLaunch`.

- [ ] **Step 4: Implement Library orchestration with one active job**

`Library.svelte` owns only view/request state:

```ts
let section: 'gallery' | 'downloaded' = 'gallery';
let gallery: PuzzleSummary[] = [];
let nextCursor: string | undefined;
let scanEntries: DownloadScanEntry[] = [];
let downloadedRows: DownloadedPuzzleRow[] = [];
let downloadingPuzzleId: string | null = null;
let cancellation: DownloadCancellation | null = null;
let errorMessage: string | null = null;
```

On mount, run `refreshDownloads()` and `loadGallery(false)` independently so the Downloaded section remains usable if the network request fails.

`refreshDownloads()` calls `downloadStore.scanDownloads()`, splits valid/corrupt entries, and rebuilds valid rows through `buildDownloadedRows()`.

`downloadPuzzle(id)` must:

1. set one cancellation token and `downloadingPuzzleId`;
2. fetch canonical ready detail with `puzzleApi.getPuzzle(id)`;
3. call `downloadStore.downloadPuzzle(detail, cancellation)`;
4. refresh disk-derived state;
5. clear the active job in `finally`.

`cancelDownload()` only sets `cancellation.cancelled = true`; it does not pretend NativeScript can abort an already-started request.

`discardProgress(puzzleId)` calls only `sessionStorage.clearSession(puzzleId)`, then refreshes.

`removeDownload(puzzleId)` calls only `downloadStore.removeDownload(puzzleId)`, then refreshes.

`removeAndDownloadAgain(puzzleId)` removes the corrupt final package, refreshes, then calls the same `downloadPuzzle(puzzleId)` path. No repair branch.

- [ ] **Step 5: Add minimal shared library styling**

Use the existing dark HPA-1 palette in `app.css`. Add only concrete classes consumed by these three components (`library-page`, `library-tabs`, `library-row`, `library-title`, `library-meta`, `library-error`, `library-actions`). Do not extract a design system or responsive layout abstraction; HPA-3/HPA-46 own later production/adaptive UI.

- [ ] **Step 6: Run service tests, TypeScript, and formatting**

```bash
bun run --cwd apps/mobile test:unit
bunx tsc --project apps/mobile/tsconfig.json --noEmit
bunx prettier --check apps/mobile/app apps/mobile/types apps/mobile/webpack.config.js apps/mobile/package.json
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/app/App.svelte apps/mobile/app/app.css apps/mobile/app/library
git commit -m "feat(mobile): add gallery and downloaded library"
```

---

### Task 6: Feed finalized package assets into gameplay and delete the HPA-1 fixture

**Files:**
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Delete: `apps/mobile/app/gameplay/fixture.ts`
- Delete: `apps/mobile/app/assets/hpa-1/piece-0.png`
- Delete: `apps/mobile/app/assets/hpa-1/piece-1.png`
- Delete: `apps/mobile/app/assets/hpa-1/piece-2.png`
- Delete: `apps/mobile/app/assets/hpa-1/piece-3.png`

**Interfaces:**
- `Gameplay.svelte` props:

```ts
export let launch: GameplayLaunch;
export let storage: SessionStorageAdapter;
export let onExit: () => void;
```

- `PuzzleCanvas.svelte` gains:

```ts
export let piecePaths: Record<number, string>;
```

- [ ] **Step 1: Make Canvas image loading dynamic**

Delete `PIECE_IDS` and `~/assets/hpa-1/...` from `PuzzleCanvas.svelte`.

Replace `loadPieces()` with:

```ts
function loadPieces(): void {
	pieceImages = {};
	for (const [rawPieceId, imagePath] of Object.entries(piecePaths)) {
		const pieceId = Number(rawPieceId);
		const image = new ImageAsset();
		if (Number.isInteger(pieceId) && image.fromFileSync(imagePath)) {
			pieceImages[pieceId] = image;
		}
	}
}
```

Leave board sizing, hit testing, density conversion, and tap/drag placement unchanged. HPA-2 is not the tray/gesture rewrite.

- [ ] **Step 2: Replace fixture construction with `GameplayLaunch`**

At component initialization:

```ts
const spec = sessionSpecFromManifest(launch.install.manifest);
const context = validationContextFrom(spec);
const loaded = launch.mode === 'resume'
	? storage.loadSession(spec.puzzleId, context)
	: { status: 'missing' as const };

const restored =
	loaded.status === 'loaded' && storage.isResumable(loaded.snapshot)
		? loaded.snapshot
		: undefined;

const resumeUnavailable = launch.mode === 'resume' && restored === undefined;
```

Only construct/start `PuzzleSession` when `resumeUnavailable` is false. A resume race/corrupt save renders a concise “Saved progress is no longer resumable” state plus a **BACK TO LIBRARY** action; it does not silently start a fresh run.

For a fresh launch, keep `restored: undefined` and derive initial tray IDs from `spec.pieces.map((piece) => piece.id)`. Preserve the HPA-1 clock/run-ID/lifecycle checkpoint behavior.

Every persistence call uses `spec.puzzleId`, never a fixture ID.

- [ ] **Step 3: Pass package asset paths to Canvas and remove diagnostic copy**

Render:

```svelte
<PuzzleCanvas
	{sessionState}
	piecePaths={launch.install.piecePaths}
	onSelectPiece={selectPiece}
	onAttemptPlacement={attemptPlacement}
/>
```

Change the title from `HPA-1 Offline 2x2` to `launch.install.manifest.name` and the placed counter denominator to `sessionState.pieceCount`.

Keep a small **LIBRARY** button that calls `persist()` before `onExit()` for an active session. Do not add pause/restart/toolbar parity here.

- [ ] **Step 4: Delete the fixture path completely**

Delete `fixture.ts` and all four bundled fixture PNGs. Search before committing:

```bash
rg "HPA1_FIXTURE|assets/hpa-1|PIECE_IDS|HPA-1 Offline" apps/mobile
```

Expected: no matches.

Do not retain a fallback bundle or compatibility import.

- [ ] **Step 5: Run all mobile tests and static checks**

```bash
bun run --cwd apps/mobile test:unit
bunx tsc --project apps/mobile/tsconfig.json --noEmit
bunx prettier --check apps/mobile/app apps/mobile/types apps/mobile/webpack.config.js apps/mobile/package.json
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A apps/mobile/app
git commit -m "feat(mobile): launch downloaded puzzles offline"
```

---

### Task 7: Prove the HPA-2 filesystem/network boundary on iPad and finish the single PR

**Files:**
- No new production file is expected.
- Update the implementation PR body with the concrete smoke evidence and exact environment used.

**Interfaces:**
- Consumes the completed HPA-2 implementation.
- Produces acceptance evidence for the existing NativeScript filesystem move, real public asset transfer, relaunch discovery, offline gameplay/resume, and download/progress independence.

- [ ] **Step 1: Run repository-level non-native gates**

From repository root:

```bash
bun run --cwd apps/mobile test:unit
bunx tsc --project apps/mobile/tsconfig.json --noEmit
bunx prettier --check apps/mobile/app apps/mobile/types apps/mobile/webpack.config.js apps/mobile/package.json
bun run check
bun run lint
```

Expected: all commands PASS. If an unrelated aggregate host test remains blocked by a pre-existing environment issue, record it precisely; do not weaken HPA-2's focused mobile tests.

- [ ] **Step 2: Start a reachable API and build the iOS app**

For local Worker development:

```bash
bun run dev --filter=@perseus/api
```

In another shell:

```bash
cd apps/mobile
PERSEUS_MOBILE_API_BASE=http://localhost:4690 ns run ios --no-hmr
```

If testing a physical iPad, use a LAN/HTTPS API base reachable by that device rather than `localhost`. Do not add a runtime API-base settings screen.

Record NativeScript CLI, `@nativescript/core`, `@nativescript/canvas`, Xcode, simulator/device model, and iOS versions in the PR body.

- [ ] **Step 3: Prove download finalization and relaunch reconstruction**

In the running app:

1. open Gallery;
2. download one ready puzzle;
3. confirm it appears in Downloaded only after the action completes;
4. inspect the app Documents container and confirm:

```text
perseus/downloads/<puzzleId>/manifest.json
perseus/downloads/<puzzleId>/thumbnail.<ext>
perseus/downloads/<puzzleId>/pieces/<pieceId>.<ext>
```

5. confirm there is no remaining `perseus/downloads/.staging/<puzzleId>`;
6. terminate and relaunch the app without downloading again;
7. confirm the same Downloaded row is reconstructed from disk.

This is the platform proof for the cross-parent same-volume directory move.

- [ ] **Step 4: Prove start and resume with networking unavailable**

Stop the local API (or otherwise disable the simulator/device's network after the package is finalized).

From Downloaded:

1. start the installed puzzle;
2. place at least one piece;
3. leave/terminate the app so the existing session checkpoint runs;
4. relaunch while the API is still unavailable;
5. open Downloaded and confirm **Resume** is available without a successful Gallery request;
6. resume and confirm the placed-piece/counter state is retained.

Do not treat a failed Gallery refresh as a library failure; Downloaded must remain usable.

- [ ] **Step 5: Prove Remove Download preserves progress and re-download restores resumability**

While the saved session is still resumable:

1. tap **Remove Download**;
2. verify `perseus/downloads/<puzzleId>` is gone;
3. verify `perseus/sessions/<puzzleId>.json` still exists;
4. re-enable the API/network;
5. download the same stable puzzle ID again;
6. confirm Downloaded shows **Resume** after game-core validation;
7. resume and confirm the retained placement remains.

- [ ] **Step 6: Prove corrupt-package recovery**

Delete one finalized `pieces/<pieceId>.<ext>` file from the app container and refresh/relaunch.

Expected:

- the package is not launchable;
- it is rendered as corrupt;
- **Remove & Download Again** is offered;
- activating that action removes the corrupt package and performs the same clean download path;
- the repaired package becomes installed only after finalization.

- [ ] **Step 7: Final diff-scope and design checks**

Run:

```bash
git diff --name-only main...HEAD
rg "sqlite|downloads\.json|zip|background download|HPA1_FIXTURE|assets/hpa-1" apps/mobile docs/superpowers/specs/2026-08-25-hpa-2-offline-download-library-design.md docs/superpowers/plans/2026-08-25-hpa-2-offline-download-library.md
```

Expected implementation diff:

- mobile API/config/type changes;
- mobile library/download files;
- mobile app/gameplay integration;
- deletion of HPA-1 fixture code/assets;
- the planning docs already merged/available from the planning PR if the implementation branch starts after it.

No backend/database/infrastructure production files should appear. The search may match explicit non-goal prose in docs; it must not match forbidden production machinery in `apps/mobile`.

- [ ] **Step 8: Commit any verification-only metadata changes and keep one implementation PR**

If smoke evidence required only PR-body edits, make no extra code commit. If a repository text file was intentionally updated during verification, commit it once:

```bash
git add <intentional-text-file>
git commit -m "docs: record HPA-2 verification"
```

Do not open a second HPA-2 implementation PR.

## Self-Review Results

- **Spec coverage:** Every HPA-2 acceptance criterion maps to Tasks 1-7: existing public API, explicit staging/finalization, direct disk discovery, offline start/resume, independent asset/progress removal, matching re-download revalidation, corrupt-package blocking/re-download, and service/native tests.
- **Scope:** No API, Workflow, database, game-core, index, ZIP, auth, sync, portrait, or production-gameplay expansion is planned.
- **Atomicity:** Asset verification precedes manifest write; manifest write precedes the staging-to-final move; failed/cancelled work removes staging.
- **Type consistency:** `PublicReadyPuzzle` feeds `createDownloadManifest`; `DownloadManifestV1` feeds `InstalledDownload`; `InstalledDownload` feeds `DownloadedPuzzleRow`/`GameplayLaunch`; the same manifest projects `SessionPuzzleSpec` for both library validation and gameplay construction.
- **Progress ownership:** `DownloadStore` has no session dependency. Only the library's explicit Discard action calls `SessionStorageAdapter.clearSession()`.
- **Fixture removal:** Dynamic `piecePaths` replaces the only HPA-1 bundled-asset dependency, so no backward-compatible fixture path remains.
- **No placeholders:** Implementation steps define the file paths, exported signatures, critical algorithms, failure behavior, test assertions, commands, and stop condition needed to execute the ticket.
