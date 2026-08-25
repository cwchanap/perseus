# HPA-2 Explicit Downloads and Offline Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the HPA-1 bundled fixture with an explicit-download mobile Gallery and filesystem-derived Downloaded library that can start and resume finalized puzzle packages completely offline.

**Architecture:** Keep the feature mobile-local except for one API-detail wire type in `@perseus/types`. Reuse the existing public puzzle endpoints, shared metadata validator, HPA-1 file/session seams, and `PuzzleSession`. A versioned local manifest describes finalized assets, `DownloadStore` owns staging/finalization, `scanDownloads()` is read-only, and saved-progress state is derived with non-destructive `peekSession()`.

**Tech Stack:** NativeScript 9, Svelte Native 4, TypeScript 5.9, `@nativescript/core` HTTP/FileSystem, `@perseus/types`, `@perseus/game-core`, Vitest 4, Bun 1.3.14.

**Spec:** `docs/superpowers/specs/2026-08-25-hpa-2-offline-download-library-design.md`

## Global Constraints

- Deliver HPA-2 as **one implementation PR**. Task commits are review checkpoints inside that PR, not separate PRs.
- Use only the existing public `/api/puzzles` and asset endpoints. Do not change `apps/api`, `apps/workflows`, database schemas, or Cloudflare infrastructure.
- `packages/types` may gain only the small public ready-detail wire type needed to stop duplicating `hasReference`; do not expand shared gameplay behavior there.
- Keep `@perseus/game-core` unchanged. If an existing exported contract proves unusable, stop and revise the design before expanding shared-core scope.
- Add no third-party runtime dependency. `@perseus/types` is an existing workspace package and is the only expected mobile dependency addition.
- One puzzle download at a time; exactly **5** concurrent asset requests inside that download.
- `manifest.json` is written last in staging; only a successful same-volume directory move makes the package installed.
- `scanDownloads()` is read-only. Stale staging cleanup is a separate startup-only operation.
- Unknown manifest schemas are corrupt; do not add compatibility migration code.
- Download removal never deletes progress. Only explicit Discard calls `SessionStorageAdapter.clearSession()`.
- HPA-2 mobile library/gameplay code must not use `SessionStorageAdapter.loadSession()` because it deletes invalid saves. Use `peekSession()`.
- Valid loaded but non-resumable sessions are `present`, not `none`; do not silently overwrite them with a fresh run.
- Downloaded server puzzles keep `SessionPuzzleSpec.source = 'api'`.
- Keep the HPA-1 board interaction/layout during this ticket; HPA-3 owns production landscape gameplay parity.
- Delete the HPA-1 fixture code/assets once dynamic installed-package assets work; retain no compatibility fallback.
- Remote/TestFlight API bases use HTTPS. iOS local development uses the narrow local-network plist declarations; do not set `NSAllowsArbitraryLoads`.
- Native JSON transport is gated in Task 1. Binary `toFile` and same-volume directory movement are gated in Task 3 before Gallery/Downloaded integration.

---

### Task 1: Reuse the shared puzzle validator and prove NativeScript JSON transport

**Files:**
- Modify: `packages/types/src/core.ts`
- Modify: `apps/mobile/package.json`
- Modify: `bun.lock`
- Modify: `apps/mobile/webpack.config.js`
- Modify: `apps/mobile/App_Resources/iOS/Info.plist`
- Create: `apps/mobile/types/globals.d.ts`
- Create: `apps/mobile/app/api/puzzleApi.ts`
- Create: `apps/mobile/app/api/puzzleApi.test.ts`
- Create: `apps/mobile/app/api/nativePuzzleHttp.ts`
- Temporary only, reverted before commit: `apps/mobile/app/App.svelte`

**Interfaces:**

`@perseus/types` produces:

```ts
export interface ReadyPuzzleDetail extends ReadyPuzzle {
	hasReference: boolean;
}
```

Mobile produces:

```ts
export type PuzzleJsonRequest = (url: string) => Promise<unknown>;

export interface PuzzleApi {
	listPuzzles(cursor?: string): Promise<PuzzleListResponse>;
	getPuzzle(puzzleId: string): Promise<ReadyPuzzleDetail>;
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

- [ ] **Step 1: Add the shared ready-detail wire type**

In `packages/types/src/core.ts`, immediately after `ReadyPuzzle`:

```ts
export interface ReadyPuzzleDetail extends ReadyPuzzle {
	hasReference: boolean;
}
```

Do not modify the web-local flat `Puzzle` presentation type in this ticket.

- [ ] **Step 2: Add the mobile shared-type dependency and API-base declaration**

Add to `apps/mobile/package.json`:

```json
"@perseus/types": "workspace:*"
```

Run from repo root:

```bash
bun install
```

Create `apps/mobile/types/globals.d.ts`:

```ts
declare const __PERSEUS_API_BASE__: string;
```

In `apps/mobile/webpack.config.js`, keep the existing aliases and add:

```js
const apiBase = process.env.PERSEUS_MOBILE_API_BASE ?? 'http://localhost:4690';

