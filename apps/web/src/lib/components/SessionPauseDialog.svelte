<script lang="ts">
	import { modalFocus } from '$lib/actions/modalFocus';
	import type { SessionMode } from '@perseus/game-core';

	interface Props {
		presentation: 'resume' | 'paused';
		mode: SessionMode;
		confirmingRestart: boolean;
		onResume: () => void;
		onRequestRestart: () => void;
		onConfirmRestart: () => void;
		onCancelRestart: () => void;
		onExit: () => void;
		onDiscard: () => void;
	}

	let {
		presentation,
		mode,
		confirmingRestart,
		onResume,
		onRequestRestart,
		onConfirmRestart,
		onCancelRestart,
		onExit,
		onDiscard
	}: Props = $props();

	const primaryButtonClass = 'arcade-btn';
	const secondaryButtonClass = 'arcade-btn-ghost';
	const destructiveButtonClass = 'arcade-btn-danger';
</script>

<div
	class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60"
	style="padding-top: max(1rem, env(safe-area-inset-top)); padding-right: max(1rem, env(safe-area-inset-right)); padding-bottom: max(1rem, env(safe-area-inset-bottom)); padding-left: max(1rem, env(safe-area-inset-left));"
>
	<div
		role="dialog"
		aria-modal="true"
		aria-label={presentation === 'resume' ? 'Resume Mission' : 'Mission Paused'}
		tabindex="-1"
		use:modalFocus={confirmingRestart}
		class="flex max-h-[100dvh] w-full max-w-md flex-col overflow-hidden border border-(--accent)
		bg-(--bg-1) [box-shadow:0_0_40px_var(--accent-glow)]"
	>
		<div class="min-h-0 flex-1 overflow-y-auto p-6">
			{#if confirmingRestart}
				<h2
					class="text-[0.95rem] font-(--font-display) font-bold tracking-[0.12em] text-(--text-0) uppercase"
				>
					Restart this mission?
				</h2>
				<p class="mt-2 text-[0.8rem] font-(--font-mono) tracking-[0.05em] text-(--text-2)">
					Current progress will be cleared and a new run will begin.
				</p>
				<div class="mt-6 flex flex-wrap justify-end gap-2">
					<button type="button" onclick={onCancelRestart} class={secondaryButtonClass}>
						Cancel
					</button>
					<button type="button" onclick={onConfirmRestart} class={primaryButtonClass}>
						Confirm restart
					</button>
				</div>
			{:else}
				<h2
					class="text-[0.95rem] font-(--font-display) font-bold tracking-[0.12em] text-(--text-0) uppercase"
				>
					{presentation === 'resume' ? 'Resume Mission' : 'Mission Paused'}
				</h2>
				<p class="mt-1 text-[0.8rem] font-(--font-mono) tracking-[0.05em] text-(--text-2)">
					{mode === 'timed' ? 'Timed' : 'Relaxed'} mission
				</p>
				<div class="mt-6 flex flex-wrap justify-end gap-2">
					<button type="button" onclick={onExit} class={secondaryButtonClass}>Exit</button>
					<button type="button" onclick={onDiscard} class={destructiveButtonClass}>
						Discard
					</button>
					<button type="button" onclick={onRequestRestart} class={secondaryButtonClass}>
						Restart
					</button>
					<button type="button" onclick={onResume} class={primaryButtonClass}>Resume</button>
				</div>
			{/if}
		</div>
	</div>
</div>
