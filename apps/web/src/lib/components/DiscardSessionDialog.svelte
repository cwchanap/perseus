<script lang="ts">
	import { modalFocus } from '$lib/actions/modalFocus';

	interface Props {
		puzzleName: string;
		onConfirm: () => void;
		onCancel: () => void;
	}

	let { puzzleName, onConfirm, onCancel }: Props = $props();
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
		class="flex max-h-[100dvh] w-full max-w-md flex-col overflow-hidden border border-(--hot)
		bg-(--bg-1) [box-shadow:0_0_40px_var(--hot-glow)]"
	>
		<div class="min-h-0 flex-1 overflow-y-auto p-6">
			<h2
				class="text-[0.95rem] font-(--font-display) font-bold tracking-[0.12em] text-(--text-0) uppercase"
			>
				Discard saved progress?
			</h2>
			<p class="mt-2 text-[0.8rem] font-(--font-mono) tracking-[0.05em] text-(--text-2)">
				This permanently removes saved progress for {puzzleName}.
			</p>
			<div class="mt-6 flex flex-wrap justify-end gap-2">
				<button type="button" onclick={onCancel} class="arcade-btn-ghost">Cancel</button>
				<button type="button" onclick={onConfirm} class="arcade-btn-danger">Discard</button>
			</div>
		</div>
	</div>
</div>