webpack.chainWebpack((config) => {
	config.plugin('DefinePlugin').tap((args) => {
		args[0].__PERSEUS_API_BASE__ = JSON.stringify(apiBase);
		return args;
	});
});
```

Do not add dotenv/runtime settings plumbing.

- [ ] **Step 3: Declare narrow iOS local-network intent**

Add to the top-level `<dict>` in `apps/mobile/App_Resources/iOS/Info.plist`:

```xml
<key>NSAppTransportSecurity</key>
<dict>
	<key>NSAllowsLocalNetworking</key>
	<true/>
</dict>
<key>NSLocalNetworkUsageDescription</key>
<string>Connect to a local Perseus development server.</string>
```

Do not add `NSAllowsArbitraryLoads` or remote-domain insecure exceptions. Production/TestFlight configuration must point `PERSEUS_MOBILE_API_BASE` at HTTPS.

- [ ] **Step 4: Write RED API tests using a fully valid shared puzzle fixture**

Create `apps/mobile/app/api/puzzleApi.test.ts`. Use complete `EdgeConfig` objects and string `imagePath` fields so the fixture genuinely passes `validatePuzzleMetadata()`.

Core fixture:

```ts
import type { ReadyPuzzleDetail } from '@perseus/types';

export function readyPuzzle(id = 'p1'): ReadyPuzzleDetail {
	return {
		id,
		name: 'Test Puzzle',
		pieceCount: 4,
		gridCols: 2,
		gridRows: 2,
		imageWidth: 800,
		imageHeight: 800,
		createdAt: 1,
		version: 1,
		status: 'ready',
		hasReference: true,
		pieces: [
			{
				id: 0,
				puzzleId: id,
				correctX: 0,
				correctY: 0,
				edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' },
				imagePath: 'pieces/0.png'
			},
			{
				id: 1,
				puzzleId: id,
				correctX: 1,
				correctY: 0,
				edges: { top: 'flat', right: 'flat', bottom: 'tab', left: 'blank' },
				imagePath: 'pieces/1.png'
			},
			{
				id: 2,
				puzzleId: id,
				correctX: 0,
				correctY: 1,
				edges: { top: 'tab', right: 'blank', bottom: 'flat', left: 'flat' },
				imagePath: 'pieces/2.png'
			},
			{
				id: 3,
				puzzleId: id,
				correctX: 1,
				correctY: 1,
				edges: { top: 'blank', right: 'flat', bottom: 'flat', left: 'tab' },
				imagePath: 'pieces/3.png'
			}
		]
	};
}
```

Pin these behaviors:

```ts
it('propagates the existing cursor contract', async () => {
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

it('rejects malformed ready metadata through validatePuzzleMetadata', async () => {
	const malformed = readyPuzzle();
	(malformed.pieces[0] as unknown as Record<string, unknown>).imagePath = 42;
	const api = createPuzzleApi({
		baseUrl: 'https://api.example.test',
		requestJson: async () => malformed
	});
	await expect(api.getPuzzle('p1')).rejects.toThrow('invalid_puzzle_response');
});

it('requires the public detail hasReference field', async () => {
	const { hasReference: _, ...withoutReference } = readyPuzzle();
	void _;
	const api = createPuzzleApi({
		baseUrl: 'https://api.example.test',
		requestJson: async () => withoutReference
	});
	await expect(api.getPuzzle('p1')).rejects.toThrow('invalid_puzzle_response');
});

it('rejects a valid non-ready puzzle before download orchestration', async () => {
	const ready = readyPuzzle();
	const processing = {
		...ready,
		status: 'processing' as const,
		pieces: [],
		progress: { totalPieces: 4, generatedPieces: 0, updatedAt: 1 }
	};
	delete (processing as Record<string, unknown>).hasReference;
	const api = createPuzzleApi({
		baseUrl: 'https://api.example.test',
		requestJson: async () => processing
	});
	await expect(api.getPuzzle('p1')).rejects.toThrow('puzzle_not_ready');
});
```

Also test requested-ID mismatch.

- [ ] **Step 5: Verify RED**

```bash
cd apps/mobile
bunx vitest run app/api/puzzleApi.test.ts
```

Expected: FAIL because `puzzleApi.ts` does not exist.

- [ ] **Step 6: Implement `PuzzleApi` with the shared validator**

Core `getPuzzle()` behavior:

```ts
import {
	validatePuzzleMetadata,
	type PuzzleListResponse,
	type ReadyPuzzleDetail
} from '@perseus/types';

async function getPuzzle(puzzleId: string): Promise<ReadyPuzzleDetail> {
	const value = await options.requestJson(
		`${baseUrl}/api/puzzles/${encodeURIComponent(puzzleId)}`
	);
	if (!validatePuzzleMetadata(value)) {
		throw new Error('invalid_puzzle_response');
	}
	if (value.status !== 'ready') {
		throw new Error('puzzle_not_ready');
	}
	const detail = value as unknown as Record<string, unknown>;
	if (value.id !== puzzleId || typeof detail.hasReference !== 'boolean') {
		throw new Error('invalid_puzzle_response');
	}
	return value as ReadyPuzzleDetail;
}
```

`listPuzzles()` validates only the list envelope fields HPA-2 uses (`puzzles`, `total`, `offset`, `limit`, optional `nextCursor`). URL helpers follow the existing web endpoint pattern but are mobile-local.

- [ ] **Step 7: Implement NativeScript JSON transport**

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

No auth, retry, or download behavior belongs here.

- [ ] **Step 8: Run unit/type gates**

```bash
bun run --cwd packages/types test:unit
cd apps/mobile
bunx vitest run app/api/puzzleApi.test.ts
bun run test:unit
cd ../..
bunx tsc --project apps/mobile/tsconfig.json --noEmit
```

Expected: PASS.

- [ ] **Step 9: Run Native Gate A before proceeding**

Start a reachable API with at least one ready puzzle:

```bash
bun run dev --filter=@perseus/api
```

Temporarily add this to `apps/mobile/app/App.svelte`:

```ts
import { onMount } from 'svelte';
import { nativePuzzleJsonRequest } from './api/nativePuzzleHttp';

onMount(async () => {
	const result = await nativePuzzleJsonRequest(`${__PERSEUS_API_BASE__}/api/puzzles`);
	console.log('HPA2_JSON_PROBE', JSON.stringify(result));
});
```

Run on the iPad simulator:

```bash
cd apps/mobile
PERSEUS_MOBILE_API_BASE=http://localhost:4690 ns run ios --no-hmr
```

Pass condition: the console contains `HPA2_JSON_PROBE` with the real list response and no ATS/local-network transport error.

Revert the temporary `App.svelte` probe before committing:

```bash
git checkout -- apps/mobile/app/App.svelte
rg "HPA2_JSON_PROBE" apps/mobile/app/App.svelte
```

Expected: `rg` returns no match.

If this gate fails after the plist declaration, stop HPA-2 and resolve the real iOS transport/configuration issue before Task 2.

- [ ] **Step 10: Commit**

```bash
git add packages/types/src/core.ts apps/mobile/package.json bun.lock \
	apps/mobile/webpack.config.js apps/mobile/App_Resources/iOS/Info.plist \
	apps/mobile/types/globals.d.ts apps/mobile/app/api
git commit -m "feat(mobile): add validated public puzzle API client"
```

---

### Task 2: Define and validate the finalized download manifest

**Files:**
- Create: `apps/mobile/app/library/downloadManifest.ts`
- Create: `apps/mobile/app/library/downloadManifest.test.ts`

**Interfaces:**

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
	puzzle: ReadyPuzzleDetail,
	files: DownloadedAssetFiles,
	downloadedAt: number
): DownloadManifestV1;

export function parseDownloadManifest(value: unknown): DownloadManifestV1;
export function sessionSpecFromManifest(manifest: DownloadManifestV1): SessionPuzzleSpec;
```

- [ ] **Step 1: Write manifest RED tests**

Use the valid Task 1 ready fixture and assert the manifest drops server-only fields and projects an API-origin session spec:

```ts
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
```

Add rejection tests for:

- `schemaVersion: 2`;
- non-positive image dimensions;
- `pieceCount !== gridCols * gridRows`;
- duplicate/missing piece IDs;
- duplicate or out-of-bounds canonical cells;
- missing/extra piece-file mapping;
- `/absolute.png`, `../piece.png`, `pieces\\0.png`, and `pieces/../0.png`.

- [ ] **Step 2: Verify RED**

```bash
cd apps/mobile
bunx vitest run app/library/downloadManifest.test.ts
```

Expected: FAIL because `downloadManifest.ts` does not exist.

- [ ] **Step 3: Implement the disk-only codec**

Use a strict local path rule:

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

Require IDs exactly `0..pieceCount - 1`, one unique in-bounds canonical cell per piece, exact piece-file keys, optional valid category/aspect ratio, and safe local filenames. `createDownloadManifest()` constructs only local fields and immediately calls `parseDownloadManifest()`.

Do not persist server `status`, `version`, `idempotencyKey`, `edges`, or remote `imagePath` values.

- [ ] **Step 4: Implement `SessionPuzzleSpec` projection**

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

---

### Task 3: Add atomic downloads, read-only discovery, startup cleanup, and prove native file transfer/finalization

**Files:**
- Create: `apps/mobile/app/library/downloadStore.ts`
- Create: `apps/mobile/app/library/downloadStore.test.ts`
- Create: `apps/mobile/app/library/nativeDownloadFiles.ts`
- Temporary only, reverted before commit: `apps/mobile/app/App.svelte`

**Interfaces:**

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
	cleanupStaleStaging(): Promise<void>;
	downloadPuzzle(
		puzzle: ReadyPuzzleDetail,
		cancellation?: DownloadCancellation
	): Promise<InstalledDownload>;
	scanDownloads(): Promise<DownloadScanEntry[]>;
	removeDownload(puzzleId: string): Promise<void>;
}
```

- [ ] **Step 1: Write RED tests for bounded download ordering and failure cleanup**

Use an in-memory `DownloadFileOps` and controllable `AssetDownloader`. Pin:

- maximum active asset calls is exactly 5 for a 12+ piece fixture;
- all asset writes finish before manifest write;
- manifest write precedes final move;
- failed/cancelled/zero-byte/move-failed downloads have no finalized package;
- after one request rejects while another request remains in-flight, `.staging/p1` is not removed until the in-flight request settles.

Ordering assertion:

```ts
expect(lastAssetOperation).toBeLessThan(manifestWriteOperation);
expect(manifestWriteOperation).toBeLessThan(finalMoveOperation);
```

- [ ] **Step 2: Write RED tests proving scan is read-only and cleanup is separate**

Seed both `.staging/in-progress` and finalized package directories.

Assert:

```ts
await store.scanDownloads();
expect(fileOps.removedDirectories).not.toContain('/downloads/.staging/in-progress');

await store.cleanupStaleStaging();
expect(fileOps.removedDirectories).toContain('/downloads/.staging/in-progress');
```

Also test:

- missing downloads root => `scanDownloads()` returns `[]` without creating it;
- valid finalized manifest => installed row;
- missing/malformed/unsupported manifest => corrupt row;
- missing/zero-byte referenced asset => corrupt row;
- folder-name/manifest-ID mismatch => corrupt row;
- `removeDownload('p1')` touches only finalized `downloads/p1`.

- [ ] **Step 3: Verify RED**

```bash
cd apps/mobile
bunx vitest run app/library/downloadStore.test.ts
```

Expected: FAIL because `downloadStore.ts` does not exist.

- [ ] **Step 4: Implement the five-worker scheduler so in-flight writes settle before failure escapes**

Use this shape:

```ts
const ASSET_CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(
	items: readonly T[],
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
		Array.from({ length: Math.min(ASSET_CONCURRENCY, items.length) }, () => runWorker())
	);
	if (isCancelled()) firstError ??= new Error('download_cancelled');
	if (firstError !== null) throw firstError;
	return results;
}
```

Already-started work finishes before the outer `finally` can clean staging; no new work is scheduled after the first error/cancel observation.

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

1. validate `puzzle.id` as one safe path segment;
2. reject `download_already_installed` if `downloads/<id>` exists;
3. remove stale staging for **that same ID only** and create `.staging/<id>/pieces`;
4. build thumbnail + optional reference + all piece asset work;
5. run through the five-worker scheduler;
6. map Content-Type extensions into relative names;
7. verify every expected file is non-empty;
8. create/validate manifest;
9. write `manifest.json` last;
10. move `.staging/<id>` to finalized `downloads/<id>`;
11. return resolved installed paths.

In `finally`, remove only `.staging/<id>` when finalization did not succeed.

- [ ] **Step 6: Implement separate startup cleanup and read-only scan**

`cleanupStaleStaging()`:

- return if `.staging` does not exist;
- list only direct children of `.staging`;
- remove those abandoned child directories;
- never inspect finalized packages.

`scanDownloads()`:

- return `[]` if `downloads/` does not exist;
- never call `ensureDir`, `removeDir`, or `cleanupStaleStaging`;
- enumerate finalized direct child directories and skip `.staging`;
- parse each manifest and verify required files are non-empty;
- catch corruption per package so one bad package does not abort the list.

`removeDownload()` removes only the finalized package and has no session dependency.

- [ ] **Step 7: Implement NativeScript binary/file operations**

`downloadNativeAsset()` uses the real response Content-Type:

```ts
const response = await Http.request({ url, method: 'GET' });
if (response.statusCode < 200 || response.statusCode >= 300) {
	throw new Error(`download_http_${response.statusCode}`);
}
if (!response.content) throw new Error('download_empty_response');
const extension = imageExtension(readHeader(response.headers, 'content-type'));
const file = response.content.toFile(destinationBasePath + extension);
if (!file || file.size <= 0) throw new Error('download_empty_file');
return { extension, bytes: file.size };
```

Content-Type mapping is only:

```ts
'image/png'  -> '.png'
'image/jpeg' -> '.jpg'
'image/webp' -> '.webp'
```

For iOS `moveDir()`, preserve one same-volume native move. Try the path bridge first and the URL bridge second:

```ts
function moveIOSDirectory(fromPath: string, toPath: string): void {
	const manager = NSFileManager.defaultManager;
	try {
		const moved = manager.moveItemAtPathToPathError(fromPath, toPath, null);
		if (moved && Folder.exists(toPath)) return;
	} catch {
		// Probe the equivalent URL bridge below.
	}

	const moved = manager.moveItemAtURLToURLError(
		NSURL.fileURLWithPath(fromPath),
		NSURL.fileURLWithPath(toPath),
		null
	);
	if (!moved || !Folder.exists(toPath)) {
		throw new Error('download_directory_move_failed');
	}
}
```

Android keeps the direct same-volume `java.io.File.renameTo()` path. Do not add copy/delete finalization.

- [ ] **Step 8: Run unit/type gates**

```bash
cd apps/mobile
bunx vitest run app/library/downloadStore.test.ts
bun run test:unit
cd ../..
bunx tsc --project apps/mobile/tsconfig.json --noEmit
```

Expected: PASS.

- [ ] **Step 9: Run Native Gate B before Task 4/UI**

Use a reachable API containing a ready puzzle. Temporarily add an `onMount` probe to `App.svelte` that:

```ts
const api = createPuzzleApi({
	baseUrl: __PERSEUS_API_BASE__,
	requestJson: nativePuzzleJsonRequest
});
const list = await api.listPuzzles();
const first = list.puzzles.find((puzzle) => puzzle.status === 'ready');
if (!first) throw new Error('hpa2_probe_needs_ready_puzzle');
const puzzle = await api.getPuzzle(first.id);

