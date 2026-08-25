# HPA-2 Explicit Downloads and Offline Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the HPA-1 bundled fixture with an explicit-download Gallery and filesystem-derived Downloaded library that can start and resume finalized puzzle packages completely offline.

**Architecture:** Keep all new product behavior mobile-local. Reuse existing public puzzle endpoints, `validatePuzzleMetadata()`, HPA-1 file/session seams, game-core validation, and the repository's chunked bounded-concurrency pattern. `App.svelte` owns concrete services plus the one active download job; `DownloadStore` owns staging/finalization/scan; saved progress is always inspected non-destructively with `peekSession()`.

**Tech Stack:** NativeScript 9, Svelte Native 4, TypeScript 5.9, `@nativescript/core` HTTP/FileSystem, `@perseus/types`, `@perseus/game-core`, Vitest 4, Bun 1.3.14.

**Spec:** `docs/superpowers/specs/2026-08-25-hpa-2-offline-download-library-design.md`

## Global Constraints

- Deliver HPA-2 as **one implementation PR**. Task commits are review checkpoints inside that PR.
- Existing `/api/puzzles` and asset endpoints only. No API route, Workflow, D1, R2-layout, or infrastructure change.
- No production change to `packages/types` or `packages/game-core` is planned.
- Add no third-party runtime dependency. `@perseus/types` is the only expected new mobile workspace dependency.
- One puzzle download at a time; assets run in sequential chunks of at most **5** concurrent requests.
- Report simple `done / total` download progress. No queue/background service/resumable chunks.
- `manifest.json` is written last; same-volume directory move is the install boundary.
- `scanDownloads()` is read-only. `cleanupStaleStaging()` is separate and app-startup-only.
- `scanDownloads()` continues to verify every manifest-referenced required asset for HPA-2; defer scan optimization until measured.
- Only explicit Discard calls `SessionStorageAdapter.clearSession()`.
- HPA-2 mobile code never calls `SessionStorageAdapter.loadSession()`; `peekSession()` is the only read path.
- Progress states are `none | resumable | protected | invalid`. A valid zero-activity snapshot is `none`; meaningful activity or sealed completion is protected.
- Downloaded server puzzles stay `SessionPuzzleSpec.source = 'api'`.
- The server's `hasReference` flag is not a mobile install dependency. Reference is attempted directly; 404 means absent.
- Keep HPA-1 board/layout behavior. HPA-3 owns production gameplay parity.
- Delete HPA-1 fixture code/assets after dynamic downloaded assets work; no compatibility path.
- Remote/TestFlight API bases use HTTPS. Local iOS development uses narrow local-network plist declarations; never set `NSAllowsArbitraryLoads`.
- Native JSON is gated in Task 1; binary `toFile` + iOS directory move are gated in Task 3 before UI integration.
- Native directory finalization is iOS-only in HPA-2. Non-iOS throws unsupported rather than shipping an unverified Android branch.

## Review Decisions Locked by This Plan

- **Accepted:** zero-activity snapshots must remain Start-able; meaningful/completed saves remain protected.
- **Accepted:** the manifest delegates puzzle geometry validation to `validatePuzzleMetadata()` and `createPuzzleSession()` instead of copying those rules.
- **Accepted:** the app root owns the active download promise/cancellation/progress so navigation does not orphan it.
- **Accepted:** fixed-size chunks + `Promise.allSettled()` replace the custom worker-pool scheduler.
- **Accepted:** reference download is attempted directly; 404 means absent. No HPA-2 `ReadyPuzzleDetail` shared cleanup.
- **Not adopted:** moving piece-file corruption detection from scan to gameplay entry. Keep one bounded corruption boundary until measurement justifies another state path.
- **Accepted:** Library + dynamic Gameplay wiring land in one runnable task; no broken intermediate checkpoint.
- **Accepted:** action derivation is a pure table-tested function.
- **Accepted:** iOS-only move branch; no speculative Android `renameTo()`.
- **Accepted:** simple `done / total` download progress.
- **Accepted:** constructor strips trailing API-base slashes.
- **Partially accepted:** Gate B is simplified to HPA-1's established `(globalThis as any)` URL-first bridge style, but directory-move failure remains a stop because atomic finalization depends on it.

---

### Task 1: Validated mobile puzzle API + real iOS JSON gate

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `bun.lock`
- Modify: `apps/mobile/webpack.config.js`
- Modify: `apps/mobile/App_Resources/iOS/Info.plist`
- Create: `apps/mobile/types/globals.d.ts`
- Create: `apps/mobile/app/api/puzzleApi.ts`
- Create: `apps/mobile/app/api/puzzleApi.test.ts`
- Create: `apps/mobile/app/api/nativePuzzleHttp.ts`
- Temporary probe only, reverted before commit: `apps/mobile/app/App.svelte`

**Interfaces:**

```ts
import type { PuzzleListResponse, ReadyPuzzle } from '@perseus/types';

export type PuzzleJsonRequest = (url: string) => Promise<unknown>;

export interface PuzzleApi {
	listPuzzles(cursor?: string): Promise<PuzzleListResponse>;
	getPuzzle(puzzleId: string): Promise<ReadyPuzzle>;
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

- [ ] **Step 1: Add the existing shared-types dependency**

Add to `apps/mobile/package.json` beside `@perseus/game-core`:

```json
"@perseus/types": "workspace:*"
```

Then refresh the lockfile:

```bash
bun install
```

Do not add any new package.

- [ ] **Step 2: Add the build-time API base and strip trailing slashes in the client**

Create `apps/mobile/types/globals.d.ts`:

```ts
declare const __PERSEUS_API_BASE__: string;
```

Extend the existing webpack config without replacing its aliases:

```js
const apiBase = process.env.PERSEUS_MOBILE_API_BASE ?? 'http://localhost:4690';

