<script lang="ts">
	import { modalFocus } from '$lib/actions/modalFocus';
	import type { SessionMode } from '$lib/services/gameplay/session/types';

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

	const primaryButtonClass =
		'rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors cursor-pointer hover:bg-indigo-500';
	const secondaryButtonClass =
		'rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-900 shadow-sm transition-colors cursor-pointer hover:bg-gray-100';
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
		class="flex max-h-[100dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
	>
		<div class="min-h-0 flex-1 overflow-y-auto p-6">
			{#if confirmingRestart}
				<h2 class="text-lg font-semibold text-gray-900">Restart this mission?</h2>
				<p class="mt-2 text-sm text-gray-600">
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
				<h2 class="text-lg font-semibold text-gray-900">
					{presentation === 'resume' ? 'Resume Mission' : 'Mission Paused'}
				</h2>
				<p class="mt-1 text-sm text-gray-600">
					{mode === 'timed' ? 'Timed' : 'Relaxed'} mission
				</p>
				<div class="mt-6 flex flex-wrap justify-end gap-2">
					<button type="button" onclick={onExit} class={secondaryButtonClass}>Exit</button>
					<button type="button" onclick={onDiscard} class={secondaryButtonClass}>Discard</button>
					<button type="button" onclick={onRequestRestart} class={secondaryButtonClass}>
						Restart
					</button>
					<button type="button" onclick={onResume} class={primaryButtonClass}>Resume</button>
				</div>
			{/if}
		</div>
	</div>
</div>