const root = path.join(knownFolders.documents().path, 'perseus', 'hpa2-native-probe');
const staging = path.join(root, 'staging');
const finalized = path.join(root, 'finalized');
const fileOps = createNativeDownloadFileOps();
await fileOps.removeDir(root);
await fileOps.ensureDir(staging);
await fileOps.writeText(path.join(staging, 'sentinel.txt'), 'ok');

const asset = await downloadNativeAsset(api.thumbnailUrl(puzzle.id), path.join(staging, 'thumbnail'));
if (asset.bytes <= 0) throw new Error('hpa2_probe_empty_thumbnail');

await fileOps.moveDir(staging, finalized);
if ((await fileOps.readText(path.join(finalized, 'sentinel.txt'))) !== 'ok') {
	throw new Error('hpa2_probe_move_failed');
}
console.log('HPA2_FILE_PROBE', puzzle.id, asset.extension, asset.bytes);
await fileOps.removeDir(root);
```

Run on the same iPad simulator/device used for HPA-1:

```bash
cd apps/mobile
PERSEUS_MOBILE_API_BASE=http://localhost:4690 ns run ios --no-hmr
```

Pass conditions:

- `HPA2_FILE_PROBE` logs a non-zero byte count;
- the staging directory moved successfully;
- cleanup succeeds;
- no temporary probe remains in the commit.

Revert temporary `App.svelte` edits and verify:

```bash
git checkout -- apps/mobile/app/App.svelte
rg "HPA2_FILE_PROBE|hpa2-native-probe" apps/mobile/app/App.svelte
```

Expected: no matches.

If both iOS move bridge forms fail, stop HPA-2 here and revise finalization. Do not continue into UI with an unproven move or silently add copy/delete semantics.

- [ ] **Step 10: Commit**

```bash
git add apps/mobile/app/library/downloadStore.ts \
	apps/mobile/app/library/downloadStore.test.ts \
	apps/mobile/app/library/nativeDownloadFiles.ts
