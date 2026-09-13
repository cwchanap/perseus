<script lang="ts">
	import type { PuzzleFamilySummary } from '@perseus/types';
	import { GALLERY_DIFFICULTIES, getDifficultyLabel, selectVariantId } from './familyGallery';

	type DownloadJobView = {
		puzzleId: string;
		done: number;
		total: number;
	};

	export let family: PuzzleFamilySummary;
	export let installedIds: ReadonlySet<string> = new Set();
	export let downloadJob: DownloadJobView | null = null;
	export let familyThumbnailUrl: (familyId: string) => string;
	export let onDownload: (puzzleId: string) => void;
	export let onCancelDownload: () => void;
	export let bookmarked = false;
	export let bookmarkPending = false;
	export let onBookmarkToggle: ((family: PuzzleFamilySummary) => void) | undefined = undefined;

	function progressText(): string {
		return downloadJob && downloadJob.total > 0
			? `DOWNLOADING ${downloadJob.done}/${downloadJob.total}`
			: 'DOWNLOADING…';
	}

	function variantActive(variantId: string): boolean {
		return downloadJob?.puzzleId === variantId;
	}
</script>

<gridLayout columns="112,*" class="library-card">
	<image
		col="0"
		src={familyThumbnailUrl(family.id)}
		width="104"
		height="104"
		stretch="aspectFill"
		class="library-thumbnail"
	/>
	<stackLayout col="1" class="library-card-copy">
		<gridLayout columns="*,auto">
			<label text={family.name} class="library-card-title" textWrap="true" />
			{#if onBookmarkToggle}
				<button
					col="1"
					text={bookmarked ? 'UNBOOKMARK' : 'BOOKMARK'}
					class="library-button"
					isEnabled={!bookmarkPending}
					on:tap={() => onBookmarkToggle?.(family)}
				/>
			{/if}
		</gridLayout>
		{#each GALLERY_DIFFICULTIES as difficulty (difficulty)}
			{@const variant = family.variants[difficulty]}
			{@const variantId = selectVariantId(family, difficulty)}
			{@const active = variantActive(variantId)}
			<gridLayout columns="*,auto" class="library-difficulty-row">
				<stackLayout col="0">
					<label
						text={`${getDifficultyLabel(difficulty)} · ${variant.pieceCount} PIECES`}
						class="library-card-detail"
					/>
					{#if active}
						<label text={progressText()} class="library-progress" />
					{:else if installedIds.has(variantId)}
						<label text="DOWNLOADED" class="library-card-detail" />
					{/if}
				</stackLayout>
				<stackLayout col="1" class="library-card-actions">
					{#if active}
						<button text="CANCEL" class="library-button" on:tap={onCancelDownload} />
					{:else if installedIds.has(variantId)}
						<label text="INSTALLED" class="library-card-detail" textAlignment="center" />
					{:else if variant.status === 'ready'}
						<button
							text="DOWNLOAD"
							class="library-button"
							isEnabled={downloadJob === null}
							on:tap={() => onDownload(variantId)}
						/>
					{:else}
						<label text="UNAVAILABLE" class="library-card-detail" textAlignment="center" />
					{/if}
				</stackLayout>
			</gridLayout>
		{/each}
	</stackLayout>
</gridLayout>
