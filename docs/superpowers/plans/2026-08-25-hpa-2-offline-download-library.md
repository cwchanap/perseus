# HPA-2 Explicit Downloads and Offline Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the HPA-1 bundled fixture with an explicit-download Gallery and filesystem-derived Downloaded library that can start and resume finalized puzzle packages completely offline.

**Architecture:** Keep behavior mobile-local except for one API-detail wire type in `@perseus/types`. Reuse the existing public endpoints, `validatePuzzleMetadata()`, HPA-1 session/filesystem seams, and `PuzzleSession`. `DownloadStore` owns staging/finalization, `scanDownloads()` is read-only, stale staging is cleaned once at app boot, and saved progress is read with non-destructive `peekSession()`.

**Tech Stack:** NativeScript 9, Svelte Native 4, TypeScript 5.9, `@nativescript/core` HTTP/FileSystem, `@perseus/types`, `@perseus/game-core`, Vitest 4, Bun 1.3.14.

**Spec:** `docs/superpowers/specs/2026-08-25-hpa-2-offline-download-library-design.md`

## Global Constraints

- One HPA-2 implementation PR. Task commits below are review checkpoints inside that PR.
- Existing `/api/puzzles` and asset endpoints only. No API route, Workflow, D1, R2-layout, or infrastructure change.
- `packages/types` may gain only the ready-detail wire type for `hasReference`; keep `packages/game-core` unchanged.
- No third-party runtime dependency. `@perseus/types` is the only expected new mobile workspace dependency.
- One puzzle download at a time; exactly **5** concurrent asset requests inside it.
- Manifest-last + same-volume move is the install boundary.
- `scanDownloads()` never deletes or creates download state. `cleanupStaleStaging()` is separate and called once at app boot.
- Only explicit Discard calls `SessionStorageAdapter.clearSession()`.
- HPA-2 mobile code never calls `SessionStorageAdapter.loadSession()`; use `peekSession()` because `loadSession()` deletes invalid saves.
- Progress is four-state: `none | resumable | present | invalid`. Valid non-resumable files must not collapse to `none`.
- Fresh Start is available only from `none`; `present`/`invalid` require explicit Discard first.
- Downloaded server puzzles stay `SessionPuzzleSpec.source = 'api'`.
- Keep HPA-1 board/layout behavior. HPA-3 owns production gameplay parity.
- Delete HPA-1 fixture code/assets after dynamic downloaded assets work; no compatibility path.
- Remote/TestFlight API bases use HTTPS. Local iOS development uses narrow local-network plist declarations; never set `NSAllowsArbitraryLoads`.
- Native JSON transport is gated in Task 1; binary `toFile` and directory move are gated in Task 3 before Gallery/Downloaded integration.

---

### Task 1: Shared puzzle-detail validation + NativeScript JSON gate

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
- Temporary probe only, reverted before commit: `apps/mobile/app/App.svelte`

**Produces:**

```ts
// @perseus/types
export interface ReadyPuzzleDetail extends ReadyPuzzle {
	hasReference: boolean;
}

// apps/mobile/app/api/puzzleApi.ts
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
```

- [ ] **Step 1: Add the shared ready-detail wire type**

Immediately after `ReadyPuzzle` in `packages/types/src/core.ts`:

```ts
export interface ReadyPuzzleDetail extends ReadyPuzzle {
	hasReference: boolean;
}
```

Do not migrate the web-local flat `Puzzle` presentation type in HPA-2.

- [ ] **Step 2: Add the mobile dependency and build-time API base**

Add `"@perseus/types": "workspace:*"` to `apps/mobile/package.json`, then:

```bash
bun install
```

Create `apps/mobile/types/globals.d.ts`:

```ts
declare const __PERSEUS_API_BASE__: string;
```

Extend the existing webpack configuration:

```js
const apiBase = process.env.PERSEUS_MOBILE_API_BASE ?? 'http://localhost:4690';

webpack.chainWebpack((config) => {
	config.plugin('DefinePlugin').tap((args) => {
		args[0].__PERSEUS_API_BASE__ = JSON.stringify(apiBase);
		return args;
	});
});
```

