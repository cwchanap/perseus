<script lang="ts">
	import { modalFocus } from '$lib/actions/modalFocus';
	import type { GameplayPreferences } from '$lib/services/gameplay/session/preferences';

	interface Props {
		puzzleName: string;
		pieceCount: number;
		gridCols: number;
		gridRows: number;
		draft: GameplayPreferences;
		mandatory: boolean;
		inputHelp: string;
		onDraftChange: (draft: GameplayPreferences) => void;
		onStart: () => void;
		onCancel: () => void;
		onExit: () => void;
	}

	let {
		puzzleName,
		pieceCount,
		gridCols,
		gridRows,
		draft,
		mandatory,
		inputHelp,
		onDraftChange,
		onStart,
		onCancel,
		onExit
	}: Props = $props();

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && !mandatory) {
			event.preventDefault();
			onCancel();
		}
	}

	const primaryButtonClass = 'arcade-btn';
	const secondaryButtonClass = 'arcade-btn-ghost';
</script>

<div
	class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60"
	style="padding-top: max(1rem, env(safe-area-inset-top)); padding-right: max(1rem, env(safe-area-inset-right)); padding-bottom: max(1rem, env(safe-area-inset-bottom)); padding-left: max(1rem, env(safe-area-inset-left));"
>
	<div
		role="dialog"
		aria-modal="true"
		aria-label="Mission Setup"
		aria-describedby="mission-setup-help"
		tabindex="-1"
		use:modalFocus={mandatory}
		onkeydown={handleKeydown}
		class="flex max-h-[100dvh] w-full max-w-md flex-col overflow-hidden border border-(--accent)
		bg-(--bg-1) [box-shadow:0_0_40px_var(--accent-glow)]"
	>
		<div class="min-h-0 flex-1 overflow-y-auto p-6">
			<h2
				class="text-[0.95rem] font-(--font-display) font-bold tracking-[0.12em] text-(--text-0) uppercase"
			>
				Mission Setup
			</h2>
			<p class="mt-1 text-[0.8rem] font-(--font-mono) tracking-[0.05em] text-(--text-2)">
				{puzzleName} · {pieceCount} pieces · {gridCols} × {gridRows} grid
			</p>

			<fieldset class="mt-4">
				<legend
					class="text-[0.7rem] font-(--font-mono) tracking-[0.18em] text-(--accent) uppercase"
				>
					Mode
				</legend>
				<div class="mt-2 flex flex-wrap gap-4">
					<label class="flex items-center gap-2 text-[0.8rem] text-(--text-1)">
						<input
							type="radio"
							name="mission-mode"
							value="timed"
							checked={draft.mode === 'timed'}
							onchange={() => onDraftChange({ ...draft, mode: 'timed' })}
						/>
						Timed
					</label>
					<label class="flex items-center gap-2 text-[0.8rem] text-(--text-1)">
						<input
							type="radio"
							name="mission-mode"
							value="relaxed"
							checked={draft.mode === 'relaxed'}
							onchange={() => onDraftChange({ ...draft, mode: 'relaxed' })}
						/>
						Relaxed
					</label>
				</div>
			</fieldset>

			<label class="mt-4 flex items-center gap-2 text-[0.8rem] text-(--text-1)">
				<input
					type="checkbox"
					checked={draft.rotationEnabled}
					onchange={() => onDraftChange({ ...draft, rotationEnabled: !draft.rotationEnabled })}
				/>
				Enable rotation
			</label>

			<label class="mt-3 flex items-center gap-2 text-[0.8rem] text-(--text-1)">
				<input
					type="checkbox"
					checked={draft.startImmediately}
					onchange={() => onDraftChange({ ...draft, startImmediately: !draft.startImmediately })}
				/>
				Start immediately next time
			</label>

			<p id="mission-setup-help" class="mt-4 text-[0.7rem] font-(--font-mono) text-(--text-2)">
				{inputHelp}
			</p>

			<div class="mt-6 flex flex-wrap justify-end gap-2">
				{#if !mandatory}
					<button type="button" onclick={onCancel} class={secondaryButtonClass}>Cancel</button>
				{/if}
				<button type="button" onclick={onExit} class={secondaryButtonClass}>
					Return to Arcade
				</button>
				<button type="button" onclick={onStart} class={primaryButtonClass}>Start Mission</button>
			</div>
		</div>
	</div>
</div>
