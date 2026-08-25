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
- One puzzle download at a time; exactly **5** concurrent asset requests inside that download when at least five assets remain.
- `manifest.json` is written last in staging; only a successful same-volume directory move makes a package installed.
- A failed/cancelled batch waits for already-started requests to settle before staging cleanup; no request may write into a directory being removed.
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
- Modify: `bun.lock`
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

- [ ] **Step 1: Add the shared API type dependency and build-time API base**

Add `"@perseus/types": "workspace:*"` next to `@perseus/game-core` in `apps/mobile/package.json`, then run:

```bash
bun install
```

Commit the resulting `bun.lock` change with this task.

Create `apps/mobile/types/globals.d.ts`:

```ts
declare const __PERSEUS_API_BASE__: string;
```

Extend the existing `apps/mobile/webpack.config.js` after `webpack.init(env)` without replacing its current aliases:

```js
const apiBase = process.env.PERSEUS_MOBILE_API_BASE ?? 'http://localhost:4690';

webpack.chainWebpack((config) => {
	config.plugin('DefinePlugin').tap((args) => {
		args[0].__PERSEUS_API_BASE__ = JSON.stringify(apiBase);
		return args;
	});
});
```

Do not add runtime settings, dotenv, or another configuration service.

- [ ] **Step 2: Write failing API service tests**

Create `apps/mobile/app/api/puzzleApi.test.ts` with this typed fixture and the three behavioral cases below:

