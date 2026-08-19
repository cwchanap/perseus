<script lang="ts">
	import { modalFocus } from '$lib/actions/modalFocus';

	interface Props {
		puzzleName: string;
		onConfirm: () => void;
		onCancel: () => void;
	}

	let { puzzleName, onConfirm, onCancel }: Props = $props();

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
		aria-label="Discard saved progress"
		tabindex="-1"
		use:modalFocus
		onkeydown={(event) => event.key === 'Escape' && onCancel()}
		class="
			flex max-h-[100dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white
			shadow-xl
		"
	>
		<div class="min-h-0 flex-1 overflow-y-auto p-6">
			<h2 class="text-lg font-semibold text-gray-900">Discard saved progress?</h2>
			<p class="mt-2 text-sm text-gray-600">
				This permanently removes saved progress for {puzzleName}.
			</p>
			<div class="mt-6 flex flex-wrap justify-end gap-2">
				<button type="button" onclick={onCancel} class={secondaryButtonClass}>Cancel</button>
				<button type="button" onclick={onConfirm} class={primaryButtonClass}>Discard</button>
			</div>
		</div>
	</div>
</div>
