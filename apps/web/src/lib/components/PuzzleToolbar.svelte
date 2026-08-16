<script lang="ts">
	type ReferenceHoldEvent = PointerEvent | KeyboardEvent;

	interface Props {
		onUndo: () => void;
		onRedo: () => void;
		onHint: () => void;
		onReferenceDown: (event?: ReferenceHoldEvent) => void;
		onReferenceUp: (event?: ReferenceHoldEvent) => void;
		onReferenceToggle: () => void;
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
		referenceToggled: boolean;
		referenceAvailable: boolean;
	}

	let {
		onUndo,
		onRedo,
		onHint,
		onReferenceDown,
		onReferenceUp,
		onReferenceToggle,
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
		hasReference = true,
		referenceToggled,
		referenceAvailable
	}: Props = $props();

	let moreOpen = $state(false);

	// Bumped on viewport resize so the normalization effect re-runs and
	// re-picks a visible enabled tab stop when the responsive breakpoint
	// (1023px) hides/reveals toolbar actions via CSS alone — no prop or
	// moreOpen change occurs in that case.
	let viewportVersion = $state(0);

	type ToolbarAction =
		| 'undo'
		| 'redo'
		| 'hint'
		| 'reference'
		| 'more'
		| 'zoom-out'
		| 'zoom-in'
		| 'fit'
		| 'rotation'
		| 'peek'
		| 'pause'
		| 'setup';

	let toolbarElement = $state<HTMLElement | null>(null);
	let activeToolbarAction = $state<ToolbarAction>('hint');

	const actionAvailable = $derived<Record<ToolbarAction, boolean>>({
		undo: canUndo,
		redo: canRedo,
		hint: true,
		reference: hasReference && referenceAvailable,
		more: true,
		'zoom-out': true,
		'zoom-in': true,
		fit: true,
		rotation: !rotationToggleDisabled,
		peek: hasReference && referenceAvailable && !referenceToggled,
		pause: canPause,
		setup: canOpenSetup
	});

	function toolbarTabIndex(action: ToolbarAction): 0 | -1 {
		return activeToolbarAction === action && actionAvailable[action] ? 0 : -1;
	}

	function visibleEnabledToolbarButtons(): HTMLButtonElement[] {
		if (!toolbarElement) return [];
		return Array.from(
			toolbarElement.querySelectorAll<HTMLButtonElement>('[data-toolbar-action]')
		).filter((button) => !button.disabled && button.offsetParent !== null);
	}

	function handleToolbarFocusIn(event: FocusEvent): void {
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		const button = target.closest<HTMLButtonElement>('[data-toolbar-action]');
		const action = button?.dataset.toolbarAction as ToolbarAction | undefined;
		if (action) activeToolbarAction = action;
	}

	function handleToolbarKeyDown(event: KeyboardEvent): void {
		if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		const current = target.closest<HTMLButtonElement>('[data-toolbar-action]');
		if (!current) return;

		const items = visibleEnabledToolbarButtons();
		const index = items.indexOf(current);
		if (index < 0 || items.length < 2) return;

		event.preventDefault();
		const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
		const next = items[(index + delta + items.length) % items.length]!;
		const nextAction = next.dataset.toolbarAction as ToolbarAction | undefined;
		if (nextAction) activeToolbarAction = nextAction;
		next.focus();
	}

	function toolbarKeyboardAction(node: HTMLElement) {
		toolbarElement = node;
		node.addEventListener('keydown', handleToolbarKeyDown);
		return {
			destroy() {
				node.removeEventListener('keydown', handleToolbarKeyDown);
			}
		};
	}

	$effect(() => {
		const onResize = () => {
			viewportVersion++;
		};
		window.addEventListener('resize', onResize);
		return () => window.removeEventListener('resize', onResize);
	});

	$effect(() => {
		void actionAvailable;
		void moreOpen;
		void viewportVersion;

		const items = visibleEnabledToolbarButtons();
		if (items.some((button) => button.dataset.toolbarAction === activeToolbarAction)) return;
		const first = items[0]?.dataset.toolbarAction as ToolbarAction | undefined;
		if (first) activeToolbarAction = first;
	});
</script>

<div
	data-testid="puzzle-toolbar"
	class="puzzle-toolbar"
	role="toolbar"
	aria-label="Puzzle actions"
	use:toolbarKeyboardAction
	onfocusin={handleToolbarFocusIn}
>
	<div class="toolbar-group">
		<button
			type="button"
			aria-label="Undo"
			data-toolbar-action="undo"
			tabindex={toolbarTabIndex('undo')}
			disabled={!canUndo}
			onclick={onUndo}
			class="arcade-btn-ghost toolbar-button"
		>
			UNDO
		</button>
		<button
			type="button"
			aria-label="Redo"
			data-toolbar-action="redo"
			tabindex={toolbarTabIndex('redo')}
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
			aria-describedby="assistance-scoring-help"
			data-toolbar-action="hint"
			tabindex={toolbarTabIndex('hint')}
			onclick={onHint}
			class="arcade-btn-ghost toolbar-button"
		>
			HINT
		</button>

		{#if hasReference}
			<button
				type="button"
				aria-label="Toggle reference"
				aria-pressed={referenceToggled ? 'true' : 'false'}
				aria-describedby="assistance-scoring-help"
				data-toolbar-action="reference"
				tabindex={toolbarTabIndex('reference')}
				disabled={!referenceAvailable}
				onclick={onReferenceToggle}
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
		data-toolbar-action="more"
		tabindex={toolbarTabIndex('more')}
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
				data-toolbar-action="zoom-out"
				tabindex={toolbarTabIndex('zoom-out')}
				onclick={onZoomOut}
				class="arcade-btn-ghost toolbar-button">−</button
			>
			<button
				type="button"
				aria-label="Zoom in"
				data-toolbar-action="zoom-in"
				tabindex={toolbarTabIndex('zoom-in')}
				onclick={onZoomIn}
				class="arcade-btn-ghost toolbar-button">+</button
			>
			<button
				type="button"
				aria-label="Reset view"
				data-toolbar-action="fit"
				tabindex={toolbarTabIndex('fit')}
				onclick={onResetView}
				class="arcade-btn-ghost toolbar-button">FIT</button
			>
			<button
				type="button"
				aria-label="Rotation mode"
				aria-pressed={rotationEnabled ? 'true' : 'false'}
				aria-describedby={rotationToggleDisabled ? 'rotation-lock-reason' : undefined}
				data-toolbar-action="rotation"
				tabindex={toolbarTabIndex('rotation')}
				disabled={rotationToggleDisabled}
				onclick={onRotationToggle}
				class="arcade-btn-ghost toolbar-button"
			>
				ROTATE
			</button>
		</div>

		{#if hasReference}
			<div class="toolbar-group">
				<button
					type="button"
					aria-label="Hold to peek reference"
					aria-describedby="assistance-scoring-help"
					data-toolbar-action="peek"
					tabindex={toolbarTabIndex('peek')}
					disabled={!referenceAvailable || referenceToggled}
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
					PEEK
				</button>
			</div>
		{/if}

		{#if canPause || canOpenSetup}
			<div class="toolbar-group">
				{#if canPause}
					<button
						type="button"
						aria-label="Pause mission"
						data-toolbar-action="pause"
						tabindex={toolbarTabIndex('pause')}
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
						data-toolbar-action="setup"
						tabindex={toolbarTabIndex('setup')}
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

	<span id="assistance-scoring-help" class="sr-only">
		Hint affects timed results. Peek and Reference do not.
	</span>
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
