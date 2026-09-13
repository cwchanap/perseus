<script lang="ts">
	import type { PuzzleFamilySummary } from '@perseus/types';
	import FamilyCard from './FamilyCard.svelte';
	import type { DownloadJobView } from './familyGallery';

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
	export let bookmarkedIds: ReadonlySet<string> = new Set();
	export let bookmarkPendingIds: readonly string[] = [];
	export let onBookmarkToggle: ((family: PuzzleFamilySummary) => void) | undefined = undefined;
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
			bookmarked={bookmarkedIds.has(family.id)}
			bookmarkPending={bookmarkPendingIds.includes(family.id)}
			{onBookmarkToggle}
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
