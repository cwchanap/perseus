<script lang="ts">
	type ReferenceHoldEvent = PointerEvent | KeyboardEvent;

	interface Props {
		onUndo: () => void;
		onRedo: () => void;
		onHint: () => void;
		onReferenceDown: (event?: ReferenceHoldEvent) => void;
		onReferenceUp: (event?: ReferenceHoldEvent) => void;
		onZoomIn: () => void;
		onZoomOut: () => void;
		onResetView: () => void;
		onRotationToggle: () => void;
		canUndo: boolean;
		canRedo: boolean;
		rotationEnabled: boolean;
		rotationToggleDisabled?: boolean;
		hasReference?: boolean;
	}

	let {
		onUndo,
		onRedo,
		onHint,
		onReferenceDown,
		onReferenceUp,
		onZoomIn,
		onZoomOut,
		onResetView,
		onRotationToggle,
		canUndo,
		canRedo,
		rotationEnabled,
		rotationToggleDisabled = false,
		hasReference = true
	}: Props = $props();

	const toolbarButtonClass =
		'rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-900 shadow-sm transition-colors enabled:cursor-pointer enabled:hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50';
	const pressedRotationButtonClass =
		'border-indigo-400 bg-indigo-100 text-indigo-900 enabled:hover:bg-indigo-100';
</script>

<div
	data-testid="puzzle-toolbar"
	class="flex flex-wrap items-center gap-2 rounded-lg bg-white/90 p-4 shadow-[0_2px_8px_rgba(0,0,0,0.1)]"
>
	<button aria-label="Undo" disabled={!canUndo} onclick={onUndo} class={toolbarButtonClass}>
		Undo
	</button>

	<button aria-label="Redo" disabled={!canRedo} onclick={onRedo} class={toolbarButtonClass}>
		Redo
	</button>

	<button aria-label="Hint" onclick={onHint} class={toolbarButtonClass}> Hint </button>

	{#if hasReference}
		<button
			aria-label="Reference"
			onpointerdown={(event) => onReferenceDown(event)}
			onpointerup={(event) => onReferenceUp(event)}
			onpointerleave={(event) => onReferenceUp(event)}
			onkeydown={(e) => {
				if (e.key === ' ' || e.key === 'Enter') {
					e.preventDefault();
					onReferenceDown(e);
				}
			}}
			onkeyup={(e) => {
				if (e.key === ' ' || e.key === 'Enter') {
					e.preventDefault();
					onReferenceUp(e);
				}
			}}
			onblur={() => onReferenceUp()}
			class={toolbarButtonClass}
		>
			Reference
		</button>
	{/if}

	<button aria-label="Zoom out" onclick={onZoomOut} class={toolbarButtonClass}> - </button>

	<button aria-label="Zoom in" onclick={onZoomIn} class={toolbarButtonClass}> + </button>

	<button aria-label="Reset view" onclick={onResetView} class={toolbarButtonClass}> Reset </button>

	<button
		aria-label="Rotation mode"
		aria-pressed={rotationEnabled ? 'true' : 'false'}
		disabled={rotationToggleDisabled}
		onclick={onRotationToggle}
		class={`${toolbarButtonClass} ${rotationEnabled ? pressedRotationButtonClass : ''}`}
	>
		Rotate
	</button>
</div>