```ts
import { describe, expect, it } from 'vitest';
import type { ReadyPuzzle } from '@perseus/types';
import { createPuzzleApi } from './puzzleApi';

const flatEdges = {
	top: 'flat',
	right: 'flat',
	bottom: 'flat',
	left: 'flat'
} as const;

function readyPuzzle(id = 'p1'): ReadyPuzzle & { hasReference: boolean } {
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
			{ id: 0, puzzleId: id, correctX: 0, correctY: 0, edges: flatEdges, imagePath: 'ignored/0' },
			{ id: 1, puzzleId: id, correctX: 1, correctY: 0, edges: flatEdges, imagePath: 'ignored/1' },
			{ id: 2, puzzleId: id, correctX: 0, correctY: 1, edges: flatEdges, imagePath: 'ignored/2' },
			{ id: 3, puzzleId: id, correctX: 1, correctY: 1, edges: flatEdges, imagePath: 'ignored/3' }
		],
		version: 1,
		status: 'ready',
		hasReference: true
	};
}

describe('createPuzzleApi', () => {
	it('uses the existing cursor without inventing mobile pagination state', async () => {
		const urls: string[] = [];
		const api = createPuzzleApi({
			baseUrl: 'https://api.example.test/',
			requestJson: async (url) => {
				urls.push(url);
				return { puzzles: [], total: 20, offset: 0, limit: 20, nextCursor: 'next-1' };
			}
		});

		const page = await api.listPuzzles('cursor-1');
		expect(urls).toEqual(['https://api.example.test/api/puzzles?cursor=cursor-1']);
		expect(page.nextCursor).toBe('next-1');
	});

	it('accepts a ready puzzle detail response', async () => {
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

- [ ] **Step 3: Run the focused test and verify RED**

```bash
cd apps/mobile
bunx vitest run app/api/puzzleApi.test.ts
```

Expected: FAIL because `./puzzleApi` does not exist.

- [ ] **Step 4: Implement the API service**

Create `puzzleApi.ts` with bounded runtime validation for only the fields HPA-2 uses:

```ts
import type { PuzzleListResponse, PuzzleSummary, ReadyPuzzle } from '@perseus/types';

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

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function isReadySummary(value: unknown): value is PuzzleSummary {
	const item = record(value);
	return !!item &&
		typeof item.id === 'string' &&
		typeof item.name === 'string' &&
		typeof item.pieceCount === 'number' &&
		item.status === 'ready';
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
			if (
				!value ||
				!Array.isArray(value.puzzles) ||
				!value.puzzles.every(isReadySummary) ||
				typeof value.total !== 'number' ||
				typeof value.offset !== 'number' ||
				typeof value.limit !== 'number' ||
				(value.nextCursor !== undefined && typeof value.nextCursor !== 'string')
			) {
				throw new Error('invalid_puzzle_list_response');
			}
			return value as unknown as PuzzleListResponse;
		},
		async getPuzzle(puzzleId) {
			const value = record(
				await options.requestJson(`${baseUrl}/api/puzzles/${encodeURIComponent(puzzleId)}`)
			);
			if (!value || value.status !== 'ready') throw new Error('puzzle_not_ready');
			if (value.id !== puzzleId || !Array.isArray(value.pieces)) {
				throw new Error('invalid_puzzle_response');
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

The deeper grid/piece/file validation belongs to the mobile manifest in Task 2. Do not copy web auth/admin/error-client machinery.

- [ ] **Step 5: Implement the NativeScript JSON adapter**

Create `nativePuzzleHttp.ts`:

```ts
import { Http } from '@nativescript/core';
import type { PuzzleJsonRequest } from './puzzleApi';

export const nativePuzzleJsonRequest: PuzzleJsonRequest = async (url) => {
	const response = await Http.request({ url, method: 'GET' });
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(`puzzle_api_http_${response.statusCode}`);
	}
	if (!response.content) throw new Error('puzzle_api_empty_response');
	return response.content.toJSON();
};
```

- [ ] **Step 6: Run GREEN checks**

```bash
cd apps/mobile
bunx vitest run app/api/puzzleApi.test.ts
cd ../..
bunx tsc --project apps/mobile/tsconfig.json --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/package.json apps/mobile/webpack.config.js apps/mobile/types/globals.d.ts apps/mobile/app/api bun.lock
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
export interface DownloadManifestV1 {
	schemaVersion: 1;
	puzzleId: string;
	name: string;
	category?: PuzzleCategory;
	aspectRatio?: PuzzleAspectRatio;
	pieceCount: number;
	gridCols: number;
	gridRows: number;
	imageWidth: number;
	imageHeight: number;
	pieces: Array<{ id: number; correctX: number; correctY: number }>;
	thumbnailFile: string;
	referenceFile?: string;
	pieceFiles: Record<string, string>;
	downloadedAt: number;
}

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

Create a 2x2 test detail using the same typed `ReadyPuzzle` shape from Task 1 and assert:

```ts
it('drops remote image paths and projects an api SessionPuzzleSpec', () => {
	const manifest = createDownloadManifest(
		readyPuzzle(),
		{
			thumbnailFile: 'thumbnail.webp',
			referenceFile: 'reference.jpg',
			pieceFiles: {
				'0': 'pieces/0.png',
				'1': 'pieces/1.png',
				'2': 'pieces/2.png',
				'3': 'pieces/3.png'
			}
		},
		1234
	);

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

Add separate rejection tests for schema version 2, non-positive dimensions, `pieceCount !== gridCols * gridRows`, duplicate/missing IDs, duplicate/out-of-bounds cells, incomplete `pieceFiles`, and unsafe relative paths (`/absolute.png`, `../piece.png`, `pieces\\0.png`, `pieces/../0.png`).

- [ ] **Step 2: Verify RED**

```bash
cd apps/mobile
bunx vitest run app/library/downloadManifest.test.ts
```

Expected: FAIL because `downloadManifest.ts` does not exist.

- [ ] **Step 3: Implement the manifest codec**

Import `PUZZLE_CATEGORIES`, `isPuzzleAspectRatio`, and the shared types from `@perseus/types`; import `SessionPuzzleSpec` from `@perseus/game-core`.

Use this safe-path rule:

```ts
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
```

`parseDownloadManifest()` must require all of these invariants before returning a fresh typed object:

```ts
manifest.schemaVersion === 1
manifest.pieceCount === manifest.gridCols * manifest.gridRows
manifest.pieces.length === manifest.pieceCount
new Set(manifest.pieces.map((piece) => piece.id)).size === manifest.pieceCount
new Set(manifest.pieces.map((piece) => `${piece.correctX}:${piece.correctY}`)).size === manifest.pieceCount
Object.keys(manifest.pieceFiles).length === manifest.pieceCount
```

Also require:

- integer IDs exactly `0..pieceCount - 1`;
- integer `correctX/correctY` inside the grid;
- finite positive `imageWidth`/`imageHeight`;
- optional category in `PUZZLE_CATEGORIES`;
- optional aspect ratio accepted by `isPuzzleAspectRatio()`;
- a safe thumbnail/reference path and one safe `pieceFiles[String(id)]` for every piece.

`createDownloadManifest()` constructs only the local fields from `PublicReadyPuzzle` plus downloaded filenames and immediately validates the result by calling `parseDownloadManifest()`.

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

Do not persist server `status`, `version`, `idempotencyKey`, `edges`, or remote `imagePath` values.

- [ ] **Step 5: Run GREEN checks and commit**

```bash
cd apps/mobile
bunx vitest run app/library/downloadManifest.test.ts
bun run test:unit
cd ../..
bunx tsc --project apps/mobile/tsconfig.json --noEmit
git add apps/mobile/app/library/downloadManifest.ts apps/mobile/app/library/downloadManifest.test.ts
git commit -m "feat(mobile): define offline download manifest"
```

Expected: all checks PASS.

---

### Task 3: Stage, finalize, scan, and remove filesystem packages

**Files:**
- Create: `apps/mobile/app/library/downloadStore.ts`
- Create: `apps/mobile/app/library/downloadStore.test.ts`
- Create: `apps/mobile/app/library/nativeDownloadFiles.ts`

**Interfaces:**
- Consumes: `PuzzleApi`, `PublicReadyPuzzle`, and Task 2 manifest helpers.
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
	downloadPuzzle(
		puzzle: PublicReadyPuzzle,
		cancellation?: DownloadCancellation
	): Promise<InstalledDownload>;
	scanDownloads(): Promise<DownloadScanEntry[]>;
	removeDownload(puzzleId: string): Promise<void>;
}
```

- [ ] **Step 1: Write RED tests for atomic download ordering and concurrency**

Create an in-memory `DownloadFileOps` plus `AssetDownloader` that records operations and tracks active calls. Pin these behaviors:

```ts
it('writes manifest last and moves staging only after every asset verifies', async () => {
	const operations: string[] = [];
	const store = createDownloadStore(fixtureDependencies(operations));

	await store.downloadPuzzle(readyPuzzle());

	const manifestWrite = operations.findIndex(
		(entry) => entry.startsWith('write:') && entry.endsWith('/manifest.json')
	);
	const finalMove = operations.findIndex(
		(entry) => entry.startsWith('move:') && entry.includes('/.staging/p1->')
	);
	const lastAsset = Math.max(
		...operations.map((entry, index) => (entry.startsWith('asset:') ? index : -1))
	);

	expect(lastAsset).toBeLessThan(manifestWrite);
	expect(manifestWrite).toBeLessThan(finalMove);
});
```

With a puzzle containing at least 12 pieces, block the downloader promises until five calls are active, then release them. Assert `maxActive === 5` and never greater than 5.

Add tests that any asset rejection, cooperative cancellation, zero-byte file, or failed move leaves no finalized package and removes `.staging/p1`.

For the failure case, deliberately keep another asset promise in flight after the first one rejects and assert the staging `removeDir` operation occurs only after that second promise settles. This fences the cleanup race.

- [ ] **Step 2: Write RED tests for scan/corrupt/remove behavior**

Seed the fake filesystem directly, without an index. Assert:

```ts
it('derives installed downloads from finalized manifests', async () => {
	const entries = await store.scanDownloads();
	expect(entries).toEqual([
		expect.objectContaining({
			kind: 'installed',
			manifest: expect.objectContaining({ puzzleId: 'p1' })
		})
	]);
	expect(fake.readPaths.some((value) => value.includes('downloads.json'))).toBe(false);
});
```

Add cases for stale `.staging/p1` cleanup, missing manifest, malformed/unsupported manifest, missing/zero-byte referenced piece, folder-name/manifest-ID mismatch, and `removeDownload('p1')` touching only `downloads/p1`.

- [ ] **Step 3: Verify RED**

```bash
cd apps/mobile
bunx vitest run app/library/downloadStore.test.ts
```

Expected: FAIL because `downloadStore.ts` does not exist.

- [ ] **Step 4: Implement a bounded scheduler that settles in-flight work before throwing**

Use exactly this control shape so the outer `finally` cannot remove staging while another started request is still writing:

```ts
const ASSET_CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T) => Promise<R>,
	isCancelled: () => boolean
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	let stopped = false;
	let firstError: unknown = null;

	async function runWorker(): Promise<void> {
		while (!stopped) {
			if (isCancelled()) {
				firstError ??= new Error('download_cancelled');
				stopped = true;
				return;
			}

			const index = nextIndex++;
			if (index >= items.length) return;

			try {
				results[index] = await worker(items[index]!);
			} catch (error) {
				firstError ??= error;
				stopped = true;
			}
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () => runWorker())
	);

	if (isCancelled()) firstError ??= new Error('download_cancelled');
	if (firstError !== null) throw firstError;
	return results;
}
```

Already-started requests finish before `Promise.all()` resolves; no new work is scheduled after the first error/cancel flag.

- [ ] **Step 5: Implement `downloadPuzzle()`**

`createDownloadStore()` accepts:

```ts
{
	rootPath: string;
	fileOps: DownloadFileOps;
	downloadAsset: AssetDownloader;
	assetUrls: Pick<PuzzleApi, 'thumbnailUrl' | 'referenceUrl' | 'pieceImageUrl'>;
	now: () => number;
}
```

For one puzzle:

1. validate `puzzle.id` is one non-empty path segment with no `/`, `\\`, `.`, or `..`;
2. reject with `download_already_installed` if `downloads/<id>` already exists;
3. remove stale `downloads/.staging/<id>` and create its `pieces` child;
4. build one asset work list for thumbnail, optional reference when `hasReference === true`, and every piece ID;
5. run the list through `mapWithConcurrency(..., 5, ...)`;
6. turn returned extensions into relative names (`thumbnail.png`, `reference.jpg`, `pieces/0.webp`, etc.);
7. verify `fileSize(path) > 0` for every expected file;
8. create/validate the manifest and write `manifest.json` last;
9. move `.staging/<id>` to `downloads/<id>`;
10. mark `finalized = true` and return resolved absolute paths.

Wrap steps 3-9 in `try/finally`; if `finalized` is false, remove only that puzzle's staging directory after the scheduler has settled.

- [ ] **Step 6: Implement direct scan and removal**

`scanDownloads()` must:

- ensure `downloads/` and `.staging/` exist;
- remove every direct child directory of `.staging/` before scanning finalized packages;
- enumerate only direct child directories of `downloads/` except `.staging`;
- parse each `manifest.json` and require the folder name equals `manifest.puzzleId`;
- verify every referenced file is present and non-empty;
- resolve `thumbnailPath`, optional `referencePath`, and `piecePaths` with `fileOps.join()`;
- catch errors per package and return `CorruptDownload` without aborting other rows.

`removeDownload(puzzleId)` validates the single segment and removes only `downloads/<puzzleId>`. It has no session dependency by design.

- [ ] **Step 7: Implement the NativeScript filesystem and asset adapter**

Create `nativeDownloadFiles.ts` with `File`, `Folder`, `Http`, `isAndroid`, `isIOS`, and `path` from `@nativescript/core`.

Use exact image mapping:

```ts
function header(
	headers: Record<string, string> | undefined,
	name: string
): string | undefined {
	const target = name.toLowerCase();
	return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === target)?.[1];
}