webpack.chainWebpack((config) => {
	config.plugin('DefinePlugin').tap((args) => {
		args[0].__PERSEUS_API_BASE__ = JSON.stringify(apiBase);
		return args;
	});
});
```

`createPuzzleApi()` must normalize once:

```ts
const baseUrl = options.baseUrl.replace(/\/+$/, '');
```

This is load-bearing: a caller may pass `https://api.example.test/`, but generated URLs must contain only one slash before `api`.

- [ ] **Step 3: Add narrow iOS local-network declarations**

Add to the root `<dict>` of `apps/mobile/App_Resources/iOS/Info.plist`:

```xml
<key>NSAppTransportSecurity</key>
<dict>
	<key>NSAllowsLocalNetworking</key>
	<true/>
</dict>
<key>NSLocalNetworkUsageDescription</key>
<string>Connect to a local Perseus development server.</string>
```

Do not add `NSAllowsArbitraryLoads` or an insecure remote-domain exception.

- [ ] **Step 4: Write failing API tests**

Create `apps/mobile/app/api/puzzleApi.test.ts`. Use a valid ready fixture with four fully typed `PuzzlePiece` rows. Pin at least these cases:

```ts
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
```

Also assert requested/detail ID mismatch => `invalid_puzzle_response`.

Do **not** test or require `hasReference`; mobile ignores that display-only field.

- [ ] **Step 5: Run the focused test and verify RED**

```bash
cd apps/mobile
bunx vitest run app/api/puzzleApi.test.ts
```

Expected: FAIL because `puzzleApi.ts` does not exist.

- [ ] **Step 6: Implement `PuzzleApi` using existing validation**

Core detail path:

```ts
import {
	validatePuzzleMetadata,
	type PuzzleListResponse,
	type ReadyPuzzle
} from '@perseus/types';

async function getPuzzle(puzzleId: string): Promise<ReadyPuzzle> {
	const raw = await options.requestJson(
		`${baseUrl}/api/puzzles/${encodeURIComponent(puzzleId)}`
	);
	if (!validatePuzzleMetadata(raw)) throw new Error('invalid_puzzle_response');
	if (raw.status !== 'ready') throw new Error('puzzle_not_ready');
	if (raw.id !== puzzleId) throw new Error('invalid_puzzle_response');

	return {
		id: raw.id,
		name: raw.name,
		...(raw.category ? { category: raw.category } : {}),
		...(raw.aspectRatio ? { aspectRatio: raw.aspectRatio } : {}),
		pieceCount: raw.pieceCount,
		gridCols: raw.gridCols,
		gridRows: raw.gridRows,
		imageWidth: raw.imageWidth,
		imageHeight: raw.imageHeight,
		createdAt: raw.createdAt,
		pieces: raw.pieces.map((piece) => ({
			...piece,
			edges: { ...piece.edges }
		})),
		version: raw.version,
		status: 'ready'
	};
}
```

The explicit projection drops unmodeled response extras such as `hasReference`. URL helper names/patterns mirror the existing web client, but mobile does not import `$lib/services/api.ts`.

- [ ] **Step 7: Implement the NativeScript JSON adapter**

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

No retries/auth/general transport wrapper.

- [ ] **Step 8: Run unit/type checks**

```bash
cd apps/mobile
bunx vitest run app/api/puzzleApi.test.ts
bun run test:unit
cd ../..
bunx tsc --project apps/mobile/tsconfig.json --noEmit
```

Expected: PASS.

- [ ] **Step 9: Native Gate A — prove real JSON before Task 2**

Start a reachable API:

```bash
bun run dev --filter=@perseus/api
```

Temporarily add to `App.svelte`:

```ts
import { onMount } from 'svelte';
import { nativePuzzleJsonRequest } from './api/nativePuzzleHttp';

onMount(async () => {
	const result = await nativePuzzleJsonRequest(`${__PERSEUS_API_BASE__}/api/puzzles`);
	console.log('HPA2_JSON_PROBE', JSON.stringify(result));
});
```

Run:

```bash
cd apps/mobile
PERSEUS_MOBILE_API_BASE=http://localhost:4690 ns run ios --no-hmr
```

Pass: the console contains `HPA2_JSON_PROBE` with the real list envelope and no iOS transport/local-network error.

Remove only the temporary probe before commit and verify:

```bash
rg "HPA2_JSON_PROBE" apps/mobile/app/App.svelte
```

Expected: no match. If Gate A fails, stop HPA-2 before Task 2.

- [ ] **Step 10: Commit**

```bash
git add apps/mobile/package.json bun.lock apps/mobile/webpack.config.js \
	apps/mobile/App_Resources/iOS/Info.plist apps/mobile/types/globals.d.ts \
	apps/mobile/app/api
git commit -m "feat(mobile): add validated public puzzle API client"
```

---

### Task 2: Thin local manifest wrapper over shared puzzle metadata

**Files:**
- Create: `apps/mobile/app/library/downloadManifest.ts`
- Create: `apps/mobile/app/library/downloadManifest.test.ts`

**Interfaces:**