- [ ] **Step 3: Add narrow iOS local-network declarations**

Add to the root `<dict>` in `apps/mobile/App_Resources/iOS/Info.plist`:

```xml
<key>NSAppTransportSecurity</key>
<dict>
	<key>NSAllowsLocalNetworking</key>
	<true/>
</dict>
<key>NSLocalNetworkUsageDescription</key>
<string>Connect to a local Perseus development server.</string>
```

No arbitrary-load or insecure remote-domain exception.

- [ ] **Step 4: Write RED API tests**

Use a fully valid typed `ReadyPuzzleDetail` fixture with real `EdgeConfig` values and string `imagePath` fields. Cover:

```ts
it('propagates the existing cursor', async () => {
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
```

Also assert:

- malformed piece metadata that `validatePuzzleMetadata()` rejects => `invalid_puzzle_response`;
- valid non-ready metadata => `puzzle_not_ready`;
- missing/non-boolean `hasReference` => `invalid_puzzle_response`;
- detail ID mismatch => `invalid_puzzle_response`.

- [ ] **Step 5: Verify RED**

```bash
cd apps/mobile
bunx vitest run app/api/puzzleApi.test.ts
```

Expected: FAIL because `puzzleApi.ts` does not exist.

- [ ] **Step 6: Implement `PuzzleApi.getPuzzle()` using the shared validator**

```ts
async function getPuzzle(puzzleId: string): Promise<ReadyPuzzleDetail> {
	const value = await options.requestJson(
		`${baseUrl}/api/puzzles/${encodeURIComponent(puzzleId)}`
	);
	if (!validatePuzzleMetadata(value)) throw new Error('invalid_puzzle_response');
	if (value.status !== 'ready') throw new Error('puzzle_not_ready');

	const record = value as unknown as Record<string, unknown>;
	if (value.id !== puzzleId || typeof record.hasReference !== 'boolean') {
		throw new Error('invalid_puzzle_response');
	}
	return value as ReadyPuzzleDetail;
}
```

`listPuzzles()` validates only the existing list envelope used by mobile. URL helpers copy the endpoint pattern from the web client; do not import the SvelteKit web service.

- [ ] **Step 7: Implement NativeScript JSON transport**

```ts
import { Http } from '@nativescript/core';

export const nativePuzzleJsonRequest: PuzzleJsonRequest = async (url) => {
	const response = await Http.request({ url, method: 'GET' });
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(`puzzle_api_http_${response.statusCode}`);
	}
	if (!response.content) throw new Error('puzzle_api_empty_response');
	return response.content.toJSON();
};
```

- [ ] **Step 8: Run unit/type checks**

```bash
bun run --cwd packages/types test:unit
cd apps/mobile
bunx vitest run app/api/puzzleApi.test.ts
bun run test:unit
cd ../..
bunx tsc --project apps/mobile/tsconfig.json --noEmit
```

Expected: PASS.

- [ ] **Step 9: Native Gate A — real JSON GET before Task 2**

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

Pass: `HPA2_JSON_PROBE` contains the real list response and no iOS transport/local-network error.

Revert the probe before commit:

```bash
git checkout -- apps/mobile/app/App.svelte
rg "HPA2_JSON_PROBE" apps/mobile/app/App.svelte
```

Expected: no match. If the gate fails, stop HPA-2 before Task 2.

- [ ] **Step 10: Commit**

```bash
git add packages/types/src/core.ts apps/mobile/package.json bun.lock \
	apps/mobile/webpack.config.js apps/mobile/App_Resources/iOS/Info.plist \
	apps/mobile/types/globals.d.ts apps/mobile/app/api
git commit -m "feat(mobile): add validated public puzzle API client"
```

---

### Task 2: Versioned local download manifest

**Files:**
- Create: `apps/mobile/app/library/downloadManifest.ts`
- Create: `apps/mobile/app/library/downloadManifest.test.ts`

**Produces:**

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

export function createDownloadManifest(
	puzzle: ReadyPuzzleDetail,
	files: DownloadedAssetFiles,
	downloadedAt: number
): DownloadManifestV1;

