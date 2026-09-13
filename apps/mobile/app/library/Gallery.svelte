<script lang="ts">
	import type { PuzzleFamilySummary } from '@perseus/types';
	import FamilyCard from './FamilyCard.svelte';

	type DownloadJobView = {
		puzzleId: string;
		done: number;
		total: number;
	};

	export let families: readonly PuzzleFamilySummary[] = [];
	export let installedIds: ReadonlySet<string> = new Set();
	export let downloadJob: DownloadJobView | null = null;
	export let familyThumbnailUrl: (familyId: string) => string;
	export let onDownload: (puzzleId: string) => void;
	export let onLoadMore: () => void;
	export let onCancelDownload: () => void;
	export let loading = false;
	export let hasMore = false;
	export let error: string | null = null;
</script>

<stackLayout class="library-section">
	<label text="GALLERY" class="library-section-title" />

	{#if error}
		<label text={`GALLERY ERROR: ${error}`} class="library-error" textWrap="true" />
	{/if}

	{#if loading && families.length === 0}
		<activityIndicator busy={true} class="library-loading" />
	{:else if families.length === 0}
		<label text="No puzzles available." class="library-empty" />
	{/if}

	{#each families as family (family.id)}
		<FamilyCard
			{family}
			{installedIds}
			{downloadJob}
			{familyThumbnailUrl}
			{onDownload}
			{onCancelDownload}
		/>
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