```ts
import type { ReadyPuzzle } from '@perseus/types';
import type { SessionPuzzleSpec } from '@perseus/game-core';

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

export function createDownloadManifest(
	puzzle: ReadyPuzzle,
	files: DownloadedAssetFiles,
	downloadedAt: number
): DownloadManifestV1;

export function parseDownloadManifest(value: unknown): DownloadManifestV1;
export function sessionSpecFromManifest(manifest: DownloadManifestV1): SessionPuzzleSpec;
```

- [ ] **Step 1: Write RED tests only for genuinely new disk rules**

Cover:

```ts
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
		2,
		7,
		11,
		19
	]);
});
```

The non-contiguous IDs deliberately fence against inventing a `0..pieceCount-1` mobile contract.

Also reject:

- `schemaVersion: 2`;
- `puzzle` failing `validatePuzzleMetadata()`;
- non-ready puzzle metadata;
- non-finite `downloadedAt`;
- unsafe thumbnail/reference/piece filenames (`/x`, `../x`, backslashes, `pieces/../x`);
- missing piece-file key for an actual `puzzle.pieces[].id`;
- extra piece-file key not present in puzzle metadata.

Do not duplicate tests for grid math, aspect-ratio rules, coordinate bounds, duplicate IDs, or duplicate canonical cells; those belong to existing shared/game-core tests.

- [ ] **Step 2: Verify RED**

```bash
cd apps/mobile
bunx vitest run app/library/downloadManifest.test.ts
```

Expected: FAIL because `downloadManifest.ts` does not exist.

- [ ] **Step 3: Implement safe relative paths + delegated metadata validation**

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

`parseDownloadManifest()` must:

1. require object + `schemaVersion === 1`;
2. call `validatePuzzleMetadata(record.puzzle)` and require `status === 'ready'`;
3. require finite `downloadedAt`;
4. validate thumbnail/reference paths;
5. validate `pieceFiles` as a plain object;
6. build `expectedIds = new Set(puzzle.pieces.map((piece) => String(piece.id)))`;
7. require `Object.keys(pieceFiles)` has exactly the same keys as `expectedIds`;
8. require every mapped path is safe.

`createDownloadManifest()` constructs `{ schemaVersion: 1, puzzle, files, downloadedAt }` and immediately re-parses it.

- [ ] **Step 4: Implement only the SessionPuzzleSpec projection**

```ts
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
```

`createPuzzleSession()` remains the stronger gameplay geometry invariant boundary.

- [ ] **Step 5: GREEN + commit**

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

### Task 3: Chunked atomic download store + native binary/move gate

**Files:**
- Create: `apps/mobile/app/library/downloadStore.ts`
- Create: `apps/mobile/app/library/downloadStore.test.ts`
- Create: `apps/mobile/app/library/nativeDownloadFiles.ts`
- Temporary probe only, reverted before commit: `apps/mobile/app/App.svelte`

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
```

- [ ] **Step 1: Write RED tests for chunking, progress, and finalization**

Use a fake with at least 8 required asset requests. Hold the first five promises and assert request 6 has not started. Release all five; then assert request 6 begins. This pins the user-visible behavior (“at most five in flight”) without reimplementing a worker pool in the test.

Pin progress:

```ts
expect(progress[0]).toEqual([0, expectedTotal]);
expect(progress.at(-1)).toEqual([expectedTotal, expectedTotal]);
```

Pin order:

```ts
expect(lastAssetOperation).toBeLessThan(manifestWriteOperation);
expect(manifestWriteOperation).toBeLessThan(finalMoveOperation);
```

For a failure in the first chunk, keep another request pending after one rejects; assert no second chunk starts and staging removal occurs only after every promise in the current chunk settles.

Also cover cancellation, zero-byte required asset, and failed final move.

- [ ] **Step 2: Write RED tests for opportunistic reference**

The reference request is always included regardless of server detail extras.

Assert:

```ts
// reference 404
expect(result.manifest.files.referenceFile).toBeUndefined();

// thumbnail/piece 404
await expect(store.downloadPuzzle(puzzle)).rejects.toThrow('required_asset_not_found');
```

A reference 500/transport rejection still fails the entire install.

- [ ] **Step 3: Write RED tests for scan/cleanup separation and corruption**

Seed `.staging/in-progress` and finalized packages:

```ts
await store.scanDownloads();
expect(fileOps.removedDirectories).not.toContain('/downloads/.staging/in-progress');

