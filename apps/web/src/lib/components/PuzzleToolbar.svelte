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
		onPause?: () => void;
		onOpenSetup?: () => void;
		canOpenSetup?: boolean;
		canPause?: boolean;
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
		onPause,
		onOpenSetup,
		canOpenSetup = false,
		canPause = false,
		canUndo,
		canRedo,
		rotationEnabled,
		rotationToggleDisabled = false,
		hasReference = true
	}: Props = $props();

	let moreOpen = $state(false);
</script>

<div data-testid="puzzle-toolbar" class="puzzle-toolbar">
	<div class="toolbar-group">
		<button
			type="button"
			aria-label="Undo"
			disabled={!canUndo}
			onclick={onUndo}
			class="arcade-btn-ghost toolbar-button"
		>
			UNDO
		</button>
		<button
			type="button"
			aria-label="Redo"
			disabled={!canRedo}
			onclick={onRedo}
			class="arcade-btn-ghost toolbar-button"
		>
			REDO
		</button>
	</div>

	<div class="toolbar-group">
		<button
			type="button"
			aria-label="Hint"
			onclick={onHint}
			class="arcade-btn-ghost toolbar-button"
		>
			HINT
		</button>

		{#if hasReference}
			<button
				type="button"
				aria-label="Reference"
				onpointerdown={(event) => onReferenceDown(event)}
				onpointerup={(event) => onReferenceUp(event)}
				onpointerleave={(event) => onReferenceUp(event)}
				onkeydown={(event) => {
					if (event.key === ' ' || event.key === 'Enter') {
						event.preventDefault();
						onReferenceDown(event);
					}
				}}
				onkeyup={(event) => {
					if (event.key === ' ' || event.key === 'Enter') {
						event.preventDefault();
						onReferenceUp(event);
					}
				}}
				onblur={() => onReferenceUp()}
				class="arcade-btn-ghost toolbar-button"
			>
				REF
			</button>
		{/if}
	</div>

	<button
		type="button"
		class="arcade-btn-ghost toolbar-button more-toggle"
		aria-label="More puzzle actions"
		aria-expanded={moreOpen ? 'true' : 'false'}
		aria-controls="puzzle-toolbar-secondary"
		onclick={() => (moreOpen = !moreOpen)}
	>
		MORE
	</button>

	<div
		id="puzzle-toolbar-secondary"
		data-testid="puzzle-toolbar-secondary"
		data-open={moreOpen ? 'true' : 'false'}
		class="toolbar-secondary"
	>
		<div class="toolbar-group">
			<button
				type="button"
				aria-label="Zoom out"
				onclick={onZoomOut}
				class="arcade-btn-ghost toolbar-button">−</button
			>
			<button
				type="button"
				aria-label="Zoom in"
				onclick={onZoomIn}
				class="arcade-btn-ghost toolbar-button">+</button
			>
			<button
				type="button"
				aria-label="Reset view"
				onclick={onResetView}
				class="arcade-btn-ghost toolbar-button">FIT</button
			>
			<button
				type="button"
				aria-label="Rotation mode"
				aria-pressed={rotationEnabled ? 'true' : 'false'}
				aria-describedby={rotationToggleDisabled ? 'rotation-lock-reason' : undefined}
				disabled={rotationToggleDisabled}
				onclick={onRotationToggle}
				class="arcade-btn-ghost toolbar-button"
			>
				ROTATE
			</button>
		</div>

		{#if canPause || canOpenSetup}
			<div class="toolbar-group">
				{#if canPause}
					<button
						type="button"
						aria-label="Pause mission"
						onclick={onPause}
						class="arcade-btn-ghost toolbar-button"
					>
						PAUSE
					</button>
				{/if}
				{#if canOpenSetup}
					<button
						type="button"
						aria-label="Open mission setup"
						onclick={onOpenSetup}
						class="arcade-btn-ghost toolbar-button"
					>
						SETUP
					</button>
				{/if}
			</div>
		{/if}
	</div>

	{#if rotationToggleDisabled}
		<span id="rotation-lock-reason" class="sr-only">
			Rotation is locked after the first placement
		</span>
	{/if}
</div>

<style>
	.puzzle-toolbar {
		position: relative;
		display: flex;
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
		padding: 0.75rem;
		background: var(--bg-2);
		border: 1px solid var(--border);
	}

	.toolbar-group,
	.toolbar-secondary {
		display: flex;
		min-width: 0;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}

	.toolbar-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.45rem 0.65rem;
		line-height: 1;
		white-space: nowrap;
	}

	.toolbar-button:focus-visible {
		color: var(--text-0);
		border-color: var(--accent);
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.toolbar-button:disabled {
		cursor: not-allowed;
		opacity: 0.45;
	}

	.toolbar-button:disabled:hover {
		color: var(--text-1);
		border-color: var(--border);
	}

	.toolbar-button[aria-pressed='true'] {
		color: var(--accent);
		border-color: var(--accent);
		background: var(--accent-glow);
		box-shadow: 0 0 10px var(--accent-glow);
	}

	.more-toggle {
		display: none;
	}

	@media (max-width: 1023px) {
		.puzzle-toolbar {
			gap: 0.5rem;
			padding: 0.5rem;
		}

		.more-toggle {
			display: inline-flex;
		}

		.toolbar-secondary {
			position: absolute;
			top: calc(100% + 0.5rem);
			right: 0;
			z-index: 20;
			display: none;
			width: min(18rem, calc(100vw - 2rem));
			box-sizing: border-box;
			flex-direction: column;
			align-items: stretch;
			gap: 0.5rem;
			padding: 0.5rem;
			background: var(--bg-1);
			border: 1px solid var(--border);
			box-shadow: 0 8px 24px rgb(0 0 0 / 20%);
		}

		.toolbar-secondary[data-open='true'] {
			display: flex;
		}

		.toolbar-secondary .toolbar-group {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.5rem;
		}

		.toolbar-secondary .toolbar-button {
			width: 100%;
		}
	}

	@media (pointer: coarse) {
		.toolbar-button {
			min-width: 44px;
			min-height: 44px;
		}
	}
</style>