function imageExtension(contentType: string | undefined): DownloadedAsset['extension'] {
	switch (contentType?.split(';', 1)[0]?.trim().toLowerCase()) {
		case 'image/png': return '.png';
		case 'image/jpeg': return '.jpg';
		case 'image/webp': return '.webp';
		default: throw new Error('unsupported_download_image_type');
	}
}
```

If NativeScript's header value type is wider than `string`, normalize it to `String(value)` at this boundary rather than weakening `DownloadStore` types.

`downloadNativeAsset(url, destinationBasePath)`:

```ts
const response = await Http.request({ url, method: 'GET' });
if (response.statusCode < 200 || response.statusCode >= 300) {
	throw new Error(`download_http_${response.statusCode}`);
}
if (!response.content) throw new Error('download_empty_response');
const extension = imageExtension(header(response.headers as Record<string, string>, 'content-type'));
const file = response.content.toFile(destinationBasePath + extension);
if (!file || file.size <= 0) throw new Error('download_empty_file');
return { extension, bytes: file.size };
```

For `moveDir(fromPath, toPath)`, use one same-volume native move:

```ts
if (isIOS) {
	const moved = NSFileManager.defaultManager.moveItemAtPathToPathError(fromPath, toPath, null);
	if (!moved || !Folder.exists(toPath)) throw new Error('download_directory_move_failed');
	return;
}
if (isAndroid) {
	const moved = new java.io.File(fromPath).renameTo(new java.io.File(toPath));
	if (!moved || !Folder.exists(toPath)) throw new Error('download_directory_move_failed');
	return;
}
throw new Error('download_directory_move_unsupported');
```

Implement the remaining `DownloadFileOps` directly with `Folder.fromPath()/exists()/getEntities()/remove()`, `File.fromPath()/exists()/readText()/writeText()`, and `path.join()`. Do not add a filesystem package or copy/delete finalization path.

- [ ] **Step 8: Run GREEN checks and commit**

```bash
cd apps/mobile
bunx vitest run app/library/downloadStore.test.ts
bun run test:unit
cd ../..
bunx tsc --project apps/mobile/tsconfig.json --noEmit
git add apps/mobile/app/library/downloadStore.ts apps/mobile/app/library/downloadStore.test.ts apps/mobile/app/library/nativeDownloadFiles.ts
git commit -m "feat(mobile): add atomic puzzle downloads"
```

Expected: PASS.

---

### Task 4: Revalidate retained progress against downloaded metadata

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

- [ ] **Step 1: Write RED integration tests with the real game-core validator**

Use `createSessionStorageAdapter()` over an in-memory `SessionKeyValueStore`. Create a real 2x2 `PuzzleSession` with a fixed clock/run-ID factory, dispatch `start`, place piece 0 at `(0, 0)`, call `serializeSession()`, and save the snapshot through the adapter.

Assert the matching installed manifest is resumable:

```ts
expect(buildDownloadedRows([matchingInstall], storage)[0]?.progress).toEqual({
	kind: 'resumable'
});
```

With an empty storage adapter, assert `kind: 'none'`.

Keep the same stable puzzle ID but change piece 0's canonical coordinate in a second manifest; assert the retained snapshot yields:

```ts
expect(buildDownloadedRows([changedInstall], storage)[0]?.progress).toEqual({
	kind: 'invalid',
	reason: 'cross_field_violation'
});
```

This proves re-download validation is based on canonical metadata, not only puzzle ID.

- [ ] **Step 2: Verify RED**

```bash
cd apps/mobile
bunx vitest run app/library/downloadedLibrary.test.ts
```

Expected: FAIL because `downloadedLibrary.ts` does not exist.

- [ ] **Step 3: Implement progress projection using game-core only**

```ts
import { validationContextFrom, type SessionStorageAdapter } from '@perseus/game-core';
import type { InstalledDownload } from './downloadStore';
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

