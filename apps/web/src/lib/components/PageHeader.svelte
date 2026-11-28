<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		kicker: string;
		title: string;
		subtitle?: string;
		titleTestId?: string;
		/** Rendered inline after the title, e.g. a count chip. */
		badge?: Snippet;
		/** Rendered on the right (wraps below on narrow screens). */
		actions?: Snippet;
	}

	let { kicker, title, subtitle, titleTestId, badge, actions }: Props = $props();
</script>

<header class="flex flex-wrap items-end justify-between gap-4 pt-1.5">
	<div class="min-w-0">
		<p class="arcade-kicker mb-1.5">{kicker}</p>
		<div class="flex flex-wrap items-center gap-3.5">
			<h1 class="arcade-page-title" data-testid={titleTestId}>{title}</h1>
			{#if badge}{@render badge()}{/if}
		</div>
		{#if subtitle}
			<p class="mt-1.5 text-[1.05rem] font-medium text-(--text-1)">{subtitle}</p>
		{/if}
	</div>
	{#if actions}
		<div class="flex items-center gap-2.5">{@render actions()}</div>
	{/if}
</header>
