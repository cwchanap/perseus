<script lang="ts">
	import { resolve } from '$app/paths';
	import PuzzleCard from '$lib/components/PuzzleCard.svelte';
	import { playerAuth } from '$lib/stores/playerAuth';
	import { bookmarks } from '$lib/stores/bookmarks';

	// Auth is observed only to decide presentation; all bookmark
	// network/mutation logic lives in the store.
	const authenticated = $derived($playerAuth.status === 'authenticated');

	// Load bookmarks once the page renders for an authenticated player;
	// the store dedupes repeat loads.
	$effect(() => {
		if (authenticated) void bookmarks.load();
	});
</script>

<section class="mx-auto max-w-5xl px-4 py-8">
	<h1 class="font-(--font-display) text-(--text-0)">Bookmarks</h1>

	{#if $bookmarks.error && $bookmarks.status !== 'error'}
		<p
			role="alert"
			data-testid="bookmarks-mutation-error"
			class="mt-3 border border-(--hot) bg-(--bg-1) px-4 py-2 text-sm text-(--text-1)"
		>
			{$bookmarks.error}
		</p>
	{/if}

	{#if $playerAuth.status === 'loading'}
		<p data-testid="bookmarks-auth-loading" role="status" class="mt-3 text-(--text-2)">
			Checking session…
		</p>
	{:else if !authenticated}
		<p data-testid="bookmarks-sign-in" class="mt-3 text-(--text-2)">
			<a class="text-(--accent)" href={resolve('/login')}>Sign in</a> to see your bookmarked puzzles.
		</p>
	{:else if $bookmarks.status === 'loading' || $bookmarks.status === 'idle'}
		<p data-testid="bookmarks-loading" role="status" class="mt-3 text-(--text-2)">
			Loading bookmarks…
		</p>
	{:else if $bookmarks.status === 'error'}
		<p role="alert" data-testid="bookmarks-error" class="mt-3 text-(--text-1)">
			{$bookmarks.error ?? 'Failed to load bookmarks'}
		</p>
		<button
			type="button"
			data-testid="bookmarks-retry"
			class="mt-3 text-sm text-(--accent)"
			onclick={() => void bookmarks.load()}
		>
			Try again
		</button>
	{:else if $bookmarks.families.length === 0}
		<p data-testid="bookmarks-empty" class="mt-3 text-(--text-2)">
			No bookmarked puzzles yet. Tap the bookmark icon on any puzzle to save it here.
		</p>
	{:else}
		<div class="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3" data-testid="bookmarks-grid">
			{#each $bookmarks.families as family (family.id)}
				<PuzzleCard
					{family}
					bookmarked={$bookmarks.ids.includes(family.id)}
					bookmarkPending={$bookmarks.pendingIds.includes(family.id)}
					onBookmarkToggle={bookmarks.toggle}
				/>
			{/each}
		</div>
	{/if}
</section>

<svelte:head>
	<title>Bookmarks | Perseus</title>
</svelte:head>
