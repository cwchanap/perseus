<script lang="ts">
	import type { ReferenceMode } from '@perseus/game-core';

	export let puzzleName: string;
	export let difficultyLabel: string;
	export let elapsedSeconds: number | null;
	export let canUndo: boolean;
	export let canRedo: boolean;
	export let rotationEnabled: boolean;
	export let hasUserActivity: boolean;
	export let referenceAvailable: boolean;
	export let referenceMode: ReferenceMode | null = null;
	export let onLibrary: () => void;
	export let onUndo: () => void;
	export let onRedo: () => void;
	export let onHint: () => void;
	export let onFitBoard: () => void;
	export let onSetRotationMode: (enabled: boolean) => void;
	export let onPause: () => void;
	export let onRestart: () => void;
	export let onDiscard: () => void;
	export let onSetReferenceMode: (mode: ReferenceMode | null) => void;

	// Exclusive menu expansion is pure toolbar UI; every action still routes
	// out through callbacks — this component never dispatches.
	let openMenu: 'more' | 'reference' | null = null;

	// Same armed confirm as the pause sheet: with meaningful activity the
	// first tap arms (the item becomes CONFIRM RESTART?), the second fires;
	// without activity restart is immediate. Disarming on menu close keeps
	// the armed state from leaking across opens.
	let confirmRestart = false;

	function toggleMenu(menu: 'more' | 'reference'): void {
		confirmRestart = false;
		openMenu = openMenu === menu ? null : menu;
	}

	function runFromMenu(action: () => void): void {
		confirmRestart = false;
		openMenu = null;
		action();
	}

	function requestRestart(): void {
		if (hasUserActivity && !confirmRestart) {
			confirmRestart = true;
			return;
		}
		runFromMenu(onRestart);
	}

	function formatElapsed(seconds: number | null): string {
		if (seconds === null) return 'RELAXED';
		return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
	}

	function onHoldTouch(args: any): void {
		if (args.action === 'down') {
			onSetReferenceMode('hold');
		} else if (args.action === 'up' || args.action === 'cancel') {
			onSetReferenceMode(null);
		}
	}

	function tapReferenceMode(mode: ReferenceMode): void {
		onSetReferenceMode(referenceMode === mode ? null : mode);
	}
</script>

<stackLayout class="toolbar">
	<gridLayout class="toolbar-bar" columns="auto,*,auto,auto,auto,auto,auto,auto">
		<button col={0} text="LIBRARY" class="toolbar-button" on:tap={onLibrary} />
		<stackLayout col={1} class="toolbar-title">
			<label text={puzzleName} class="toolbar-name" textWrap="true" />
			<label text={difficultyLabel} class="toolbar-difficulty" />
		</stackLayout>
		<label col={2} text={formatElapsed(elapsedSeconds)} class="toolbar-timer" />
		<button
			col={3}
			text="UNDO"
			class={canUndo ? 'toolbar-button' : 'toolbar-button-disabled'}
			isEnabled={canUndo}
			on:tap={onUndo}
		/>
		<button
			col={4}
			text="REDO"
			class={canRedo ? 'toolbar-button' : 'toolbar-button-disabled'}
			isEnabled={canRedo}
			on:tap={onRedo}
		/>
		<button col={5} text="HINT" class="toolbar-button" on:tap={onHint} />
		{#if referenceAvailable}
			<button
				col={6}
				text="REFERENCE"
				class={referenceMode ? 'toolbar-button-active' : 'toolbar-button'}
				on:tap={() => toggleMenu('reference')}
			/>
		{/if}
		<button
			col={7}
			text="MORE"
			class={openMenu === 'more' ? 'toolbar-button-active' : 'toolbar-button'}
			on:tap={() => toggleMenu('more')}
		/>
	</gridLayout>
	{#if openMenu === 'more'}
		<gridLayout class="toolbar-menu" columns="auto,auto,auto,auto,auto">
			<button
				col={0}
				text="FIT BOARD"
				class="toolbar-button"
				on:tap={() => runFromMenu(onFitBoard)}
			/>
			<button
				col={1}
				text={rotationEnabled ? 'ROTATION OFF' : 'ROTATION ON'}
				class="toolbar-button"
				on:tap={() => runFromMenu(() => onSetRotationMode(!rotationEnabled))}
			/>
			<button col={2} text="PAUSE" class="toolbar-button" on:tap={() => runFromMenu(onPause)} />
			<button
				col={3}
				text={confirmRestart ? 'CONFIRM RESTART?' : 'RESTART'}
				class={confirmRestart ? 'toolbar-button-active' : 'toolbar-button'}
				on:tap={requestRestart}
			/>
			<button col={4} text="DISCARD" class="toolbar-button" on:tap={() => runFromMenu(onDiscard)} />
		</gridLayout>
	{:else if openMenu === 'reference'}
		<gridLayout class="toolbar-menu" columns="auto,auto,auto">
			<button
				col={0}
				text="HOLD TO PEEK"
				class={referenceMode === 'hold' ? 'toolbar-button-active' : 'toolbar-button'}
				on:touch={onHoldTouch}
			/>
			<button
				col={1}
				text="TOGGLE"
				class={referenceMode === 'toggle' ? 'toolbar-button-active' : 'toolbar-button'}
				on:tap={() => tapReferenceMode('toggle')}
			/>
			<button
				col={2}
				text="GHOST"
				class={referenceMode === 'ghost' ? 'toolbar-button-active' : 'toolbar-button'}
				on:tap={() => tapReferenceMode('ghost')}
			/>
		</gridLayout>
	{/if}
</stackLayout>