git commit -m "feat(mobile): add atomic puzzle downloads"
```

---

### Task 4: Derive all four saved-progress states without destructive reads

**Files:**
- Create: `apps/mobile/app/library/downloadedLibrary.ts`
- Create: `apps/mobile/app/library/downloadedLibrary.test.ts`

**Interfaces:**

```ts
export type ProgressState =
	| { kind: 'none' }
	| { kind: 'resumable' }
	| { kind: 'present' }
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

- [ ] **Step 1: Write RED integration tests using the real game-core codec**

Use `createSessionStorageAdapter()` over an in-memory `SessionKeyValueStore`.

Cover:

1. no key => `{ kind: 'none' }`;
2. active session with real user activity => `{ kind: 'resumable' }`;
3. valid completed session => `{ kind: 'present' }`;
4. valid loaded session without resumable activity => `{ kind: 'present' }`;
5. same puzzle ID with changed canonical coordinates => `{ kind: 'invalid', reason: 'cross_field_violation' }`.

Build the completed case with a real `PuzzleSession`: start, place every piece correctly, serialize, and save through the real adapter. This specifically fences the old bug where `isResumable() === false` collapsed a completed save into `none`.

- [ ] **Step 2: Verify RED**

```bash
cd apps/mobile
bunx vitest run app/library/downloadedLibrary.test.ts
```

