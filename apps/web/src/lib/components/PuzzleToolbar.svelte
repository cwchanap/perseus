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
		rotationToggleDisabled = false
	}: Props = $props();
</script>

<div data-testid="puzzle-toolbar" class="toolbar">
	<button aria-label="Undo" disabled={!canUndo} onclick={onUndo} class="toolbar-button">
		Undo
	</button>

	<button aria-label="Redo" disabled={!canRedo} onclick={onRedo} class="toolbar-button">
		Redo
	</button>

	<button aria-label="Hint" onclick={onHint} class="toolbar-button"> Hint </button>

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
		class="toolbar-button"
	>
		Reference
	</button>

	<button aria-label="Zoom out" onclick={onZoomOut} class="toolbar-button"> - </button>

	<button aria-label="Zoom in" onclick={onZoomIn} class="toolbar-button"> + </button>

	<button aria-label="Reset view" onclick={onResetView} class="toolbar-button"> Reset </button>

	<button
		aria-label="Rotation mode"
		aria-pressed={rotationEnabled ? 'true' : 'false'}
		disabled={rotationToggleDisabled}
		onclick={onRotationToggle}
		class="toolbar-button"
	>
		Rotate
	</button>
</div>

<style>
	.toolbar {
		display: flex;
		gap: 0.5rem;
		padding: 1rem;
		background: rgba(255, 255, 255, 0.9);
		border-radius: 0.5rem;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
	}

	.toolbar-button {
		padding: 0.5rem 1rem;
		border: 1px solid #ccc;
		border-radius: 0.25rem;
		background: white;
		cursor: pointer;
		transition: background-color 0.2s;
	}

	.toolbar-button:hover:not(:disabled) {
		background: #f0f0f0;
	}

	.toolbar-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.toolbar-button[aria-pressed='true'] {
		background: #e0e7ff;
		border-color: #818cf8;
	}
</style>
