<script lang="ts">
	export let onUndo: () => void;
	export let onRedo: () => void;
	export let onHint: () => void;
	export let onReferenceDown: () => void;
	export let onReferenceUp: () => void;
	export let onZoomIn: () => void;
	export let onZoomOut: () => void;
	export let onResetView: () => void;
	export let onRotationToggle: () => void;
	export let canUndo: boolean;
	export let canRedo: boolean;
	export let rotationEnabled: boolean;
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
		onpointerdown={onReferenceDown}
		onpointerup={onReferenceUp}
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
