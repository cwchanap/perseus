<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		/** SVG path data (24×24 viewBox) for the icon tile. */
		icon: string;
		title: string;
		message: string;
		testId?: string;
		role?: 'status' | 'alert';
		/** Optional call-to-action, usually an `.arcade-btn` link or button. */
		children?: Snippet;
	}

	let { icon, title, message, testId, role, children }: Props = $props();
</script>

<div
	class="arcade-panel flex flex-col items-center gap-2.5 px-6 py-10 text-center"
	data-testid={testId}
	{role}
>
	<span
		class="grid h-14 w-14 place-items-center rounded-[18px] bg-(--bg-2) text-(--text-2)
		[box-shadow:0_0_0_1px_var(--border-bright)]"
		aria-hidden="true"
	>
		<svg viewBox="0 0 24 24" fill="currentColor" class="h-[26px] w-[26px]"><path d={icon} /></svg>
	</span>
	<p
		class="mt-1 font-(family-name:--font-display) text-[0.9rem] font-bold tracking-[0.12em] text-(--text-1) uppercase"
	>
		{title}
	</p>
	<p class="mb-1.5 text-base text-(--text-2)">{message}</p>
	{#if children}{@render children()}{/if}
</div>
