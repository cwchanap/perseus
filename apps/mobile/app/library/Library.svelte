<script lang="ts">
	import { onMount } from 'svelte';
	import type { SessionStorageAdapter } from '@perseus/game-core';
	import type { PuzzleSummary } from '@perseus/types';
	import type { PuzzleApi } from '../api/puzzleApi';
	import Downloaded from './Downloaded.svelte';
	import {
		buildDownloadedRows,
		type DownloadedPuzzleRow,
		type GameplayLaunch
	} from './downloadedLibrary';
	import type {
		CorruptDownload,
		DownloadScanEntry,
		DownloadStore,
		InstalledDownload
	} from './downloadStore';
	import Gallery from './Gallery.svelte';

	type DownloadJobView = {
		puzzleId: string;
		done: number;
		total: number;
	};

	export let puzzleApi: PuzzleApi;
	export let downloadStore: DownloadStore;
	export let sessionStorage: SessionStorageAdapter;
	export let downloadJob: DownloadJobView | null;
	export let downloadRevision: number;
	export let downloadError: string | null;
	export let onDownload: (puzzleId: string) => void;
	export let onCancelDownload: () => void;
	export let onLaunch: (launch: GameplayLaunch) => void;

	let galleryRows: PuzzleSummary[] = [];
	let galleryCursor: string | undefined;
	let galleryLoading = false;
	let galleryError: string | null = null;
	let downloadedEntries: DownloadScanEntry[] = [];
	let downloadedRows: DownloadedPuzzleRow[] = [];
	let downloadedError: string | null = null;
	let installedIds = new Set<string>();
	let corruptRows: CorruptDownload[] = [];
	let observedDownloadRevision = downloadRevision;

	async function refreshDownloads(): Promise<void> {
		try {
			const entries = await downloadStore.scanDownloads();
			const installed = entries.filter(
				(entry): entry is InstalledDownload => entry.kind === 'installed'
			);
			downloadedEntries = entries;
			downloadedRows = buildDownloadedRows(installed, sessionStorage);
			downloadedError = null;
		} catch (error) {
			downloadedError = error instanceof Error ? error.message : 'download_scan_failed';
		}
	}

	async function loadGallery(reset: boolean): Promise<void> {
		if (galleryLoading) return;
		if (reset) {
			galleryRows = [];
			galleryCursor = undefined;
		}
		galleryLoading = true;
		galleryError = null;
		try {
			const response = await puzzleApi.listPuzzles(reset ? undefined : galleryCursor);
			const ready = response.puzzles.filter((puzzle) => puzzle.status === 'ready');
			galleryRows = reset ? ready : [...galleryRows, ...ready];
			galleryCursor = response.nextCursor;
		} catch (error) {
			galleryError = error instanceof Error ? error.message : 'gallery_load_failed';
		} finally {
			galleryLoading = false;
		}
	}

	async function discardProgress(id: string): Promise<void> {
		sessionStorage.clearSession(id);
		await refreshDownloads();
	}

	async function removeDownload(id: string): Promise<void> {
		await downloadStore.removeDownload(id);
		await refreshDownloads();
	}

	async function removeAndDownloadAgain(id: string): Promise<void> {
		await downloadStore.removeDownload(id);
		await refreshDownloads();
		onDownload(id);
	}

	function loadMore(): void {
		void loadGallery(false);
	}

	$: if (downloadRevision !== observedDownloadRevision) {
		observedDownloadRevision = downloadRevision;
		void refreshDownloads();
	}

	$: installedIds = new Set(
		downloadedEntries.map((entry) =>
			entry.kind === 'installed' ? entry.manifest.puzzle.id : entry.puzzleId
		)
	);
	$: corruptRows = downloadedEntries.filter(
		(entry): entry is CorruptDownload => entry.kind === 'corrupt'
	);

	onMount(() => {
		void Promise.all([refreshDownloads(), loadGallery(false)]);
	});
</script>

<gridLayout rows="auto,*" backgroundColor="#111820" class="library-page">
	<label row="0" text="PERSEUS LIBRARY" class="library-title" />
	<scrollView row="1">
		<stackLayout>
			{#if downloadError}
				<label text={`DOWNLOAD ERROR: ${downloadError}`} class="library-error" textWrap="true" />
			{/if}
			{#if downloadedError}
				<label
					text={`DOWNLOADED ERROR: ${downloadedError}`}
					class="library-error"
					textWrap="true"
				/>
			{/if}
			<Gallery
				puzzles={galleryRows}
				{installedIds}
				{downloadJob}
				thumbnailUrl={puzzleApi.thumbnailUrl}
				{onDownload}
				onLoadMore={loadMore}
				{onCancelDownload}
				loading={galleryLoading}
				hasMore={galleryCursor !== undefined}
				error={galleryError}
			/>
			<Downloaded
				rows={downloadedRows}
				{corruptRows}
				{onLaunch}
				onDiscardProgress={discardProgress}
				onRemoveDownload={removeDownload}
				onRemoveAndDownloadAgain={removeAndDownloadAgain}
			/>
		</stackLayout>
	</scrollView>
</gridLayout>
