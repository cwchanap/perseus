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
			aria-label="Hint"
			aria-describedby="assistance-scoring-help"
			data-toolbar-action="hint"
			tabindex={toolbarTabIndex('hint')}
			onclick={onHint}
			class="arcade-btn-ghost toolbar-button"
			title="Hint"
		>
			<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
				<path d="M11 21h2l.5-2h-3zM12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z" />
			</svg>
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
				title="Toggle reference"
			>
				<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<path
						d="M12 5C7 5 3.2 8.4 2 12c1.2 3.6 5 7 10 7s8.8-3.4 10-7c-1.2-3.6-5-7-10-7zm0 11a4 4 0 110-8 4 4 0 010 8z"
					/>
				</svg>
			</button>
		{/if}
		<button
			type="button"
			aria-label="Undo"
			data-toolbar-action="undo"
			tabindex={toolbarTabIndex('undo')}
			disabled={!canUndo}
			onclick={onUndo}
			class="arcade-btn-ghost toolbar-button"
			title="Undo"
		>
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.4"
				aria-hidden="true"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					d="M3 10h10a5 5 0 010 10H9m-6-10l4-4m-4 4l4 4"
				/>
			</svg>
		</button>
		<button
			type="button"
			aria-label="Reset view"
			data-toolbar-action="fit"
			tabindex={toolbarTabIndex('fit')}
			onclick={onResetView}
			class="arcade-btn-ghost toolbar-button"
			title="Reset view"
		>
			<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
				<path
					d="M4 4h6v2.4H6.4V10H4zM14 4h6v6h-2.4V6.4H14zM4 14h2.4v3.6H10V20H4zM17.6 14H20v6h-6v-2.4h3.6z"
				/>
			</svg>
		</button>
		{#if canPause}
			<button
				type="button"
				aria-label="Pause mission"
				data-toolbar-action="pause"
				tabindex={toolbarTabIndex('pause')}
				onclick={onPause}
				class="arcade-btn-ghost toolbar-button"
				title="Pause mission"
			>
				<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<path d="M7 4h3v16H7zM14 4h3v16h-3z" />
				</svg>
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
		title="More puzzle actions"
	>
		<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<circle cx="5" cy="12" r="1.8" />
			<circle cx="12" cy="12" r="1.8" />
			<circle cx="19" cy="12" r="1.8" />
		</svg>
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
				aria-label="Redo"
				data-toolbar-action="redo"
				tabindex={toolbarTabIndex('redo')}
				disabled={!canRedo}
				onclick={onRedo}
				class="arcade-btn-ghost toolbar-button"
				title="Redo"
			>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.4"
					aria-hidden="true"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						d="M21 10H11a5 5 0 000 10h4m6-10l-4-4m4 4l-4 4"
					/>
				</svg>
			</button>
			<button
				type="button"
				aria-label="Zoom out"
				data-toolbar-action="zoom-out"
				tabindex={toolbarTabIndex('zoom-out')}
				onclick={onZoomOut}
				class="arcade-btn-ghost toolbar-button"
				title="Zoom out"
			>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.4"
					aria-hidden="true"
				>
					<path stroke-linecap="round" d="M5 12h14" />
				</svg>
			</button>
			<button
				type="button"
				aria-label="Zoom in"
				data-toolbar-action="zoom-in"
				tabindex={toolbarTabIndex('zoom-in')}
				onclick={onZoomIn}
				class="arcade-btn-ghost toolbar-button"
				title="Zoom in"
			>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.4"
					aria-hidden="true"
				>
					<path stroke-linecap="round" d="M5 12h14M12 5v14" />
				</svg>
			</button>
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
				title="Rotation mode"
			>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					aria-hidden="true"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						d="M20 11a8 8 0 00-14.6-4.4L4 8m0 0V4m0 4h4M4 13a8 8 0 0014.6 4.4L20 16m0 0v4m0-4h-4"
					/>
				</svg>
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
					title="Hold to peek reference"
				>
					<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
						<path
							d="M12 5C7 5 3.2 8.4 2 12c1.2 3.6 5 7 10 7s8.8-3.4 10-7c-1.2-3.6-5-7-10-7zm0 11a4 4 0 110-8 4 4 0 010 8z"
						/>
					</svg>
				</button>
			</div>
		{/if}

		{#if canOpenSetup}
			<div class="toolbar-group">
				<button
					type="button"
					aria-label="Open mission setup"
					data-toolbar-action="setup"
					tabindex={toolbarTabIndex('setup')}
					onclick={onOpenSetup}
					class="arcade-btn-ghost toolbar-button"
					title="Open mission setup"
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						aria-hidden="true"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M12 3v3m0 12v3M3 12h3m12 0h3m-3.6-6.4l-2.1 2.1m-8.6 8.6l-2.1 2.1m0-12.8l2.1 2.1m8.6 8.6l2.1 2.1"
						/>
						<circle cx="12" cy="12" r="3.5" />
					</svg>
				</button>
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
		pointer-events: none;
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
		pointer-events: auto;
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
		pointer-events: none;
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
			align-items: stretch;
			flex-direction: column;
			flex-wrap: nowrap;
			gap: 0.5rem;
			padding: 0.5rem;
		}

		.puzzle-toolbar > .toolbar-group {
			flex-direction: column;
			flex-wrap: nowrap;
		}

		.more-toggle {
			display: inline-flex;
		}

		.toolbar-secondary {
			position: absolute;
			top: 0;
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

		.toolbar-secondary .toolbar-group {
			flex-direction: row;
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

	/* Arcade parity: controls read as luminous icon hardware while the
	   existing toolbar DOM continues to own focus order and actions. */
	.puzzle-toolbar {
		gap: 0.75rem;
		padding: 0.75rem 0.5rem;
		background: rgba(21, 13, 51, 0.7);
		border: 0;
		border-right: 1px solid var(--border);
	}

	.toolbar-group,
	.toolbar-secondary {
		gap: 0.75rem;
	}

	.toolbar-button {
		width: 3.25rem;
		height: 3.25rem;
		padding: 0;
		border-radius: 1.125rem;
		background: rgba(28, 20, 64, 0.92);
		border-color: var(--border-bright);
		color: var(--text-1);
		box-shadow:
			inset 0 1px 0 rgb(255 255 255 / 4%),
			0 8px 18px rgb(0 0 0 / 18%);
	}

	.toolbar-button svg {
		width: 1.45rem;
		height: 1.45rem;
		flex: 0 0 auto;
		pointer-events: none;
	}

	.toolbar-button:hover:not(:disabled) {
		color: var(--accent);
		border-color: var(--accent);
		box-shadow: 0 0 16px rgb(58 255 255 / 18%);
	}

	.toolbar-button[data-toolbar-action='hint'] {
		color: #241300;
		background: linear-gradient(160deg, #ffe06b, #ffbb00);
		border-color: #ffdf55;
		box-shadow:
			0 4px 0 #a37500,
			0 8px 20px rgb(255 204 0 / 40%);
	}

	.toolbar-button[data-toolbar-action='hint']:hover:not(:disabled) {
		color: #241300;
		border-color: #fff0a8;
		box-shadow:
			0 4px 0 #a37500,
			0 0 22px rgb(255 204 0 / 60%);
	}

	.toolbar-button[aria-pressed='true'] {
		color: var(--accent);
		border-color: var(--accent);
		background: rgb(58 255 255 / 10%);
		box-shadow: 0 0 16px rgb(58 255 255 / 20%);
	}

	.more-toggle {
		color: var(--accent);
	}

	@media (min-width: 1024px) {
		.puzzle-toolbar {
			display: flex;
			width: 100%;
			height: 100%;
			box-sizing: border-box;
			flex-direction: column;
			flex-wrap: nowrap;
			align-items: stretch;
			overflow: hidden;
		}

		.puzzle-toolbar > .toolbar-group,
		.puzzle-toolbar > .toolbar-secondary,
		.puzzle-toolbar > .toolbar-secondary .toolbar-group {
			display: contents;
		}

		.puzzle-toolbar > .toolbar-group .toolbar-button[data-toolbar-action='hint'] {
			order: 1;
		}

		.puzzle-toolbar > .toolbar-group .toolbar-button[data-toolbar-action='reference'] {
			order: 2;
		}

		.puzzle-toolbar > .toolbar-group .toolbar-button[data-toolbar-action='undo'] {
			order: 3;
		}

		.puzzle-toolbar > .toolbar-secondary .toolbar-button[data-toolbar-action='redo'] {
			order: 4;
		}

		.puzzle-toolbar > .toolbar-group .toolbar-button[data-toolbar-action='fit'] {
			order: 5;
		}

		.puzzle-toolbar > .toolbar-group .toolbar-button[data-toolbar-action='pause'] {
			order: 99;
			margin-top: auto;
		}

		.puzzle-toolbar > .toolbar-secondary .toolbar-button[data-toolbar-action='rotation'] {
			order: 6;
		}

		.puzzle-toolbar > .toolbar-secondary .toolbar-button[data-toolbar-action='peek'],
		.puzzle-toolbar > .toolbar-secondary .toolbar-button[data-toolbar-action='setup'],
		.puzzle-toolbar > .toolbar-secondary .toolbar-button[data-toolbar-action='zoom-out'],
		.puzzle-toolbar > .toolbar-secondary .toolbar-button[data-toolbar-action='zoom-in'],
		.puzzle-toolbar > .more-toggle {
			order: 98;
		}

		.puzzle-toolbar > .more-toggle {
			display: inline-flex;
		}

		.puzzle-toolbar > .toolbar-secondary {
			position: absolute;
			top: 0.5rem;
			left: calc(100% + 0.5rem);
			z-index: 30;
			display: none;
			width: 11rem;
			box-sizing: border-box;
			flex-direction: column;
			align-items: stretch;
			padding: 0.5rem;
			border: 1px solid var(--border-bright);
			border-radius: 1rem;
			background: rgba(21, 13, 51, 0.97);
			box-shadow: 0 12px 32px rgb(0 0 0 / 40%);
		}

		.puzzle-toolbar > .toolbar-secondary[data-open='false'] {
			display: contents;
			position: static;
			width: auto;
			padding: 0;
			border: 0;
			background: transparent;
			box-shadow: none;
		}

		.puzzle-toolbar
			> .toolbar-secondary[data-open='false']
			.toolbar-button:not([data-toolbar-action='redo']) {
			display: none;
		}

		.puzzle-toolbar > .toolbar-secondary[data-open='true'] {
			display: flex;
		}

		.puzzle-toolbar > .toolbar-secondary .toolbar-group {
			display: flex;
			flex-direction: column;
			align-items: stretch;
		}

		.puzzle-toolbar > .toolbar-secondary .toolbar-button {
			width: 100%;
		}
	}

	@media (max-width: 1023px) {
		.puzzle-toolbar {
			gap: 0.625rem;
			padding: 0.875rem 0.25rem;
			background: transparent;
			border: 0;
		}

		.puzzle-toolbar > .toolbar-group {
			gap: 0.625rem;
		}

		.toolbar-button {
			width: 3.25rem;
			height: 3.25rem;
		}

		.more-toggle {
			width: 3.25rem;
			height: 3.25rem;
		}

		.toolbar-secondary {
			border-radius: 1.125rem;
			background: rgba(21, 13, 51, 0.96);
			border-color: var(--border-bright);
		}
	}
</style>