Expected: FAIL because `downloadedLibrary.ts` does not exist.

- [ ] **Step 3: Implement four-arm projection with `peekSession()` only**

```ts
export function buildDownloadedRows(
	installed: readonly InstalledDownload[],
	storage: SessionStorageAdapter
): DownloadedPuzzleRow[] {
	return installed.map((install) => {
		const context = validationContextFrom(sessionSpecFromManifest(install.manifest));
		const result = storage.peekSession(install.manifest.puzzleId, context);

		if (result.status === 'missing') {
			return { install, progress: { kind: 'none' } };
		}
		if (result.status === 'invalid') {
			return { install, progress: { kind: 'invalid', reason: result.reason } };
		}
		if (storage.isResumable(result.snapshot)) {
			return { install, progress: { kind: 'resumable' } };
		}
		return { install, progress: { kind: 'present' } };
	});
}
```

Do not call `loadSession()`; invalid/present files remain owned by explicit Discard.

- [ ] **Step 4: Prove download/progress independence and matching re-download**

Extend the test:

1. save a resumable session;
2. call `downloadStore.removeDownload('p1')` on the Task 3 fake;
3. assert the session key remains;
4. seed a newly finalized matching package with the same ID;
5. assert `buildDownloadedRows()` returns `resumable` again.

No production code connects `DownloadStore` to session storage.

- [ ] **Step 5: Run GREEN checks and commit**

```bash
cd apps/mobile
bunx vitest run app/library/downloadedLibrary.test.ts
bun run test:unit
cd ../..
git add apps/mobile/app/library/downloadedLibrary.ts apps/mobile/app/library/downloadedLibrary.test.ts
git commit -m "feat(mobile): derive downloaded progress state"
```