await store.cleanupStaleStaging();
expect(fileOps.removedDirectories).toContain('/downloads/.staging/in-progress');
```

Also assert:

- missing downloads root => `scanDownloads()` returns `[]` without creating it;
- valid package => installed;
- missing/malformed/unsupported manifest => corrupt;
- folder name differs from `manifest.puzzle.id` => corrupt;
- missing/zero-byte thumbnail, reference, or any piece => corrupt;
- Remove Download touches only `downloads/<id>`.

Keep the complete scan verification for HPA-2; do not add a second launch-time corruption state machine.

- [ ] **Step 4: Verify RED**

```bash
cd apps/mobile
bunx vitest run app/library/downloadStore.test.ts
```

Expected: FAIL because the store does not exist.

- [ ] **Step 5: Implement chunked request processing using the repository pattern**

Do not add `mapWithConcurrency`. Use fixed chunks like the existing reaper:

```ts
const ASSET_CHUNK_SIZE = 5;

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
		const settled = await Promise.allSettled(
			chunk.map((request) => downloadOne(request))
		);

		let firstFailure: unknown = null;
		for (let index = 0; index < settled.length; index += 1) {
			const outcome = settled[index]!;
			done += 1;
			onProgress?.(done, requests.length);
			if (outcome.status === 'rejected') {
				firstFailure ??= outcome.reason;
				continue;
			}
			results.push(outcome.value);
		}

		if (firstFailure !== null) throw firstFailure;
		if (cancellation?.cancelled) throw new Error('download_cancelled');
	}

	return results;
}
```

`downloadOne()` owns required-vs-optional semantics: `not_found` is accepted only for the reference request; for thumbnail/pieces it throws `required_asset_not_found`.

This structure guarantees no next chunk starts after a failure and already-started writes settle before cleanup.

- [ ] **Step 6: Implement `downloadPuzzle()`**

`createDownloadStore()` consumes:

```ts
{
	rootPath: string;
	fileOps: DownloadFileOps;
	downloadAsset: AssetDownloader;
	assetUrls: Pick<PuzzleApi, 'thumbnailUrl' | 'referenceUrl' | 'pieceImageUrl'>;
	now: () => number;
}
```

For a validated ready puzzle:

1. validate `puzzle.id` as one safe path segment;
2. reject `download_already_installed` when final directory exists;
3. clear only `.staging/<id>` and create `.staging/<id>/pieces`;
4. add thumbnail request;
5. add reference request **unconditionally**, marked optional-on-404;
6. add one required piece request per `puzzle.pieces[].id`;
7. run chunks of 5;
8. convert successful content types to local extensions;
9. require each required file `fileSize > 0`;
10. build `DownloadedAssetFiles` from actual piece IDs and successful optional reference;
11. create/validate `DownloadManifestV1`;
12. write `manifest.json` last;
13. move staging to final;
14. return resolved absolute paths.

Use `try/finally`; remove the job's staging only when finalization did not complete. The chunk function has already settled current writes before it throws.

- [ ] **Step 7: Implement read-only scan and separate startup cleanup**

`scanDownloads()`:

- returns `[]` if root does not exist;
- ignores `.staging`;
- enumerates finalized direct child directories only;
- parses `manifest.json`;
- requires folder name === `manifest.puzzle.id`;
- verifies every referenced thumbnail/reference/piece path exists and is non-empty;
- resolves `piecePaths` from the manifest's actual piece IDs;
- catches errors per package and emits `CorruptDownload` instead of aborting the whole scan;
- never writes/removes/creates anything.

`cleanupStaleStaging()` ensures the roots exist and removes only direct child directories under `.staging`.

`removeDownload(id)` validates one path segment and removes only the finalized package.

- [ ] **Step 8: Implement NativeScript asset/file operations; iOS move only**

Use `File`, `Folder`, `Http`, `isIOS`, and `path` from `@nativescript/core`.

Map image types:

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

Native download:

```ts
const response = await Http.request({ url, method: 'GET' });
if (response.statusCode === 404) return { kind: 'not_found' };
if (response.statusCode < 200 || response.statusCode >= 300) {
	throw new Error(`download_http_${response.statusCode}`);
}
if (!response.content) throw new Error('download_empty_response');
const extension = imageExtension(readContentType(response.headers));
const file = response.content.toFile(destinationBasePath + extension);
if (!file || file.size <= 0) throw new Error('download_empty_file');
return { kind: 'downloaded', extension, bytes: file.size };
```

For `moveDir()`:

```ts
if (!isIOS) throw new Error('download_directory_move_unsupported');

const g = globalThis as any;
const fm = g.NSFileManager.defaultManager;
const fromUrl = g.NSURL.fileURLWithPath(fromPath);
const toUrl = g.NSURL.fileURLWithPath(toPath);

let moved = false;
try {
	moved = Boolean(fm.moveItemAtURLToURLError(fromUrl, toUrl, null));
} catch {
	moved = false;
}
if (!moved) {
	moved = Boolean(fm.moveItemAtPathToPathError(fromPath, toPath, null));
}
if (!moved || Folder.exists(fromPath) || !Folder.exists(toPath)) {
	throw new Error('download_directory_move_failed');
}
```

Match HPA-1's `(globalThis as any)` bridge style. Do not add `java.io.File.renameTo()`.

- [ ] **Step 9: Run unit/type checks**

```bash
cd apps/mobile
bunx vitest run app/library/downloadStore.test.ts
bun run test:unit
cd ../..
bunx tsc --project apps/mobile/tsconfig.json --noEmit
```

Expected: PASS.

- [ ] **Step 10: Native Gate B — prove binary file + directory move**

Use the already-proven URL-style iOS bridge first; the path variant is only fallback.

Temporarily add an `App.svelte` probe that:

1. fetches one real thumbnail through `downloadNativeAsset()`;
2. proves returned `kind === 'downloaded'` and `bytes > 0`;
3. creates `Documents/perseus/hpa2-native-probe/.staging` with `sentinel.txt`;
4. calls the real native `moveDir()` to sibling `final`;
5. asserts staging is absent and `final/sentinel.txt` exists;
6. logs `HPA2_FILE_PROBE PASS`;
7. removes probe data.

Run:

```bash
cd apps/mobile
PERSEUS_MOBILE_API_BASE=http://localhost:4690 ns run ios --no-hmr
```

Remove the temporary probe and verify:

```bash
rg "HPA2_FILE_PROBE|hpa2-native-probe" apps/mobile/app/App.svelte
```

Expected: no matches.

If both URL and path directory moves fail, stop and revise finalization. HPA-1 proves the bridge family exists, but HPA-2 still depends specifically on directory move semantics.

- [ ] **Step 11: Commit**

```bash
git add apps/mobile/app/library/downloadStore.ts \
	apps/mobile/app/library/downloadStore.test.ts \
	apps/mobile/app/library/nativeDownloadFiles.ts
