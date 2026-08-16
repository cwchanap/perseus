<script lang="ts">
	interface Props {
		imageUrl?: string | null;
		active: boolean;
		// When true the overlay captures pointer events (blocking interaction
		// with the obscured gameplay surface) and renders a visible close
		// control. Used for the persistent Toggle mode. Hold-to-Peek leaves
		// this false so the existing global pointer-up cleanup still drives
		// dismissal and the overlay stays click-through.
		dismissible?: boolean;
		onDismiss?: () => void;
	}

	let { imageUrl = null, active, dismissible = false, onDismiss }: Props = $props();
	let imageError = $state(false);
	let closeButtonEl = $state<HTMLButtonElement | null>(null);
	// Element that held focus before the dismissible overlay trapped it, so
	// focus can be restored to the REF toolbar trigger when the overlay closes.
	let previouslyFocused: HTMLElement | null = null;

	$effect(() => {
		if (active) imageError = false;
	});

	// When the persistent (dismissible) overlay opens, move focus onto the
	// Close button so Tab cannot reach the obscured gameplay controls, and
	// remember the trigger to restore focus on close. Hold-to-Peek leaves
	// dismissible false, so it stays click-through and focus-agnostic.
	$effect(() => {
		const shouldTrap = active && dismissible;
		if (shouldTrap && closeButtonEl) {
			if (previouslyFocused === null) {
				previouslyFocused = (document.activeElement as HTMLElement | null) ?? null;
			}
			closeButtonEl.focus();
		} else if (!shouldTrap && previouslyFocused !== null) {
			const target = previouslyFocused;
			previouslyFocused = null;
			// Restore focus on close so the keyboard user lands back on the
			// REF trigger rather than the body.
			if (typeof target.focus === 'function') target.focus();
		}
	});

	// With a single interactive control, keep focus on the Close button:
	// Tab and Shift+Tab both wrap back to it so the keyboard user cannot
	// leave the overlay while it is open. Other keys (e.g. Ctrl+Z) pass
	// through; the route's global shortcut guard no-ops them while
	// referenceToggled is active.
	function handleOverlayKeyDown(event: KeyboardEvent) {
		if (event.key === 'Tab') {
			event.preventDefault();
			closeButtonEl?.focus();
		}
	}
</script>

{#if active}
	<div
		data-testid="reference-overlay"
		role={dismissible ? 'dialog' : undefined}
		aria-modal={dismissible ? 'true' : undefined}
		aria-label={dismissible ? 'Reference image' : undefined}
		class={`fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 ${
			dismissible ? '' : 'pointer-events-none'
		}`}
		onkeydown={dismissible ? handleOverlayKeyDown : undefined}
	>
		{#if dismissible}
			<button
				type="button"
				aria-label="Close reference"
				data-testid="reference-overlay-close"
				bind:this={closeButtonEl}
				onclick={onDismiss}
				class="arcade-btn-ghost reference-overlay-close"
			>
				CLOSE
			</button>
		{/if}
		{#if imageError || imageUrl === null}
			<p class="text-sm text-white/70">Reference image unavailable</p>
		{:else}
			<img
				src={imageUrl}
				alt="Puzzle reference"
				class="max-h-[90%] max-w-[90%] rounded-md object-contain shadow-lg"
				onerror={() => (imageError = true)}
			/>
		{/if}
	</div>
{/if}

<style>
	.reference-overlay-close {
		position: absolute;
		top: 1rem;
		right: 1rem;
		color: var(--text-0, #fff);
		border-color: var(--border-bright, rgba(255, 255, 255, 0.4));
		background: rgba(0, 0, 0, 0.4);
	}
	.reference-overlay-close:hover {
		border-color: var(--accent, #fff);
		color: var(--accent, #fff);
	}

	/* Coarse-pointer (mobile) dismiss control must meet the same 44px touch
	   target as .toolbar-button, .puzzle-piece, and .drop-zone. The
	   dismissible overlay intercepts all taps to the obscured toolbar, so
	   this control is the only pointer-based way to exit Reference mode. */
	@media (pointer: coarse) {
		.reference-overlay-close {
			min-width: 44px;
			min-height: 44px;
		}
	}
</style>