export function parseDownloadManifest(value: unknown): DownloadManifestV1;
export function sessionSpecFromManifest(manifest: DownloadManifestV1): SessionPuzzleSpec;
```

- [ ] **Step 1: Write RED manifest tests**

Assert the manifest omits `imagePath`, `edges`, server `status/version`, and projects:

```ts
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

Reject schema v2, non-positive dimensions, bad grid math, duplicate/missing IDs, duplicate/out-of-bounds cells, incomplete piece-file mapping, and unsafe paths (`/x`, `../x`, backslashes, `pieces/../x`).

- [ ] **Step 2: Verify RED**

```bash
cd apps/mobile
bunx vitest run app/library/downloadManifest.test.ts
```

- [ ] **Step 3: Implement the disk contract**

Use a local safe-relative-path predicate and require IDs exactly `0..pieceCount - 1`, one unique in-bounds cell per piece, and exact piece-file keys. `createDownloadManifest()` immediately re-parses its constructed value.

Do not persist remote asset paths or server-only fields.

- [ ] **Step 4: Implement `SessionPuzzleSpec` projection**

```ts
return {
	puzzleId: manifest.puzzleId,
	source: 'api',
	pieceCount: manifest.pieceCount,
	gridCols: manifest.gridCols,
	gridRows: manifest.gridRows,
	pieces: manifest.pieces.map(({ id, correctX, correctY }) => ({ id, correctX, correctY }))
};
```

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

### Task 3: Atomic store, read-only scan, startup cleanup, native binary/move gate

**Files:**
- Create: `apps/mobile/app/library/downloadStore.ts`
- Create: `apps/mobile/app/library/downloadStore.test.ts`
- Create: `apps/mobile/app/library/nativeDownloadFiles.ts`
- Temporary probe only, reverted before commit: `apps/mobile/app/App.svelte`

**Produces:**

```ts
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

`DownloadFileOps` contains only concrete join/ensure/exist/remove/move/read/write/list/fileSize operations. `AssetDownloader` returns `{ extension: '.png' | '.jpg' | '.webp'; bytes: number }`.

- [ ] **Step 1: RED — concurrency/finalization/failure tests**

With a 12+ piece fake, hold promises until five workers are active. Assert `maxActive === 5` and never exceeds 5.

Pin operation order:

```ts
expect(lastAssetOperation).toBeLessThan(manifestWriteOperation);
expect(manifestWriteOperation).toBeLessThan(finalMoveOperation);
```

For an asset failure, keep another request in flight after the first rejection and assert staging removal happens only after that second promise settles. Also cover cancel, zero-byte file, and failed move.

- [ ] **Step 2: RED — scan/cleanup separation**

Seed `.staging/in-progress` plus finalized packages:

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
- missing/empty referenced asset => corrupt;
- folder/manifest ID mismatch => corrupt;
- Remove Download touches only finalized package.

- [ ] **Step 3: Verify RED**

```bash
cd apps/mobile
bunx vitest run app/library/downloadStore.test.ts
```

- [ ] **Step 4: Implement the five-worker scheduler**

Use worker loops with one `stopped` flag and `firstError`; after error/cancel, schedule no new item but `await Promise.all(workers)` so already-started writes settle before cleanup.

- [ ] **Step 5: Implement `downloadPuzzle()`**

Sequence:

1. validate safe puzzle-ID segment;
2. reject existing finalized package;
3. remove stale staging for **this same ID only** and create `.staging/<id>/pieces`;
4. schedule thumbnail + optional reference + all pieces;
5. wait for five-worker scheduler;
6. verify every expected file is non-empty;
7. create/validate manifest;
8. write `manifest.json` last;
9. move `.staging/<id>` to finalized `<id>`;
10. return absolute installed paths.

In `finally`, clean only this job's staging when not finalized.

- [ ] **Step 6: Implement separate cleanup and read-only scan**

`cleanupStaleStaging()` removes direct child directories only under `.staging` and returns when `.staging` is absent.

`scanDownloads()`:

- returns `[]` if downloads root is absent;
- never calls `ensureDir`, `removeDir`, or cleanup;
- skips `.staging`;
- validates each finalized manifest/assets independently;
- returns corrupt rows instead of aborting the whole scan.

- [ ] **Step 7: Implement native asset download and same-volume move**

`downloadNativeAsset()` uses `Http.request()`, validates 2xx, maps Content-Type only for PNG/JPEG/WebP, calls `response.content.toFile(destinationBasePath + extension)`, and requires non-zero file size.

For iOS `moveDir()`, try the direct bridge then equivalent URL bridge:

```ts
try {
	const moved = NSFileManager.defaultManager.moveItemAtPathToPathError(fromPath, toPath, null);
	if (moved && Folder.exists(toPath)) return;
} catch {
	// Try equivalent URL bridge.
}

