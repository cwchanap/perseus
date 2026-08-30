<script lang="ts">
	import type { SessionMode } from '@perseus/game-core';

	export let mode: SessionMode = 'timed';
	export let rotationEnabled = false;
	export let onStart: () => void;
	export let onBack: () => void;
</script>

<stackLayout class="sheet">
	<label text="MISSION SETUP" class="sheet-title" />
	<label text="Choose how you want to play." class="sheet-text" textWrap="true" />
	<gridLayout columns="*,*">
		<button
			col={0}
			text="TIMED"
			class={mode === 'timed' ? 'sheet-option-selected' : 'sheet-option'}
			on:tap={() => (mode = 'timed')}
		/>
		<button
			col={1}
			text="RELAXED"
			class={mode === 'relaxed' ? 'sheet-option-selected' : 'sheet-option'}
			on:tap={() => (mode = 'relaxed')}
		/>
	</gridLayout>
	<gridLayout columns="*,*">
		<button
			col={0}
			text="ROTATION OFF"
			class={!rotationEnabled ? 'sheet-option-selected' : 'sheet-option'}
			on:tap={() => (rotationEnabled = false)}
		/>
		<button
			col={1}
			text="ROTATION ON"
			class={rotationEnabled ? 'sheet-option-selected' : 'sheet-option'}
			on:tap={() => (rotationEnabled = true)}
		/>
	</gridLayout>
	<button text="START" class="sheet-primary" on:tap={onStart} />
	<button text="BACK TO LIBRARY" class="library-button" on:tap={onBack} />
</stackLayout>