Do not call `loadSession()` here: `loadSession()` deletes invalid saves, while the Downloaded view must surface invalid retained progress for an explicit Discard action.

- [ ] **Step 4: Prove download/progress independence**

Extend the integration test:

1. save the resumable snapshot;
2. call `downloadStore.removeDownload('p1')` on the Task 3 filesystem fake;
3. assert the session key still exists;
4. seed a newly finalized matching package with puzzle ID `p1`;
5. assert `buildDownloadedRows()` returns `resumable` again.

No production code should connect `DownloadStore` to session storage.

- [ ] **Step 5: Run GREEN checks and commit**

```bash
cd apps/mobile
bunx vitest run app/library/downloadedLibrary.test.ts
bun run test:unit
cd ../..
git add apps/mobile/app/library/downloadedLibrary.ts apps/mobile/app/library/downloadedLibrary.test.ts
git commit -m "feat(mobile): derive downloaded progress state"
```

Expected: PASS.

---

### Task 5: Add the concrete Gallery / Downloaded page and app composition

**Files:**
- Modify: `apps/mobile/app/App.svelte`
- Modify: `apps/mobile/app/app.css`
- Create: `apps/mobile/app/library/Library.svelte`
- Create: `apps/mobile/app/library/Gallery.svelte`
- Create: `apps/mobile/app/library/Downloaded.svelte`