const moved = NSFileManager.defaultManager.moveItemAtURLToURLError(
	NSURL.fileURLWithPath(fromPath),
	NSURL.fileURLWithPath(toPath),
	null
);
if (!moved || !Folder.exists(toPath)) throw new Error('download_directory_move_failed');
```

Android uses same-volume `java.io.File.renameTo()`. No copy/delete install fallback.

- [ ] **Step 8: Unit/type GREEN**

```bash
cd apps/mobile
bunx vitest run app/library/downloadStore.test.ts
bun run test:unit
cd ../..
bunx tsc --project apps/mobile/tsconfig.json --noEmit
```

- [ ] **Step 9: Native Gate B — real image `toFile` + directory move**

Temporarily add an `onMount` probe to `App.svelte` that:

1. creates `PuzzleApi`;
2. finds one ready puzzle;
3. downloads its thumbnail with `downloadNativeAsset()` into `Documents/perseus/hpa2-native-probe/staging`;
4. writes `sentinel.txt` there;
5. calls the real `moveDir(staging, finalized)`;
6. verifies thumbnail bytes > 0 and sentinel at destination;
7. logs `HPA2_FILE_PROBE`;
8. deletes the probe root.

Run:

```bash
cd apps/mobile
PERSEUS_MOBILE_API_BASE=http://localhost:4690 ns run ios --no-hmr
```

Revert temporary `App.svelte` changes and require:

```bash
rg "HPA2_FILE_PROBE|hpa2-native-probe" apps/mobile/app/App.svelte
```

Expected: no matches.

If both iOS move bridge forms fail, stop here and revise finalization before Task 4. Do not continue with an unproven or non-atomic install path.

- [ ] **Step 10: Commit**

```bash
git add apps/mobile/app/library/downloadStore.ts \
	apps/mobile/app/library/downloadStore.test.ts \
	apps/mobile/app/library/nativeDownloadFiles.ts
git commit -m "feat(mobile): add atomic puzzle downloads"
```

---

### Task 4: Four-arm progress state with non-destructive reads

**Files:**
- Create: `apps/mobile/app/library/downloadedLibrary.ts`
- Create: `apps/mobile/app/library/downloadedLibrary.test.ts`

**Produces:**

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
```

- [ ] **Step 1: RED — real-codec state matrix**

Use `createSessionStorageAdapter()` over an in-memory store and real `PuzzleSession` snapshots. Assert:

- no file => `none`;
- active + real user activity => `resumable`;
- completed valid snapshot => `present`;
- valid loaded but no resumable activity => `present`;
- same ID with changed canonical coordinates => `invalid/cross_field_violation`.

The completed case must be produced by starting and correctly placing every piece, then serializing the real session.

- [ ] **Step 2: Verify RED**

```bash
cd apps/mobile
bunx vitest run app/library/downloadedLibrary.test.ts
```

- [ ] **Step 3: Implement `buildDownloadedRows()` with `peekSession()` only**

```ts
const result = storage.peekSession(install.manifest.puzzleId, context);
if (result.status === 'missing') return { install, progress: { kind: 'none' } };
if (result.status === 'invalid') {
	return { install, progress: { kind: 'invalid', reason: result.reason } };
}
if (storage.isResumable(result.snapshot)) {
	return { install, progress: { kind: 'resumable' } };
}
return { install, progress: { kind: 'present' } };
```

