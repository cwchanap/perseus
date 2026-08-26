<script lang="ts">
	import { onMount } from 'svelte';
	import { Folder, knownFolders, path } from '@nativescript/core';
	import { createSessionStorageAdapter, type SessionStorageAdapter } from '@perseus/game-core';
	import { nativePuzzleJsonRequest } from './api/nativePuzzleHttp';
	import { createPuzzleApi } from './api/puzzleApi';
	import Gameplay from './gameplay/Gameplay.svelte';
	import { createNativeSessionFileOps } from './gameplay/sessionFiles';
	import { createFileSessionKeyValueStore } from './gameplay/sessionStore';
	import Library from './library/Library.svelte';
	import {
		createDownloadStore,
		type DownloadCancellation,
		type DownloadStore
	} from './library/downloadStore';
	import { downloadNativeAsset, createNativeDownloadFileOps } from './library/nativeDownloadFiles';
	import type { GameplayLaunch } from './library/downloadedLibrary';

	type MobileScreen = { kind: 'library' } | { kind: 'gameplay'; launch: GameplayLaunch };

	interface ActiveDownloadJob {
		puzzleId: string;
		cancellation: DownloadCancellation;
		done: number;
		total: number;
	}

	const perseusRoot = path.join(knownFolders.documents().path, 'perseus');
	const sessionsRoot = path.join(perseusRoot, 'sessions');
	const downloadsRoot = path.join(perseusRoot, 'downloads');

	Folder.fromPath(sessionsRoot);
	if (!Folder.exists(sessionsRoot)) {
		knownFolders.documents().getFolder('perseus').getFolder('sessions');
	}

	const sessionStorage: SessionStorageAdapter = createSessionStorageAdapter({
		store: createFileSessionKeyValueStore({
			rootPath: sessionsRoot,
			fileOps: createNativeSessionFileOps()
		})
	});

	const puzzleApi = createPuzzleApi({
		baseUrl: __PERSEUS_API_BASE__,
		requestJson: nativePuzzleJsonRequest
	});

	const downloadStore: DownloadStore = createDownloadStore({
		rootPath: downloadsRoot,
		fileOps: createNativeDownloadFileOps(),
		downloadAsset: downloadNativeAsset,
		assetUrls: puzzleApi,
		now: () => Date.now()
	});

	let screen: MobileScreen = { kind: 'library' };
	let bootReady = false;
	let bootError: string | null = null;
	let downloadJob: ActiveDownloadJob | null = null;
	let downloadRevision = 0;
	let downloadError: string | null = null;

	onMount(async () => {
		try {
			await downloadStore.cleanupStaleStaging();
		} catch (error) {
			bootError = error instanceof Error ? error.message : 'staging_cleanup_failed';
		} finally {
			bootReady = true;
		}
	});

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
</script>

<frame>
	<page actionBarHidden="true" backgroundColor="#111820">
		{#if !bootReady}
			<stackLayout>
				<activityIndicator busy={true} />
				<label text="Preparing offline library…" color="#f7fafc" textAlignment="center" />
			</stackLayout>
		{:else if bootError}
			<stackLayout>
				<label text="Unable to prepare offline library." color="#f7fafc" textWrap="true" />
				<label text={bootError} color="#f6e05e" textWrap="true" />
			</stackLayout>
		{:else if screen.kind === 'library'}
			<Library
				{puzzleApi}
				{downloadStore}
				{sessionStorage}
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
	</page>
</frame>