**Interfaces:**
- `Library.svelte` consumes:

```ts
export let puzzleApi: PuzzleApi;
export let downloadStore: DownloadStore;
export let sessionStorage: SessionStorageAdapter;
export let onLaunch: (launch: GameplayLaunch) => void;
```

- `App.svelte` owns only:

```ts
type MobileScreen =
	| { kind: 'library' }
	| { kind: 'gameplay'; launch: GameplayLaunch };
```

- [ ] **Step 1: Move concrete service construction to `App.svelte`**

Reuse the HPA-1 session path/adapter rather than recreating persistence:

```ts
const perseusRoot = path.join(knownFolders.documents().path, 'perseus');
const sessionsRoot = path.join(perseusRoot, 'sessions');
const downloadsRoot = path.join(perseusRoot, 'downloads');

Folder.fromPath(sessionsRoot);
Folder.fromPath(downloadsRoot);

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

Keep these values local to `App.svelte`; do not add Svelte context, a service container, or global store.

- [ ] **Step 2: Implement `Gallery.svelte` as presentation only**

Props are `puzzles`, `nextCursor`, `installedIds`, `downloadingPuzzleId`, `thumbnailUrl`, `onDownload`, and `onLoadMore`.

Use the existing lower-case Svelte Native element style:

```svelte
<scrollView>
	<stackLayout>
		{#each puzzles as puzzle (puzzle.id)}
			<gridLayout columns="96,*,auto" rows="auto,auto" class="library-row">
				<image
					rowSpan="2"
					width="88"
					height="88"
					stretch="aspectFill"
					src={thumbnailUrl(puzzle.id)}
				/>
				<label col="1" text={puzzle.name} class="library-title" />
				<label col="1" row="1" text={`${puzzle.pieceCount} pieces`} class="library-meta" />
				<button
					col="2"
					rowSpan="2"
					text={installedIds.has(puzzle.id)
						? 'DOWNLOADED'
						: downloadingPuzzleId === puzzle.id
							? 'DOWNLOADING…'
							: 'DOWNLOAD'}
					isEnabled={!installedIds.has(puzzle.id) && downloadingPuzzleId === null}
					on:tap={() => onDownload(puzzle.id)}
				/>
			</gridLayout>
		{/each}
		{#if nextCursor}
			<button text="LOAD MORE" on:tap={onLoadMore} />
		{/if}
	</stackLayout>
</scrollView>
```

Do not add search/category UI.

- [ ] **Step 3: Implement `Downloaded.svelte` as presentation only**

For each `DownloadedPuzzleRow`:

- show local thumbnail/name/piece count;
- `resumable` => **RESUME**, **DISCARD PROGRESS**, **REMOVE DOWNLOAD**;
- `none` => **START**, **REMOVE DOWNLOAD**;
- `invalid` => no Start/Resume; show **DISCARD PROGRESS** and **REMOVE DOWNLOAD**.

For each `CorruptDownload`, show the puzzle ID/reason and only **REMOVE & DOWNLOAD AGAIN** / **REMOVE DOWNLOAD**. Never construct a `GameplayLaunch` from a corrupt row.

- [ ] **Step 4: Implement `Library.svelte` orchestration with one active job**

Use only local component state:

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

On mount, call `refreshDownloads()` and `loadGallery(false)` as separate operations. A failed online Gallery request sets an online error but must not clear disk-derived Downloaded state.

`refreshDownloads()` calls `scanDownloads()`, splits valid/corrupt entries, and maps valid entries through `buildDownloadedRows()`. Compute `installedIds` from **all** scan entries, including corrupt packages, so Gallery cannot start a second normal download over an existing corrupt final directory.

The one download path is:

```ts
async function downloadPuzzle(puzzleId: string): Promise<void> {
	if (downloadingPuzzleId !== null) return;
	const token: DownloadCancellation = { cancelled: false };
	downloadingPuzzleId = puzzleId;
	cancellation = token;
	errorMessage = null;
	try {
		const puzzle = await puzzleApi.getPuzzle(puzzleId);
		await downloadStore.downloadPuzzle(puzzle, token);
		await refreshDownloads();
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : 'download_failed';
	} finally {
		downloadingPuzzleId = null;
		cancellation = null;
	}
}
```

`cancelDownload()` sets only `cancellation.cancelled = true`.

`discardProgress(id)` calls only `sessionStorage.clearSession(id)`, then refreshes.

`removeDownload(id)` calls only `downloadStore.removeDownload(id)`, then refreshes.

`removeAndDownloadAgain(id)` removes the corrupt package, refreshes, then calls the same `downloadPuzzle(id)` function. Do not add repair logic.

Do not call `scanDownloads()` from a manual/tab refresh while a download is active because startup scan removes stale staging. If a Refresh button exists, disable it when `downloadingPuzzleId !== null`.

- [ ] **Step 5: Render the two sections with concrete controls**

Use one `<page>` with top buttons **GALLERY** / **DOWNLOADED** and a body that selects `Gallery.svelte` or `Downloaded.svelte`. While a job is active, show one **CANCEL DOWNLOAD** button. Show `errorMessage` as a text-wrapped label without modal/error framework extraction.

- [ ] **Step 6: Add only the CSS these components consume**

Append a small set of classes in `app.css`, reusing the HPA-1 palette:

```css
.library-page {
	background-color: #111820;
	color: #f7fafc;
}
.library-row {
	padding: 10;
	margin: 4 8;
	background-color: #1f2b38;
}
.library-title {
	font-size: 18;
	color: #f7fafc;
}
.library-meta,
.library-error {
	color: #cbd5e0;
}
.library-error {
	padding: 8 12;
}
```

Do not create a component library or responsive system.

- [ ] **Step 7: Run checks and commit**

```bash
cd apps/mobile
bun run test:unit
cd ../..
bunx tsc --project apps/mobile/tsconfig.json --noEmit
bunx prettier --check apps/mobile/app apps/mobile/types apps/mobile/webpack.config.js apps/mobile/package.json
git add apps/mobile/app/App.svelte apps/mobile/app/app.css apps/mobile/app/library
git commit -m "feat(mobile): add gallery and downloaded library"
```

Expected: PASS.

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

Delete `PIECE_IDS` and `~/assets/hpa-1/...` from `PuzzleCanvas.svelte`. Replace `loadPieces()` with:

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

Leave `boardViewModel.ts`, fit sizing, hit testing, density conversion, and tap/drag placement unchanged. Its simple horizontal tray is HPA-1 proof UI; HPA-3 owns production landscape inventory behavior.

- [ ] **Step 2: Replace fixture session construction with `GameplayLaunch`**

Move session storage construction out of Gameplay (Task 5 now owns it in `App.svelte`). In Gameplay:

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

Use nullable runtime state so an invalid resume does not construct a fresh session silently:

```ts
type MobilePuzzleSession = ReturnType<typeof createPuzzleSession>;
let session: MobilePuzzleSession | null = null;
let sessionState: PuzzleSessionState | null = null;
let unsubscribe: (() => void) | null = null;
```

When `resumeUnavailable` is false, create the session with:

- `metadata: spec`;
- HPA-1 `createDefaultClock()`, `createRunIdFactory(resolveMobileCrypto())`;
- `restored` above;
- `initialTrayOrder: spec.pieces.map((piece) => piece.id)`;
- `createTrayOrder: () => spec.pieces.map((piece) => piece.id)`;
- the existing zero-rotation generator.

Dispatch `start` only after construction. All persistence uses `spec.puzzleId`.

When `resumeUnavailable` is true, render “Saved progress is no longer resumable” plus **BACK TO LIBRARY**. Do not call `loadSession()` a second time or create a fresh run.

- [ ] **Step 3: Preserve HPA-1 lifecycle persistence for the dynamic session**

Keep suspend/resume/exit listeners, but guard nullable `session`:

```ts
function persist(): void {
	if (!session) return;
	session.checkpointTime();
	const snapshot = serializeSession(session.getState());
	if (snapshot) storage.saveSession(spec.puzzleId, snapshot);
}

function leaveGameplay(): void {
	persist();
	onExit();
}
```

`onDestroy` persists, unsubscribes, and disposes only when those values exist.

- [ ] **Step 4: Pass resolved local piece paths to Canvas**

When `sessionState` exists:

```svelte
<PuzzleCanvas
	{sessionState}
	piecePaths={launch.install.piecePaths}
	onSelectPiece={selectPiece}
	onAttemptPlacement={attemptPlacement}
/>
```

Change the title from `HPA-1 Offline 2x2` to `launch.install.manifest.name` and use `${sessionState.placedPieces.length}/${sessionState.pieceCount}`. Add one **LIBRARY** button wired to `leaveGameplay()`; do not add HPA-3 toolbar/tray controls.

- [ ] **Step 5: Delete the fixture path completely**

Delete `fixture.ts` and all four HPA-1 PNGs, then run:

```bash
rg "HPA1_FIXTURE|assets/hpa-1|PIECE_IDS|HPA-1 Offline" apps/mobile
```

Expected: no matches. Do not retain a fallback asset bundle.

- [ ] **Step 6: Run checks and commit**

```bash
cd apps/mobile
bun run test:unit
cd ../..
bunx tsc --project apps/mobile/tsconfig.json --noEmit
bunx prettier --check apps/mobile/app apps/mobile/types apps/mobile/webpack.config.js apps/mobile/package.json
git add -A apps/mobile/app
git commit -m "feat(mobile): launch downloaded puzzles offline"
```

Expected: PASS.

---

### Task 7: Prove the HPA-2 native boundary and finish the one implementation PR

**Files:**
- No production file is expected.
- Update the implementation PR body with the exact smoke evidence/environment; do not create a second HPA-2 PR.

**Interfaces:**
- Consumes the complete Tasks 1-6 implementation.
- Produces acceptance evidence for real API transfer, native directory finalization, disk reconstruction, offline gameplay/resume, progress independence, and corrupt-package recovery.

- [ ] **Step 1: Run repository-level non-native gates**

```bash
bun run --cwd apps/mobile test:unit
bunx tsc --project apps/mobile/tsconfig.json --noEmit
bunx prettier --check apps/mobile/app apps/mobile/types apps/mobile/webpack.config.js apps/mobile/package.json
bun run check
bun run lint
```

Expected: all commands PASS. If an unrelated aggregate host test is blocked by a pre-existing environment issue, record the command/error in the PR; do not weaken the focused mobile tests.

- [ ] **Step 2: Start a reachable API and run iOS**

Local simulator setup:

```bash
bun run dev --filter=@perseus/api
```

In another shell:

```bash
cd apps/mobile
PERSEUS_MOBILE_API_BASE=http://localhost:4690 ns run ios --no-hmr
```

For a physical iPad, use a LAN/HTTPS API base reachable by the device instead of localhost. Record NativeScript CLI, `@nativescript/core`, `@nativescript/canvas`, Xcode, simulator/device, and iOS versions in the implementation PR body.

- [ ] **Step 3: Prove finalization and relaunch discovery**

Download one ready Gallery puzzle. Inspect the app Documents container and verify:

```text
perseus/downloads/<puzzle-id>/manifest.json
perseus/downloads/<puzzle-id>/thumbnail.<image-extension>
perseus/downloads/<puzzle-id>/pieces/0.<image-extension>
```

Verify `perseus/downloads/.staging/<puzzle-id>` does not remain after success. Terminate/relaunch the app without downloading again and confirm the same Downloaded row is reconstructed from disk.

- [ ] **Step 4: Prove start/resume while networking is unavailable**

Stop the local API or otherwise disable networking **after** finalization. From Downloaded:

1. start the installed puzzle;
2. place at least one piece;
3. leave/terminate so the existing session checkpoint runs;
4. relaunch while the API remains unavailable;
5. confirm Downloaded still loads and offers **Resume**;
6. resume and confirm the placement/counters are retained.

A Gallery request failure must not clear or block the Downloaded section.

- [ ] **Step 5: Prove Remove Download preserves the session**

With the session still resumable:

1. tap **Remove Download**;
2. verify `perseus/downloads/<puzzle-id>` is gone;
3. verify `perseus/sessions/<puzzle-id>.json` still exists;
4. restore networking;
5. download the same stable puzzle ID again;
6. confirm **Resume** returns after validation;
7. resume and confirm the retained placement remains.

- [ ] **Step 6: Prove corrupt-package blocking and clean re-download**

Delete one finalized piece file from the app container, then refresh/relaunch. Verify:

- the package is shown as corrupt and cannot Start/Resume;
- **Remove & Download Again** is available;
- activating it removes the corrupt final package and uses the normal clean download path;
- the package returns to installed state only after finalization.

- [ ] **Step 7: Run the final scope fence**

```bash
git diff --name-only main...HEAD
rg "HPA1_FIXTURE|assets/hpa-1|downloads\.json" apps/mobile
```

Expected:

- no HPA-1 fixture or download index matches;
- no `apps/api`, `apps/workflows`, database migration, infrastructure, or `packages/game-core` production file in the diff;
- only the intended mobile API/download/library/gameplay/config/lockfile changes plus the deletion of fixture assets.

If the existing public API proves insufficient during the smoke test, do not add a mobile-only backend workaround in this PR; return to the HPA-2 design.

- [ ] **Step 8: Update the implementation PR body only**

Record the commands/results and native smoke evidence in the same HPA-2 implementation PR. No verification-only repository file or second PR is required.

## Self-Review Results

- **Spec coverage:** Tasks 1-7 cover existing public API use, explicit staging/finalization, bounded concurrency, failed/cancelled cleanup, direct disk discovery, offline start/resume, independent asset/progress removal, matching re-download validation, corrupt-package blocking/re-download, service tests, and native iPad proof.
- **Scope:** No API, Workflow, database, game-core, index, ZIP, auth, sync, portrait, or production-gameplay expansion is planned.
- **Atomicity:** Asset verification precedes manifest write; manifest write precedes the staging-to-final move; failed/cancelled work waits for in-flight requests to settle before cleanup.
- **Type consistency:** `PublicReadyPuzzle` feeds `createDownloadManifest`; `DownloadManifestV1` feeds `InstalledDownload`; `InstalledDownload` feeds `DownloadedPuzzleRow`/`GameplayLaunch`; the same manifest projects `SessionPuzzleSpec` for both validation and gameplay.
- **Progress ownership:** `DownloadStore` has no session dependency. Only the explicit Discard action calls `SessionStorageAdapter.clearSession()`.
- **Fixture removal:** Dynamic `piecePaths` replaces the only HPA-1 bundled-asset dependency, so no compatibility fixture path remains.
- **No placeholders:** File paths, exported signatures, critical algorithms, failure ordering, test assertions, commands, and the API-insufficiency stop condition are specified explicitly.
