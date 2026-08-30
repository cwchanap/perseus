<script lang="ts">
	export let hasUserActivity = false;
	export let onResume: () => void;
	export let onRestart: () => void;
	export let onDiscard: () => void;

	let confirmingRestart = false;

	// Restart confirms once when meaningful activity exists; the second tap
	// (or an untouched run) restarts immediately. The sheet unmounts on
	// restart, so the confirm state resets with it.
	function requestRestart(): void {
		if (hasUserActivity && !confirmingRestart) {
			confirmingRestart = true;
			return;
		}
		onRestart();
	}
</script>

<stackLayout class="sheet">
	<label text="PAUSED" class="sheet-title" />
	{#if confirmingRestart}
		<label
			text="Restart discards current progress. Start over?"
			class="sheet-text"
			textWrap="true"
		/>
		<button text="RESTART" class="sheet-primary" on:tap={requestRestart} />
		<button text="CANCEL" class="library-button" on:tap={() => (confirmingRestart = false)} />
	{:else}
		<button text="RESUME" class="sheet-primary" on:tap={onResume} />
		<button text="RESTART" class="library-button" on:tap={requestRestart} />
		<button text="DISCARD PROGRESS" class="library-button" on:tap={onDiscard} />
	{/if}
</stackLayout>