git commit -m "feat(mobile): add atomic puzzle downloads"
```

---

### Task 4: Correct progress classification + tested action matrix

**Files:**
- Create: `apps/mobile/app/library/downloadedLibrary.ts`
- Create: `apps/mobile/app/library/downloadedLibrary.test.ts`

**Interfaces:**

```ts
export type ProgressState =
	| { kind: 'none' }
	| { kind: 'resumable' }
	| { kind: 'protected' }
	| { kind: 'invalid'; reason: string };

export type DownloadedAction =
	| 'start'
	| 'resume'
	| 'discard_progress'
	| 'remove_download';

export interface DownloadedPuzzleRow {
	install: InstalledDownload;
	progress: ProgressState;
}

export interface GameplayLaunch {
	install: InstalledDownload;
	mode: 'start' | 'resume';
}

export function classifyProgress(
	result: SessionLoadResult,
	storage: Pick<SessionStorageAdapter, 'isResumable'>
): ProgressState;

export function actionsForProgress(progress: ProgressState): readonly DownloadedAction[];

export function buildDownloadedRows(
	installed: readonly InstalledDownload[],
	storage: SessionStorageAdapter
): DownloadedPuzzleRow[];
```

- [ ] **Step 1: RED — prove the real session-state matrix**

Use `createSessionStorageAdapter()` over an in-memory `SessionKeyValueStore` and real `PuzzleSession` snapshots.

Assert all four states:

```ts
expect(classifyProgress({ status: 'missing' }, storage)).toEqual({ kind: 'none' });
```

Create a fresh session, dispatch `start`, serialize immediately without interaction, and assert the **loaded** snapshot still classifies as `none`:

```ts
expect(zeroActivitySnapshot.hasUserActivity).toBe(false);
expect(classifyProgress({ status: 'loaded', snapshot: zeroActivitySnapshot }, storage)).toEqual({
	kind: 'none'
});
```

Place one correct piece in a non-complete puzzle and assert `resumable`.

Complete the real puzzle and serialize; assert:

```ts
expect(completedSnapshot.sealedCompletion).not.toBeNull();
expect(classifyProgress({ status: 'loaded', snapshot: completedSnapshot }, storage)).toEqual({
	kind: 'protected'
});
```

Use the same stable puzzle ID with changed canonical metadata and assert `invalid/cross_field_violation` through `peekSession()`.

- [ ] **Step 2: RED — table-test every action arm**

```ts
it.each([
	[{ kind: 'none' }, ['start', 'remove_download']],
	[{ kind: 'resumable' }, ['resume', 'discard_progress', 'remove_download']],
	[{ kind: 'protected' }, ['discard_progress', 'remove_download']],
	[{ kind: 'invalid', reason: 'cross_field_violation' }, ['discard_progress', 'remove_download']]
] as const)('maps %j to the intended actions', (progress, actions) => {
	expect(actionsForProgress(progress)).toEqual(actions);
});
```

This is the product action contract; keep it out of Svelte conditionals.

- [ ] **Step 3: Verify RED**

```bash
cd apps/mobile
bunx vitest run app/library/downloadedLibrary.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement `classifyProgress()`**

```ts
export function classifyProgress(
	result: SessionLoadResult,
	storage: Pick<SessionStorageAdapter, 'isResumable'>
): ProgressState {
	if (result.status === 'missing') return { kind: 'none' };
	if (result.status === 'invalid') return { kind: 'invalid', reason: result.reason };
	if (storage.isResumable(result.snapshot)) return { kind: 'resumable' };
	if (result.snapshot.hasUserActivity || result.snapshot.sealedCompletion !== null) {
		return { kind: 'protected' };
	}
	return { kind: 'none' };
}
```

`buildDownloadedRows()` derives `SessionPuzzleSpec`, calls `validationContextFrom()`, calls **only** `storage.peekSession()`, then passes that result through `classifyProgress()`.

- [ ] **Step 5: Implement `actionsForProgress()`**

```ts
export function actionsForProgress(progress: ProgressState): readonly DownloadedAction[] {
	switch (progress.kind) {
		case 'none':
			return ['start', 'remove_download'];
		case 'resumable':
			return ['resume', 'discard_progress', 'remove_download'];
		case 'protected':
		case 'invalid':
			return ['discard_progress', 'remove_download'];
	}
}
```

- [ ] **Step 6: Prove Remove Download / re-download independence**

Extend the real-codec test:

1. save a resumable snapshot;
2. remove only the finalized package through the Task 3 fake;
3. assert the session key still exists;
4. seed a matching finalized package with the same ID;
5. assert `buildDownloadedRows()` returns `resumable` again.

No production dependency from `DownloadStore` to session storage is allowed.

- [ ] **Step 7: GREEN + commit**

```bash
cd apps/mobile
bunx vitest run app/library/downloadedLibrary.test.ts
bun run test:unit
cd ../..
git add apps/mobile/app/library/downloadedLibrary.ts apps/mobile/app/library/downloadedLibrary.test.ts
git commit -m "feat(mobile): derive downloaded progress actions"
```

---

### Task 5: One runnable Library + dynamic Gameplay integration slice

