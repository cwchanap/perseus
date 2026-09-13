<script lang="ts">
	import type { PuzzleFamilySummary } from '@perseus/types';
	import FamilyCard from './FamilyCard.svelte';

	type DownloadJobView = {
		puzzleId: string;
		done: number;
		total: number;
	};

	export let families: readonly PuzzleFamilySummary[] = [];
	export let signedIn = false;
	export let loading = false;
	export let error: string | null = null;
	export let pendingIds: readonly string[] = [];
	export let installedIds: ReadonlySet<string> = new Set();
	export let downloadJob: DownloadJobView | null = null;
	export let familyThumbnailUrl: (familyId: string) => string;
	export let onDownload: (puzzleId: string) => void;
	export let onCancelDownload: () => void;
	export let onBookmarkToggle: ((family: PuzzleFamilySummary) => void) | undefined = undefined;
</script>

<stackLayout class="library-section">
	<label text="BOOKMARKS" class="library-section-title" />

	{#if error}
		<label text={`BOOKMARKS ERROR: ${error}`} class="library-error" textWrap="true" />
	{/if}

	{#if !signedIn}
		<label text="Sign in below to use bookmarks." class="library-empty" />
	{:else if loading && families.length === 0}
		<activityIndicator busy={true} class="library-loading" />
	{:else if families.length === 0}
		<label text="No bookmarked puzzles yet." class="library-empty" />
	{:else}
		{#each families as family (family.id)}
			<FamilyCard
				{family}
				{installedIds}
				{downloadJob}
				{familyThumbnailUrl}
				{onDownload}
				{onCancelDownload}
				bookmarked={true}
				bookmarkPending={pendingIds.includes(family.id)}
				{onBookmarkToggle}
			/>
		{/each}
	{/if}
</stackLayout>