---

### Task 5: Add concrete Gallery / Downloaded UI and startup-only staging cleanup

**Files:**
- Modify: `apps/mobile/app/App.svelte`
- Modify: `apps/mobile/app/app.css`
- Create: `apps/mobile/app/library/Library.svelte`
- Create: `apps/mobile/app/library/Gallery.svelte`
- Create: `apps/mobile/app/library/Downloaded.svelte`

**Interfaces:**

`App.svelte` owns only:

```ts
type MobileScreen =
	| { kind: 'library' }
	| { kind: 'gameplay'; launch: GameplayLaunch };
```

`Library.svelte` receives:

```ts
export let puzzleApi: PuzzleApi;
export let downloadStore: DownloadStore;
export let sessionStorage: SessionStorageAdapter;
export let onLaunch: (launch: GameplayLaunch) => void;
```

- [ ] **Step 1: Move concrete service composition into `App.svelte`**

Reuse HPA-1 persistence:

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

Keep these concrete values local; no Svelte context/service container/global store.

- [ ] **Step 2: Implement startup exactly once: cleanup, then read-only scan**

In `Library.svelte` mount logic:

```ts
onMount(() => {
	void initialize();
});

async function initialize(): Promise<void> {
	await downloadStore.cleanupStaleStaging();
	await Promise.all([refreshDownloads(), loadGallery(false)]);
}
```

`cleanupStaleStaging()` is not called from `refreshDownloads()`, tab changes, manual refresh, download completion, or Remove actions.

- [ ] **Step 3: Implement `Gallery.svelte` as presentation only**

Render name, piece count, remote thumbnail, and one Download state. Keep the existing cursor/load-more contract only.

Installed IDs are computed from **all finalized scan entries**, including corrupt packages, so Gallery cannot start a normal download over an existing corrupt directory.

One active download disables other Download buttons. Cancel only flips the current `DownloadCancellation.cancelled` flag.

- [ ] **Step 4: Implement all Downloaded progress actions explicitly**

For valid installed rows:

- `none` => **START**, **REMOVE DOWNLOAD**;
- `resumable` => **RESUME**, **DISCARD PROGRESS**, **REMOVE DOWNLOAD**;
- `present` => **DISCARD PROGRESS**, **REMOVE DOWNLOAD**; no Start/Resume until discard changes the state to `none`;
- `invalid` => **DISCARD PROGRESS**, **REMOVE DOWNLOAD**; no Start/Resume.

For corrupt rows:

- **REMOVE & DOWNLOAD AGAIN**;
- **REMOVE DOWNLOAD**;
- never construct a gameplay launch.

This makes explicit Discard the only way a present/invalid save is removed before a fresh Start.

- [ ] **Step 5: Implement library orchestration with read-only refreshes**

Local state only:

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

`refreshDownloads()` calls only `scanDownloads()` and `buildDownloadedRows()`.

Because scan is read-only, a manual/tab refresh is safe even while an asset request is active; do not rely on UI comments or disabled refresh controls to protect staging.

Download path:

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

`discardProgress(id)` calls only `sessionStorage.clearSession(id)`, then read-only refresh.

`removeDownload(id)` calls only `downloadStore.removeDownload(id)`, then read-only refresh.

`removeAndDownloadAgain(id)` removes the corrupt finalized package, refreshes, then runs the normal `downloadPuzzle(id)` path.

A failed online Gallery request reports an online error but must not clear disk-derived Downloaded state.

- [ ] **Step 6: Render the two sections and screen handoff**

Keep the UI concrete: Gallery/Downloaded toggle buttons plus the two presentation components. Do not add a router or generic tab framework.

`onLaunch` only receives:

```ts
{ install, mode: 'start' }
```

from a `none` row, or:

```ts
{ install, mode: 'resume' }
```

from a `resumable` row.

- [ ] **Step 7: Run checks and commit**

```bash
cd apps/mobile
bun run test:unit
cd ../..
bunx tsc --project apps/mobile/tsconfig.json --noEmit
bunx prettier --check apps/mobile/app apps/mobile/types apps/mobile/webpack.config.js apps/mobile/package.json
git add apps/mobile/app/App.svelte apps/mobile/app/app.css apps/mobile/app/library
git commit -m "feat(mobile): add explicit download library"
```

---

### Task 6: Replace the HPA-1 fixture with downloaded assets and non-destructive resume

**Files:**
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Delete: `apps/mobile/app/gameplay/fixture.ts`
- Delete: `apps/mobile/app/assets/hpa-1/piece-0.png`
- Delete: `apps/mobile/app/assets/hpa-1/piece-1.png`
- Delete: `apps/mobile/app/assets/hpa-1/piece-2.png`
- Delete: `apps/mobile/app/assets/hpa-1/piece-3.png`

**Interfaces:**

`Gameplay.svelte` receives:

```ts
export let launch: GameplayLaunch;
export let storage: SessionStorageAdapter;
export let onExit: () => void;
```

`PuzzleCanvas.svelte` gains:

```ts
export let piecePaths: Record<number, string>;
```

- [ ] **Step 1: Make Canvas image loading dynamic**

Delete the fixed `PIECE_IDS` and `~/assets/hpa-1/...` path. Load every installed path:

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