**Files:**
- Modify: `apps/mobile/app/App.svelte`
- Modify: `apps/mobile/app/app.css`
- Create: `apps/mobile/app/library/Library.svelte`
- Create: `apps/mobile/app/library/Gallery.svelte`
- Create: `apps/mobile/app/library/Downloaded.svelte`
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Delete: `apps/mobile/app/gameplay/fixture.ts`
- Delete: `apps/mobile/app/assets/hpa-1/piece-0.png`
- Delete: `apps/mobile/app/assets/hpa-1/piece-1.png`
- Delete: `apps/mobile/app/assets/hpa-1/piece-2.png`
- Delete: `apps/mobile/app/assets/hpa-1/piece-3.png`

**App-owned state:**

```ts
type MobileScreen =
	| { kind: 'library' }
	| { kind: 'gameplay'; launch: GameplayLaunch };

interface ActiveDownloadJob {
	puzzleId: string;
	cancellation: DownloadCancellation;
	done: number;
	total: number;
}
```

`App.svelte` owns the concrete services and `ActiveDownloadJob | null` so navigation cannot destroy the job owner.

- [ ] **Step 1: Convert Gameplay/Canvas from fixture inputs to launch inputs first**

`Gameplay.svelte` props:

```ts
export let launch: GameplayLaunch;
export let storage: SessionStorageAdapter;
export let onExit: () => void;
```

`PuzzleCanvas.svelte` gains:

```ts
export let piecePaths: Record<number, string>;
```

Delete fixed `PIECE_IDS` and `~/assets/hpa-1/...` loading. Load from the actual map:

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

Keep board fit, density conversion, hit testing, tap, and drag behavior unchanged.

These edits are in the same task/commit as App wiring, so there is no intermediate committed state where App passes `launch` to an old fixture-only Gameplay component.

- [ ] **Step 2: Make Gameplay entry use the same non-destructive classifier**

```ts
const spec = sessionSpecFromManifest(launch.install.manifest);
const context = validationContextFrom(spec);
const loadResult = storage.peekSession(spec.puzzleId, context);
const progress = classifyProgress(loadResult, storage);

const restored =
	launch.mode === 'resume' && loadResult.status === 'loaded' && progress.kind === 'resumable'
		? loadResult.snapshot
		: undefined;

const canStart = launch.mode === 'start' && progress.kind === 'none';
const canResume = launch.mode === 'resume' && restored !== undefined;
const launchUnavailable = !canStart && !canResume;
```

When unavailable, render “Saved progress changed. Return to Downloaded.” plus **BACK TO LIBRARY**. Do not delete the save and do not construct a fresh session.

When allowed, construct the real session with:

- `metadata: spec`;
- HPA-1 `createDefaultClock()` and `createRunIdFactory(resolveMobileCrypto())`;
- `restored` only for Resume;
- initial/restart tray order from `spec.pieces.map((piece) => piece.id)`;
- HPA-1 zero-rotation generator.

Dispatch `start` and preserve HPA-1 checkpoint behavior. Start over a valid zero-activity snapshot is allowed and its first fresh checkpoint may replace that disposable record.

Never call `loadSession()`.

- [ ] **Step 3: Keep HPA-1 lifecycle persistence, but use injected storage/spec**

```ts
function persist(): void {
	if (!session) return;
	session.checkpointTime();
	const snapshot = serializeSession(session.getState());
	if (snapshot) storage.saveSession(spec.puzzleId, snapshot);
}
```

Keep suspend/resume/exit listener behavior and guard nullable session/unsubscribe values when launch is unavailable.

Change fixture-specific title/count copy to manifest/session values and add one **LIBRARY** button calling the provided `onExit()` after persistence.

- [ ] **Step 4: Construct concrete services in `App.svelte`**

Reuse HPA-1 session file ops/store:

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

No Svelte context, global store, or service container.

- [ ] **Step 5: Run stale cleanup exactly once at the persistent root**

```ts
let bootReady = false;
let bootError: string | null = null;

onMount(async () => {
	try {
		await downloadStore.cleanupStaleStaging();
	} catch (error) {
		bootError = error instanceof Error ? error.message : 'staging_cleanup_failed';
	} finally {
		bootReady = true;
	}
});
```

Render Library only after boot is ready. Do not move this call into `Library.svelte`.

- [ ] **Step 6: Own the one active download job in `App.svelte`**

```ts
let downloadJob: ActiveDownloadJob | null = null;
let downloadRevision = 0;
let downloadError: string | null = null;

async function startDownload(puzzleId: string): Promise<void> {
	if (downloadJob !== null) return;
	const cancellation: DownloadCancellation = { cancelled: false };
	downloadJob = { puzzleId, cancellation, done: 0, total: 0 };
	downloadError = null;

	try {
		const puzzle = await puzzleApi.getPuzzle(puzzleId);
		await downloadStore.downloadPuzzle(puzzle, cancellation, (done, total) => {
			if (downloadJob?.puzzleId === puzzleId) {
				downloadJob = { ...downloadJob, done, total };
			}
		});
	} catch (error) {
		downloadError = error instanceof Error ? error.message : 'download_failed';
	} finally {
		downloadJob = null;
		downloadRevision += 1;
	}
}

function cancelDownload(): void {
	if (downloadJob) downloadJob.cancellation.cancelled = true;
}
```

This root ownership lets Start/Resume remain available while another puzzle downloads. Do not add a download manager/store.

- [ ] **Step 7: Implement Gallery presentation**

`Gallery.svelte` receives puzzle rows, installed IDs, `downloadJob`, URL helper, `onDownload`, `onLoadMore`, and `onCancelDownload`.

For the active row show progress:

```ts
const progressText =
	downloadJob && downloadJob.total > 0
		? `DOWNLOADING ${downloadJob.done}/${downloadJob.total}`
		: 'DOWNLOADING…';
```