No `loadSession()`.

- [ ] **Step 4: Prove Remove Download / re-download independence**

Save resumable progress, remove finalized download via Task 3 fake, assert the session key remains, seed a matching package again, and assert the row returns to `resumable`.

- [ ] **Step 5: GREEN + commit**

```bash
cd apps/mobile
bunx vitest run app/library/downloadedLibrary.test.ts
bun run test:unit
cd ../..
git add apps/mobile/app/library/downloadedLibrary.ts apps/mobile/app/library/downloadedLibrary.test.ts
git commit -m "feat(mobile): derive downloaded progress state"
```

---

### Task 5: App composition + Gallery/Downloaded UI

**Files:**
- Modify: `apps/mobile/app/App.svelte`
- Modify: `apps/mobile/app/app.css`
- Create: `apps/mobile/app/library/Library.svelte`
- Create: `apps/mobile/app/library/Gallery.svelte`
- Create: `apps/mobile/app/library/Downloaded.svelte`

**App screen state:**

```ts
type MobileScreen =
	| { kind: 'library' }
	| { kind: 'gameplay'; launch: GameplayLaunch };
```

- [ ] **Step 1: Construct concrete services in `App.svelte`**

Reuse HPA-1 sessions root and adapter; create `PuzzleApi` and `DownloadStore` using `__PERSEUS_API_BASE__`, `nativePuzzleJsonRequest`, and native download file ops. No context/DI/global store.

- [ ] **Step 2: Make stale-staging cleanup truly application-startup-only**

Do **not** put cleanup in `Library.svelte`; that component remounts after gameplay.

In `App.svelte`:

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

Render `Library` only after `bootReady`; optionally show `bootError` as non-blocking copy. This call executes once for the app root, not on Library remounts or refreshes.

- [ ] **Step 3: `Library.svelte` mount does only safe reads/network load**

```ts
onMount(() => {
	void Promise.all([refreshDownloads(), loadGallery(false)]);
});
```

`refreshDownloads()` calls only `scanDownloads()` + `buildDownloadedRows()`.

- [ ] **Step 4: Implement Gallery presentation**

Show server thumbnail/name/piece count and Download/Downloaded/Downloading state. Keep cursor Load More only; no search/category work.

Compute installed IDs from **all finalized scan entries**, including corrupt rows, so Gallery cannot download over an existing corrupt final directory.

- [ ] **Step 5: Implement Downloaded state actions**

- `none` => **START**, **REMOVE DOWNLOAD**.
- `resumable` => **RESUME**, **DISCARD PROGRESS**, **REMOVE DOWNLOAD**.
- `present` => **DISCARD PROGRESS**, **REMOVE DOWNLOAD**; no Start/Resume.
- `invalid` => **DISCARD PROGRESS**, **REMOVE DOWNLOAD**; no Start/Resume.
- corrupt => **REMOVE & DOWNLOAD AGAIN**, **REMOVE DOWNLOAD**; never launch.

After Discard refreshes the rows, `present`/`invalid` becomes `none` and Start appears.

- [ ] **Step 6: Keep one active download local to Library without creating an orphan job**

State:

```ts
let downloadingPuzzleId: string | null = null;
let cancellation: DownloadCancellation | null = null;
```

The download handler fetches validated detail, calls `downloadPuzzle()`, then read-only refreshes.

While `downloadingPuzzleId !== null`:

- disable every other Download button;
- disable **START**/**RESUME** so navigating to gameplay cannot destroy `Library.svelte` while its job is still in flight;
- keep **CANCEL DOWNLOAD** available.

This preserves “one puzzle at a time” without moving job state into a global/download manager.

- [ ] **Step 7: Implement independent mutation handlers**

```ts
async function discardProgress(id: string) {
	sessionStorage.clearSession(id);
	await refreshDownloads();
}

async function removeDownload(id: string) {
	await downloadStore.removeDownload(id);
	await refreshDownloads();
}
```

`removeAndDownloadAgain` removes the corrupt package, refreshes, then calls the normal validated download path. No repair flow.

Manual/tab refresh is allowed during active download because scan is read-only.

- [ ] **Step 8: Screen handoff**

Launch only:

```ts
{ install, mode: 'start' }
```

from a `none` row, or:

```ts
{ install, mode: 'resume' }
```

from a `resumable` row.

- [ ] **Step 9: Checks + commit**

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

### Task 6: Dynamic downloaded gameplay + peek-only resume + fixture deletion

**Files:**
- Modify: `apps/mobile/app/gameplay/Gameplay.svelte`
- Modify: `apps/mobile/app/gameplay/PuzzleCanvas.svelte`
- Delete: `apps/mobile/app/gameplay/fixture.ts`
- Delete: `apps/mobile/app/assets/hpa-1/piece-0.png`
- Delete: `apps/mobile/app/assets/hpa-1/piece-1.png`
- Delete: `apps/mobile/app/assets/hpa-1/piece-2.png`
- Delete: `apps/mobile/app/assets/hpa-1/piece-3.png`

**Gameplay props:**

```ts
export let launch: GameplayLaunch;
export let storage: SessionStorageAdapter;
export let onExit: () => void;
```

- [ ] **Step 1: Load Canvas images from installed piece paths**

`PuzzleCanvas.svelte` gains `piecePaths: Record<number, string>` and loads `ImageAsset` from each absolute installed path. Delete fixed `PIECE_IDS` and bundled fixture path usage.

Keep board view model, density conversion, tap/drag, and fit math unchanged.

- [ ] **Step 2: Use one non-destructive persisted read at gameplay entry**

```ts
const spec = sessionSpecFromManifest(launch.install.manifest);
const context = validationContextFrom(spec);
const persisted = storage.peekSession(spec.puzzleId, context);
```

Resume is allowed only when `persisted.status === 'loaded'` and `storage.isResumable(persisted.snapshot)`.

Start is allowed only when `persisted.status === 'missing'`.

If either launch became stale/unavailable, show **BACK TO LIBRARY** without creating a fresh session or deleting/overwriting the file.

Never call `loadSession()`.

- [ ] **Step 3: Construct the real dynamic session**

Use the manifest-derived spec, HPA-1 clock/run-ID helpers, restored snapshot only for Resume, piece IDs as initial/restart tray order, and existing zero-rotation generator. Persist under `spec.puzzleId`.

- [ ] **Step 4: Preserve HPA-1 lifecycle persistence**

Keep suspend/resume/exit checkpoint behavior with nullable session guards. `leaveGameplay()` checkpoints then calls `onExit()`.

- [ ] **Step 5: Pass local piece paths**

```svelte
<PuzzleCanvas
	{sessionState}
	piecePaths={launch.install.piecePaths}
	onSelectPiece={selectPiece}
	onAttemptPlacement={attemptPlacement}
/>
```

Use manifest name and dynamic piece count. Add only a **LIBRARY** exit action; no HPA-3 toolbar/tray work.

- [ ] **Step 6: Delete fixture and fence destructive reads**

```bash
rg "HPA1_FIXTURE|assets/hpa-1|PIECE_IDS|HPA-1 Offline" apps/mobile
rg "\.loadSession\(" apps/mobile/app
```

Expected: no matches.

- [ ] **Step 7: Checks + commit**

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

### Task 7: Final native acceptance in the same implementation PR

**Files:**
- No new production file is planned.
- If smoke exposes a real defect, fix the owning Task 1-6 file before recording evidence; Task 7 does not prohibit production corrections.
- Update the same HPA-2 implementation PR body with evidence.

- [ ] **Step 1: Repository gates**

```bash
bun run --cwd packages/types test:unit
bun run --cwd apps/mobile test:unit
bunx tsc --project apps/mobile/tsconfig.json --noEmit
bunx prettier --check apps/mobile/app apps/mobile/types apps/mobile/webpack.config.js apps/mobile/package.json
bun run check
bun run lint
```

- [ ] **Step 2: Launch against a reachable API**

Simulator/local:

```bash
bun run dev --filter=@perseus/api
cd apps/mobile
PERSEUS_MOBILE_API_BASE=http://localhost:4690 ns run ios --no-hmr
```

Physical/TestFlight-like verification uses a reachable HTTPS API unless intentionally testing local-network development.

Record NativeScript, core/canvas, Xcode, device/simulator, and iOS versions.

- [ ] **Step 3: Finalization + relaunch discovery**

Download one ready puzzle and verify finalized manifest/thumbnail/piece files, no same-ID staging residue, and relaunch reconstructs Downloaded from disk without a network re-download.

- [ ] **Step 4: Read-only refresh during active download**

During a large download, refresh Downloaded. Verify active `.staging/<id>` remains and the job continues/finalizes. This is the integration fence for the split scan/cleanup API.

- [ ] **Step 5: Offline start/resume**

Disable networking after finalization, Start from `none`, place at least one piece, terminate/relaunch, verify Resume appears from disk, and restore the same placement/counters.

- [ ] **Step 6: Completed/non-resumable save is not `none`**

Complete a small downloaded puzzle, return to Downloaded, and verify:

- no **START** while the valid completed session exists;
- **DISCARD PROGRESS** exists;
- after explicit discard, **START** appears.

- [ ] **Step 7: Remove Download preserves progress**

With resumable progress, remove assets, verify session JSON remains, re-download the same ID, verify Resume returns, and resume retained placement.

- [ ] **Step 8: Corrupt package**

Delete one finalized piece, refresh/relaunch, verify no Start/Resume, use Remove & Download Again, and confirm install returns only after normal finalization.

- [ ] **Step 9: Final scope fences**

```bash
git diff --name-only main...HEAD
rg "HPA1_FIXTURE|assets/hpa-1|downloads\.json" apps/mobile
rg "\.loadSession\(" apps/mobile/app
```

Expected:

- no fixture/index/destructive mobile-load matches;
- no `apps/api`, `apps/workflows`, database, infrastructure, or `packages/game-core` production diff;
- `packages/types/src/core.ts` change is limited to `ReadyPuzzleDetail`;
- intended mobile API/library/gameplay/config/plist/lockfile changes plus fixture deletion only.

- [ ] **Step 10: Update the implementation PR body**

Record Task 1 JSON gate, Task 3 binary/move gate, test/type/lint results, and final offline/relaunch/remove/re-download/corruption evidence. No second HPA-2 PR.

## Risk / Gate Summary

1. **Native JSON + local networking:** Task 1 real-device/simulator gate before manifest/store work.
2. **Binary `toFile`:** Task 3 real thumbnail gate before UI.
3. **Directory move:** Task 3 probes path and URL `NSFileManager` move bridges; both failing stops the design rather than introducing silent copy/delete install semantics.
4. **Staging cleanup race:** cleanup is one-shot at `App.svelte` boot; `scanDownloads()` is always read-only.
5. **Orphan download job:** Start/Resume is disabled while the Library-owned download job is active, so navigation cannot destroy the job owner.
6. **Invalid-save deletion:** library/gameplay use `peekSession()` only; `.loadSession(` is fenced out of mobile app code.
7. **Completed-save overwrite:** valid non-resumable snapshots are `present`; fresh Start requires explicit discard first.

## Self-Review Results

- **Spec coverage:** existing API, shared validation, native gates, atomic download, bounded concurrency, cancellation/failure cleanup, one-shot stale cleanup, read-only discovery, four progress states, offline start/resume, asset/progress independence, re-download validation, corrupt-package recovery, and native iPad proof are all assigned.
- **Scope:** no API route, Workflow, DB, game-core, SQLite/index, ZIP, auth/sync, portrait, or HPA-3 gameplay expansion.
- **Ownership:** DownloadStore has no session dependency; only Discard clears sessions; Library owns one active job only while mounted.
- **Atomicity:** in-flight writes settle before cleanup; assets verify before manifest; manifest precedes same-volume move.
- **No placeholders:** file ownership, interfaces, native gates, failure ordering, commands, and stop conditions are explicit.