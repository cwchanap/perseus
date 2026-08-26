<script lang="ts">
	import type { PuzzleSummary } from '@perseus/types';

	type DownloadJobView = {
		puzzleId: string;
		done: number;
		total: number;
	};

	export let puzzles: readonly PuzzleSummary[] = [];
	export let installedIds: ReadonlySet<string> = new Set();
	export let downloadJob: DownloadJobView | null = null;
	export let thumbnailUrl: (puzzleId: string) => string;
	export let onDownload: (puzzleId: string) => void;
	export let onLoadMore: () => void;
	export let onCancelDownload: () => void;
	export let loading = false;
	export let hasMore = false;
	export let error: string | null = null;

	function progressText(): string {
		return downloadJob && downloadJob.total > 0
			? `DOWNLOADING ${downloadJob.done}/${downloadJob.total}`
			: 'DOWNLOADING…';
	}
</script>

<stackLayout class="library-section">
	<label text="GALLERY" class="library-section-title" />

	{#if error}
		<label text={`GALLERY ERROR: ${error}`} class="library-error" textWrap="true" />
	{/if}

	{#if loading && puzzles.length === 0}
		<activityIndicator busy={true} class="library-loading" />
	{:else if puzzles.length === 0}
		<label text="No puzzles available." class="library-empty" />
	{/if}

	{#each puzzles as puzzle (puzzle.id)}
		{@const active = downloadJob?.puzzleId === puzzle.id}
		<gridLayout columns="112,*,auto" class="library-card">
			<image
				col="0"
				src={thumbnailUrl(puzzle.id)}
				width="104"
				height="104"
				stretch="aspectFill"
				class="library-thumbnail"
			/>
			<stackLayout col="1" class="library-card-copy">
				<label text={puzzle.name} class="library-card-title" textWrap="true" />
				<label text={`${puzzle.pieceCount} PIECES`} class="library-card-detail" />
				{#if active}
					<label text={progressText()} class="library-progress" />
				{:else if installedIds.has(puzzle.id)}
					<label text="DOWNLOADED" class="library-card-detail" />
				{/if}
			</stackLayout>
			<stackLayout col="2" class="library-card-actions">
				{#if active}
					<button text="CANCEL" class="library-button" on:tap={onCancelDownload} />
				{:else if installedIds.has(puzzle.id)}
					<label text="INSTALLED" class="library-card-detail" textAlignment="center" />
				{:else}
					<button
						text="DOWNLOAD"
						class="library-button"
						isEnabled={downloadJob === null}
						on:tap={() => onDownload(puzzle.id)}
					/>
				{/if}
			</stackLayout>
		</gridLayout>
	{/each}

	{#if hasMore}
		<button
			text="LOAD MORE"
			class="library-button library-load-more"
			isEnabled={!loading}
			on:tap={onLoadMore}
		/>
	{/if}
</stackLayout>