Only one Download can start at a time; other Download buttons are disabled while `downloadJob !== null`. Start/Resume in the Downloaded section are **not** disabled by the job.

Keep cursor Load More only; no search/category UI.

- [ ] **Step 8: Implement Downloaded presentation from the tested action matrix**

`Downloaded.svelte` calls `actionsForProgress(row.progress)` and renders only the returned actions.

Corrupt rows render **REMOVE & DOWNLOAD AGAIN** and **REMOVE DOWNLOAD** only; never construct a launch.

Local thumbnail path/name/piece count come from `InstalledDownload.manifest.puzzle`.

- [ ] **Step 9: Implement Library read orchestration**

`Library.svelte` props include:

```ts
export let puzzleApi: PuzzleApi;
export let downloadStore: DownloadStore;
export let sessionStorage: SessionStorageAdapter;
export let downloadJob: ActiveDownloadJob | null;
export let downloadRevision: number;
export let downloadError: string | null;
export let onDownload: (puzzleId: string) => void;
export let onCancelDownload: () => void;
export let onLaunch: (launch: GameplayLaunch) => void;
```

On mount:

```ts
void Promise.all([refreshDownloads(), loadGallery(false)]);
```

`refreshDownloads()` calls only read-only `scanDownloads()` and `buildDownloadedRows()`.

Track `downloadRevision`; when it changes while Library is mounted, refresh disk rows. If Library was unmounted during gameplay, its next mount already scans disk.

Compute Gallery `installedIds` from **all finalized scan entries**, including corrupt rows, so normal Download cannot overwrite an existing corrupt final package.

A Gallery/network failure sets online error copy but never clears Downloaded disk rows.

- [ ] **Step 10: Implement independent mutations**

```ts
async function discardProgress(id: string) {
	sessionStorage.clearSession(id);
	await refreshDownloads();
}

async function removeDownload(id: string) {
	await downloadStore.removeDownload(id);
	await refreshDownloads();
}

async function removeAndDownloadAgain(id: string) {
	await downloadStore.removeDownload(id);
	await refreshDownloads();
	onDownload(id);
}
```

Only Discard touches session storage.

- [ ] **Step 11: Wire the two-screen composition**

```svelte
{#if screen.kind === 'library'}
	<Library
		{puzzleApi}
		{downloadStore}
		sessionStorage={sessionStorage}
		{downloadJob}
		{downloadRevision}
		{downloadError}
		onDownload={startDownload}
		onCancelDownload={cancelDownload}
		onLaunch={(launch) => (screen = { kind: 'gameplay', launch })}
	/>
{:else}
	<Gameplay
		launch={screen.launch}
		storage={sessionStorage}
		onExit={() => (screen = { kind: 'library' })}
	/>
{/if}
```

A `none` row launches `mode: 'start'`; a `resumable` row launches `mode: 'resume'`. `protected`/`invalid` do not expose launch actions.

- [ ] **Step 12: Delete the HPA-1 fixture path completely**

Delete `fixture.ts` and all four HPA-1 piece PNGs. Then:

```bash
rg "HPA1_FIXTURE|assets/hpa-1|PIECE_IDS|HPA-1 Offline" apps/mobile
```

Expected: no matches.

- [ ] **Step 13: Verify the combined slice, including real Svelte/native compilation**

```bash
cd apps/mobile
bun run test:unit
cd ../..
bunx tsc --project apps/mobile/tsconfig.json --noEmit
bunx prettier --check apps/mobile/app apps/mobile/types apps/mobile/webpack.config.js apps/mobile/package.json
```

Then start/reuse the local API and compile/launch the actual app:

```bash
cd apps/mobile
PERSEUS_MOBILE_API_BASE=http://localhost:4690 ns run ios --no-hmr --justlaunch
```

Pass: the real app opens the Library, can select a downloaded launch path, and no Svelte prop/fixture compilation error occurs.

This native launch is required because `tsc --noEmit` alone does not type/compile `.svelte` component wiring.

- [ ] **Step 14: Commit**

```bash
git add -A apps/mobile/app
git commit -m "feat(mobile): add offline download library"
```

---

### Task 6: Final HPA-2 iPad acceptance + scope fence

**Files:**
- No production file is expected.
- Update the existing implementation PR body with exact evidence; do not create another HPA-2 PR.

- [ ] **Step 1: Run fresh non-native repository gates**

```bash
bun run --cwd apps/mobile test:unit
bunx tsc --project apps/mobile/tsconfig.json --noEmit
bunx prettier --check apps/mobile/app apps/mobile/types apps/mobile/webpack.config.js apps/mobile/package.json
bun run check
bun run lint
```

Record actual results. Do not claim aggregate success if a command is blocked by a pre-existing environment issue; record the exact command/error instead.

- [ ] **Step 2: Run the iOS app against a reachable API**

```bash
bun run dev --filter=@perseus/api
```

In another shell:

```bash
cd apps/mobile
PERSEUS_MOBILE_API_BASE=http://localhost:4690 ns run ios --no-hmr
```

Record NativeScript CLI, `@nativescript/core`, `@nativescript/canvas`, Xcode, simulator/device, and iOS versions in the implementation PR body.

For a physical iPad, use an HTTPS or otherwise explicitly allowed local API base reachable by the device; do not broaden ATS globally.

- [ ] **Step 3: Prove download progress and atomic finalization**

Download one ready puzzle with enough pieces to make progress visible. Verify:

- UI advances `done / total`;
- at most one puzzle download is active;
- final package contains `manifest.json`, thumbnail, optional reference when the endpoint succeeds, and every piece;
- `.staging/<id>` is gone after success;
- `manifest.json` is in the finalized package only after all required assets completed.

