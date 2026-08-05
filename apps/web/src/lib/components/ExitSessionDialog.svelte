<script lang="ts">
	import { modalFocus } from '$lib/actions/modalFocus';

	interface Props {
		onSave: () => void;
		onDiscard: () => void;
		onCancel: () => void;
	}

	let { onSave, onDiscard, onCancel }: Props = $props();

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
		aria-label="Exit Mission"
		tabindex="-1"
		use:modalFocus
		onkeydown={(e) => e.key === 'Escape' && onCancel()}
		class="flex max-h-[100dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
	>
		<div class="min-h-0 flex-1 overflow-y-auto p-6">
			<h2 class="text-lg font-semibold text-gray-900">Exit mission?</h2>
			<p class="mt-2 text-sm text-gray-600">Choose how you want to leave this mission.</p>
			<div class="mt-6 flex flex-wrap justify-end gap-2">
				<button type="button" onclick={onCancel} class={secondaryButtonClass}>Cancel</button>
				<button type="button" onclick={onDiscard} class={secondaryButtonClass}>Discard</button>
				<button type="button" onclick={onSave} class={primaryButtonClass}>Save &amp; Exit</button>
			</div>
		</div>
	</div>
</div>