Leave `boardViewModel.ts`, fit sizing, hit testing, density conversion, and HPA-1 tap/drag behavior unchanged.

- [ ] **Step 2: Derive one validation context and use `peekSession()` for both launch modes**

```ts
const spec = sessionSpecFromManifest(launch.install.manifest);
const context = validationContextFrom(spec);
const persisted = storage.peekSession(spec.puzzleId, context);
```

For resume:

```ts
const restored =
	launch.mode === 'resume' &&
	persisted.status === 'loaded' &&
	storage.isResumable(persisted.snapshot)
		? persisted.snapshot
		: undefined;

const launchUnavailable = launch.mode === 'resume' && restored === undefined;
```

For start, require the disk state is still missing at launch time:

```ts
const startBlockedBySavedState = launch.mode === 'start' && persisted.status !== 'missing';
```

If either `launchUnavailable` or `startBlockedBySavedState` is true, render a concise saved-progress-unavailable/present message plus **BACK TO LIBRARY**. Do not create a fresh session and do not delete/overwrite the file.

Never call `storage.loadSession()` in HPA-2 mobile code.

- [ ] **Step 3: Construct the dynamic session only for an allowed launch**

Use:

- `metadata: spec`;
- HPA-1 `createDefaultClock()` and `createRunIdFactory(resolveMobileCrypto())`;
- `restored` only for Resume;
- `initialTrayOrder: spec.pieces.map((piece) => piece.id)`;
- `createTrayOrder: () => spec.pieces.map((piece) => piece.id)`;
- the existing zero-rotation generator.

Dispatch `start` only after construction. All persistence uses `spec.puzzleId`.

- [ ] **Step 4: Preserve HPA-1 lifecycle persistence with nullable runtime state**

Keep suspend/resume/exit listeners and the same checkpoint behavior, guarding nullable `session`:

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

Do not introduce another session controller/store.

- [ ] **Step 5: Pass finalized local piece paths to Canvas**

```svelte
<PuzzleCanvas
	{sessionState}
	piecePaths={launch.install.piecePaths}
	onSelectPiece={selectPiece}
	onAttemptPlacement={attemptPlacement}
/>
```

Use the manifest name in the title and `sessionState.pieceCount` in progress copy. Add only one **LIBRARY** exit action; HPA-3 owns production controls.

- [ ] **Step 6: Delete the fixture path and fence destructive reads**

Delete `fixture.ts` and all four bundled HPA-1 PNGs.

Run:

```bash
rg "HPA1_FIXTURE|assets/hpa-1|PIECE_IDS|HPA-1 Offline" apps/mobile
rg "\.loadSession\(" apps/mobile/app
```

Expected: no matches for either command.

- [ ] **Step 7: Run checks and commit**

```bash
cd apps/mobile
bun run test:unit
cd ../..
bunx tsc --project apps/mobile/tsconfig.json --noEmit
bunx prettier --check apps/mobile/app apps/mobile/types apps/mobile/webpack.config.js apps/mobile/package.json
git add -A apps/mobile/app
git commit -m "feat(mobile): launch downloaded puzzles offline"
```

---

### Task 7: Prove the complete HPA-2 path and finish the single implementation PR

**Files:**
- No new production file is planned.
- If the smoke exposes a real defect, fix it in the existing owning Task 1-6 file before recording evidence.
- Update the same implementation PR body with exact commands/environment/evidence.

**Interfaces:**
- Consumes the complete Tasks 1-6 implementation.
- Produces final acceptance evidence for transfer, finalization, disk reconstruction, offline gameplay/resume, progress independence, and corrupt-package recovery.

- [ ] **Step 1: Run repository-level gates**

```bash
bun run --cwd packages/types test:unit
bun run --cwd apps/mobile test:unit
bunx tsc --project apps/mobile/tsconfig.json --noEmit
bunx prettier --check apps/mobile/app apps/mobile/types apps/mobile/webpack.config.js apps/mobile/package.json
bun run check
bun run lint
```

Expected: all PASS. Record any unrelated pre-existing aggregate environment failure without weakening focused mobile/type tests.

- [ ] **Step 2: Launch against a reachable API**

For simulator/local development:

```bash
bun run dev --filter=@perseus/api
```

Then:

```bash
cd apps/mobile
PERSEUS_MOBILE_API_BASE=http://localhost:4690 ns run ios --no-hmr
```

For physical iPad/TestFlight-like verification, use a reachable HTTPS API unless intentionally exercising the declared local-network development path.

Record NativeScript CLI, `@nativescript/core`, `@nativescript/canvas`, Xcode, simulator/device, and iOS versions.

- [ ] **Step 3: Prove explicit finalization and relaunch discovery**

Download one ready Gallery puzzle and inspect the app container:

```text
perseus/downloads/<puzzle-id>/manifest.json
perseus/downloads/<puzzle-id>/thumbnail.<ext>
perseus/downloads/<puzzle-id>/pieces/0.<ext>
```

Require:

- finalized package exists;
- `.staging/<puzzle-id>` does not remain;
- terminate/relaunch reconstructs the same Downloaded row from disk without downloading again.