- [ ] **Step 4: Prove root-owned job survives navigation**

Start downloading puzzle A. While it is active, launch already-downloaded puzzle B from Downloaded.

Verify:

- gameplay opens normally; Start/Resume was not disabled by puzzle A's download;
- puzzle A continues/finalizes under the app root;
- returning to Library reconstructs/refreshes puzzle A as Downloaded;
- no staging directory was deleted by navigation or scan.

- [ ] **Step 5: Prove zero-activity reopen is not locked behind Discard**

For a downloaded puzzle with no prior progress:

1. Start it;
2. make no gameplay interaction;
3. return to Library so the HPA-1 checkpoint writes its zero-activity snapshot;
4. refresh/relaunch;
5. verify the row still exposes **START**, not only Discard;
6. Start again and verify no error/lockout.

This is the regression for the former `present` arm bug.

- [ ] **Step 6: Prove offline resumable progress**

Start a downloaded puzzle, place at least one piece, and checkpoint/leave. Disable networking or stop the API. Relaunch while offline and verify:

- Downloaded disk rows still load;
- the row exposes **RESUME**;
- Resume restores placement/counters;
- Gallery failure does not clear/block Downloaded.

- [ ] **Step 7: Prove completed progress is protected**

Complete a small downloaded puzzle and return to Library. Verify its valid completed snapshot does **not** expose Start. It exposes explicit Discard Progress/Remove Download. After Discard, Start appears.

- [ ] **Step 8: Prove Remove Download preserves progress and matching re-download restores Resume**

With a resumable session:

1. Remove Download;
2. verify `downloads/<id>` is gone;
3. verify `sessions/<id>.json` remains;
4. restore networking;
5. download the same stable ID;
6. verify Resume returns after canonical validation;
7. resume and confirm retained placement.

- [ ] **Step 9: Prove corrupt-package blocking remains scan-owned**

Delete one finalized piece file from the app container, then refresh/relaunch. Verify:

- scan marks the package corrupt;
- Start/Resume is unavailable;
- **Remove & Download Again** is offered;
- the action removes the bad final package and runs the normal clean path;
- the package becomes installed only after finalization.

This deliberately keeps corruption detection at scan rather than adding a second gameplay-entry repair state.

- [ ] **Step 10: Run final source/scope fences**

```bash
rg "\.loadSession\(" apps/mobile/app
rg "ReadyPuzzleDetail" apps/mobile packages/types apps/web
rg "java\.io\.File|renameTo\(" apps/mobile/app/library
rg "HPA1_FIXTURE|assets/hpa-1|downloads\.json|mapWithConcurrency" apps/mobile

git diff --name-only main...HEAD
```

Expected:

- no mobile `loadSession()` call;
- no HPA-2 `ReadyPuzzleDetail` type addition;
- no speculative Android directory move;
- no HPA-1 fixture/download index/custom worker-pool helper;
- no production diff in `apps/api`, `apps/workflows`, `packages/types`, `packages/game-core`, migrations, or infrastructure;
- intended mobile config/API/library/gameplay/fixture-deletion/lockfile changes only.

- [ ] **Step 11: Update the implementation PR body**

Record:

- focused and repository command results;
- Gate A/Gate B environment and evidence;
- final iPad download/progress/navigation/offline/relaunch/remove/re-download/corruption evidence;
- any pre-existing unrelated gate failure exactly as observed.

No verification-only repository file and no second HPA-2 PR.

## Self-Review Results

- **Spec coverage:** Tasks 1–6 cover existing API use, validated metadata, opportunistic reference, manifest schema, fixed-size chunking, progress, manifest-last finalization, safe cleanup, direct disk discovery, missing-file corruption, offline start/resume, independent asset/progress removal, matching re-download, zero-activity behavior, completed-save protection, and native iPad proof.
- **Reuse:** `validatePuzzleMetadata()` owns wire metadata checks; `createPuzzleSession()` remains the gameplay geometry boundary; chunked concurrency follows the existing reaper pattern; HPA-1 native/session seams are extended rather than replaced.
- **Scope:** No API/Workflow/database/infrastructure/game-core/types cleanup, ZIP, SQLite/index, auth/sync, portrait, or HPA-3 gameplay expansion.
- **Atomicity:** Current chunk settles before failure/cancel cleanup; required assets verify before manifest write; manifest write precedes same-volume final move.
- **Discovery:** Scan is read-only and keeps full missing-asset detection in one place. Stale cleanup runs once at persistent app boot.
- **Progress:** Zero-activity snapshot => `none`; live meaningful state => `resumable`; completion/meaningful non-resumable state => `protected`; invalid data remains explicit. The action matrix is a pure unit-tested function.
- **Job lifetime:** Download state lives in `App.svelte`, so navigation does not orphan the promise and Start/Resume need no download lockout.
- **Native scope:** iOS move only; URL bridge first using the HPA-1 global bridge convention; directory-move failure remains a design stop because finalization depends on it.
- **Runnable checkpoints:** Tasks 1 and 3 contain early native gates; Task 5 combines Library and Gameplay prop changes and ends with a real NativeScript launch, eliminating the previous non-runnable intermediate commit.
- **Review trade-off:** Full scan-time required-asset verification is intentionally retained; moving it to gameplay would add a second corruption path for an unmeasured optimization.
- **No placeholders:** All new interfaces, critical control flow, failure semantics, test matrices, commands, and stop conditions are explicit.