- [ ] **Step 4: Prove read-only scan is safe during an active download**

Start a sufficiently large download, trigger the Downloaded/manual refresh while it is still active, and confirm:

- the active `.staging/<puzzle-id>` directory remains;
- the download continues/finalizes normally;
- refresh does not perform staging cleanup.

This is the native integration fence for the split `cleanupStaleStaging()` / `scanDownloads()` contract.

- [ ] **Step 5: Prove offline start and resume**

After finalization, stop the local API or otherwise disable networking.

1. Start from a `none` row.
2. Place at least one piece.
3. Leave/terminate so HPA-1 checkpoint logic runs.
4. Relaunch with API still unavailable.
5. Confirm Downloaded loads from disk and shows **Resume**.
6. Resume and confirm placement/counters persist.

Gallery failure must not clear/block Downloaded.

- [ ] **Step 6: Prove a valid completed/non-resumable save is not collapsed to Start**

Complete a small downloaded puzzle or seed a real completed session through gameplay, return to Downloaded, and verify:

- row is not treated as `none`;
- **START** is not offered while the valid session file is present;
- **DISCARD PROGRESS** is available;
- after explicit discard, row becomes `none` and **START** appears.

This proves a completed session cannot be silently overwritten by starting again.

- [ ] **Step 7: Prove Remove Download preserves resumable progress and re-download restores Resume**

With resumable progress:

1. **Remove Download**;
2. verify `downloads/<id>` is gone;
3. verify `sessions/<id>.json` remains;
4. restore networking;
5. re-download the same stable ID;
6. confirm **Resume** returns after codec validation;
7. resume and confirm retained placement.

- [ ] **Step 8: Prove corrupt-package blocking and clean replacement**

Delete one finalized piece file and refresh/relaunch. Require:

- package is corrupt;
- no Start/Resume;
- **Remove & Download Again** is available;
- clean re-download uses the normal staging/finalize path;
- package returns to installed only after manifest-last finalization.

- [ ] **Step 9: Run final scope/destructive-read fences**

```bash
git diff --name-only main...HEAD
rg "HPA1_FIXTURE|assets/hpa-1|downloads\.json" apps/mobile
rg "\.loadSession\(" apps/mobile/app
```

Expected:

- no fixture/index/destructive mobile load matches;
- no `apps/api`, `apps/workflows`, database migration, infrastructure, or `packages/game-core` production file in the diff;
- `packages/types/src/core.ts` changes only for `ReadyPuzzleDetail`;
- intended mobile API/library/gameplay/config/plist/lockfile changes plus fixture deletions only.

If the existing public API or game-core contract proves insufficient, stop and revise HPA-2; do not add a mobile-only backend workaround or shared framework ad hoc.

- [ ] **Step 10: Update the implementation PR body**

Record:

- Task 1 JSON native-gate evidence;
- Task 3 binary `toFile` + directory-move gate evidence;
- unit/type/lint/check results;
- final offline/relaunch/remove/re-download/corruption evidence;
- exact environment versions.

Keep all implementation in the same HPA-2 PR.

## Risks and Gates Summary

1. **Native JSON/local networking** — gated before Task 2; narrow iOS local-network declarations only, remote builds HTTPS.
2. **Binary response → file** — gated in Task 3 before UI integration.
3. **Same-volume directory move** — path and URL `NSFileManager` bridge variants are probed; failure after both stops the design rather than introducing silent copy/delete semantics.
4. **Staging cleanup race** — startup cleanup is a separate method; `scanDownloads()` is read-only and safe from any later call site.
5. **Invalid-save deletion** — HPA-2 uses `peekSession()` only; `.loadSession(` is fenced out of mobile app code.
6. **Completed/non-resumable save overwrite** — four-arm progress state keeps valid loaded non-resumable sessions as `present`; fresh Start is unavailable until explicit discard.

## Self-Review Results

- **Spec coverage:** Tasks 1-7 cover existing public API use, shared metadata validation, local-network/native gates, explicit staging/finalization, bounded concurrency, failed/cancelled cleanup, read-only discovery, startup cleanup, offline start/resume, independent asset/progress removal, matching re-download validation, non-resumable saved state, corrupt-package recovery, service tests, and native iPad proof.
- **Scope:** No API route, Workflow, database, game-core, index, ZIP, auth, sync, portrait, or HPA-3 gameplay expansion is planned.
- **Atomicity:** In-flight writes settle before failure cleanup; assets verify before manifest write; manifest write precedes same-volume finalization.
- **Type consistency:** `ReadyPuzzleDetail` feeds `createDownloadManifest`; `DownloadManifestV1` feeds `InstalledDownload`; `InstalledDownload` feeds `DownloadedPuzzleRow`/`GameplayLaunch`; the same manifest projects `SessionPuzzleSpec` for validation and gameplay.
- **Progress ownership:** `DownloadStore` has no session dependency. Only explicit Discard calls `clearSession()`. Library and gameplay use `peekSession()`.
- **Fixture removal:** Dynamic `piecePaths` replaces the only HPA-1 bundled-asset dependency, so no compatibility fixture path remains.
- **No placeholders:** File paths, interfaces, native stop gates, failure ordering, test assertions, commands, and stop conditions are explicit.