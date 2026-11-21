import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import PuzzleToolbar from '../PuzzleToolbar.svelte';

function createToolbarProps(
	overrides: Partial<Parameters<typeof render<typeof PuzzleToolbar>>[1]> = {}
) {
	return {
		onUndo: vi.fn(),
		onRedo: vi.fn(),
		onHint: vi.fn(),
		onReferenceDown: vi.fn(),
		onReferenceUp: vi.fn(),
		onReferenceToggle: vi.fn(),
		onZoomIn: vi.fn(),
		onZoomOut: vi.fn(),
		onResetView: vi.fn(),
		onRotationToggle: vi.fn(),
		canUndo: false,
		canRedo: false,
		rotationEnabled: false,
		rotationToggleDisabled: false,
		referenceToggled: false,
		referenceAvailable: true,
		...overrides
	};
}

async function renderToolbar(overrides: Parameters<typeof createToolbarProps>[0] = {}) {
	return render(PuzzleToolbar, createToolbarProps(overrides));
}

describe('PuzzleToolbar', () => {
	describe('roving focus', () => {
		it('exposes exactly one visible enabled toolbar tab stop', async () => {
			renderToolbar({ canUndo: false, canRedo: false });
			const toolbar = await page.getByTestId('puzzle-toolbar').element();

			expect(toolbar.getAttribute('role')).toBe('toolbar');
			expect(toolbar.getAttribute('aria-label')).toBe('Puzzle actions');

			const tabbable = Array.from(
				toolbar.querySelectorAll<HTMLButtonElement>('[data-toolbar-action]')
			).filter(
				(button) => button.offsetParent !== null && !button.disabled && button.tabIndex === 0
			);
			expect(tabbable).toHaveLength(1);
		});

		it('ArrowRight moves to the adjacent visible enabled action exactly once', async () => {
			renderToolbar({ canUndo: false, canRedo: false, referenceAvailable: true });
			const hint = await page.getByRole('button', { name: 'Hint' }).element();
			const reference = await page.getByRole('button', { name: 'Toggle reference' }).element();

			hint.focus();
			hint.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

			expect(document.activeElement).toBe(reference);
		});

		const visibleEnabledActions = () => {
			const toolbar = page.getByTestId('puzzle-toolbar').element();
			return Array.from(
				toolbar.querySelectorAll<HTMLButtonElement>('[data-toolbar-action]')
			).filter((button) => button.offsetParent !== null && !button.disabled);
		};

		it.each([
			['ArrowRight', 'last', 'first'],
			['ArrowLeft', 'first', 'last']
		] as const)(
			'wraps %s from the %s visible enabled action to the %s',
			async (key, fromPos, toPos) => {
				renderToolbar();
				const actions = visibleEnabledActions();
				expect(actions.length).toBeGreaterThanOrEqual(2);
				const from = fromPos === 'last' ? actions[actions.length - 1] : actions[0];
				const to = toPos === 'last' ? actions[actions.length - 1] : actions[0];

				from.focus();
				from.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

				expect(document.activeElement).toBe(to);
			}
		);

		it.each([
			['undo disabled', { canUndo: false }],
			['redo disabled', { canRedo: false }],
			['reference unavailable', { referenceAvailable: false }],
			['reference absent', { hasReference: false }],
			['peek disabled by toggle', { referenceToggled: true }],
			['rotation locked', { rotationToggleDisabled: true }],
			['pause absent', { canPause: false }],
			['setup absent', { canOpenSetup: false }]
		] as const)('keeps one visible enabled tab stop when %s', async (_name, overrides) => {
			renderToolbar({
				canUndo: true,
				canRedo: true,
				canPause: true,
				canOpenSetup: true,
				...overrides
			});
			const toolbar = await page.getByTestId('puzzle-toolbar').element();
			const tabbable = Array.from(
				toolbar.querySelectorAll<HTMLButtonElement>('[data-toolbar-action]')
			).filter(
				(button) => button.offsetParent !== null && !button.disabled && button.tabIndex === 0
			);
			expect(tabbable).toHaveLength(1);
		});
		it('ignores focusin that does not originate from a toolbar action button', async () => {
			renderToolbar({ canUndo: false, canRedo: false });
			const toolbar = await page.getByTestId('puzzle-toolbar').element();
			const tabbableBefore = Array.from(
				toolbar.querySelectorAll<HTMLButtonElement>('[data-toolbar-action]')
			).filter((button) => button.tabIndex === 0);
			expect(tabbableBefore).toHaveLength(1);

			// A focusin bubbling up from the toolbar container itself (not an
			// action button) must not reassign the roving tab stop.
			toolbar.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

			const tabbableAfter = Array.from(
				toolbar.querySelectorAll<HTMLButtonElement>('[data-toolbar-action]')
			).filter((button) => button.tabIndex === 0);
			expect(tabbableAfter).toHaveLength(1);
			expect(tabbableAfter[0]).toBe(tabbableBefore[0]);
		});

		it('ignores arrow keydown that does not originate from a toolbar action button', async () => {
			renderToolbar({ canUndo: false, canRedo: false });
			const toolbar = await page.getByTestId('puzzle-toolbar').element();
			const tabbableBefore = Array.from(
				toolbar.querySelectorAll<HTMLButtonElement>('[data-toolbar-action]')
			).filter((button) => button.tabIndex === 0);
			expect(tabbableBefore).toHaveLength(1);

			// An arrow key dispatched on the toolbar container (not an action
			// button) has no resolvable action and must early-return without
			// moving focus or the roving tab stop.
			toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

			const tabbableAfter = Array.from(
				toolbar.querySelectorAll<HTMLButtonElement>('[data-toolbar-action]')
			).filter((button) => button.tabIndex === 0);
			expect(tabbableAfter).toHaveLength(1);
			expect(tabbableAfter[0]).toBe(tabbableBefore[0]);
		});

		it('no-ops arrow traversal when the focused action is no longer enabled', async () => {
			const view = await renderToolbar({ canUndo: true, canRedo: false });
			const undo = await page.getByLabelText('Undo').element();
			undo.focus();

			// Disable the focused button after it received focus. The roving
			// handler must not crash or move focus when the focused action is
			// absent from the visible-enabled list.
			await view.rerender({ canUndo: false, canRedo: false });
			undo.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

			const toolbar = await page.getByTestId('puzzle-toolbar').element();
			const tabbable = Array.from(
				toolbar.querySelectorAll<HTMLButtonElement>('[data-toolbar-action]')
			).filter((button) => button.tabIndex === 0);
			expect(tabbable).toHaveLength(1);
		});

		it('re-normalizes the roving tab stop when responsive visibility changes on resize', async () => {
			// The test viewport is below 1024px (compact layout): MORE is
			// visible, secondary actions are hidden behind the disclosure.
			renderToolbar({ canUndo: false, canRedo: false });
			const toolbar = await page.getByTestId('puzzle-toolbar').element();
			const moreButton = toolbar.querySelector<HTMLButtonElement>('[data-toolbar-action="more"]')!;

			// Arrow through the visible primary actions until MORE becomes the
			// active roving tab stop.
			const hint = await page.getByRole('button', { name: 'Hint' }).element();
			hint.focus();
			const actions = visibleEnabledActions();
			const moreIndex = actions.indexOf(moreButton);
			for (let index = 0; index < moreIndex; index += 1) {
				(document.activeElement as HTMLButtonElement).dispatchEvent(
					new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
				);
			}
			expect(document.activeElement).toBe(moreButton);
			await expect.poll(() => moreButton.tabIndex).toBe(0);

			// Simulate crossing into desktop layout: CSS hides MORE and reveals
			// the secondary actions. We hide MORE via inline style to emulate
			// the media-query-driven display:none, then fire resize so the
			// normalization effect re-runs.
			moreButton.style.display = 'none';

			window.dispatchEvent(new Event('resize'));

			// The effect should have re-normalized to a visible enabled action,
			// restoring the "exactly one visible enabled Tab stop" invariant.
			await expect
				.poll(() => {
					const tabbable = Array.from(
						toolbar.querySelectorAll<HTMLButtonElement>('[data-toolbar-action]')
					).filter(
						(button) => button.offsetParent !== null && !button.disabled && button.tabIndex === 0
					);
					return tabbable;
				})
				.toHaveLength(1);

			// MORE must no longer hold the roving tab stop — it is hidden.
			expect(moreButton.tabIndex).toBe(-1);
		});

		it('follows the desktop rail visual order across Undo -> Redo -> Fit -> Rotation', async () => {
			// The desktop rail order is produced by CSS `order` on buttons that
			// the puzzle route flattens into the rail via display:contents (the
			// .game-layout override in routes/puzzle/[id]/+page.svelte).
			// Replicate that context so traversal is checked against the
			// production visual order rather than DOM order — DOM order would
			// skip Redo after Undo.
			const host = document.createElement('div');
			host.className = 'game-layout';
			document.body.appendChild(host);
			const style = document.createElement('style');
			style.textContent =
				'.game-layout > .puzzle-toolbar .toolbar-secondary .toolbar-group { display: contents; }';
			document.head.appendChild(style);
			await page.viewport(1440, 900);
			try {
				render(PuzzleToolbar, {
					target: host,
					props: createToolbarProps({ canUndo: true, canRedo: true })
				});
				const undo = await page.getByRole('button', { name: 'Undo' }).element();
				const expectedOrder = [
					await page.getByRole('button', { name: 'Redo' }).element(),
					await page.getByRole('button', { name: 'Reset view' }).element(),
					await page.getByRole('button', { name: 'Rotation mode' }).element()
				];

				undo.focus();
				for (const next of expectedOrder) {
					(document.activeElement as HTMLButtonElement).dispatchEvent(
						new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
					);
					expect(document.activeElement).toBe(next);
				}
			} finally {
				await page.viewport(414, 896);
				style.remove();
				// host is the render target — vitest-browser-svelte's cleanup
				// removes it from document.body; removing it here would break
				// that bookkeeping.
			}
		});
	});

	describe('rendering', () => {
		it('renders the toolbar container', async () => {
			renderToolbar();

			await expect.element(page.getByTestId('puzzle-toolbar')).toBeInTheDocument();
		});

		it('renders all control buttons', async () => {
			renderToolbar();

			await expect.element(page.getByLabelText('Undo')).toBeInTheDocument();
			await expect.element(page.getByLabelText('Redo')).toBeInTheDocument();
			await expect.element(page.getByLabelText('Hint')).toBeInTheDocument();
			await expect.element(page.getByLabelText('Toggle reference')).toBeInTheDocument();
			await expect.element(page.getByLabelText('Hold to peek reference')).toBeInTheDocument();
			await expect.element(page.getByLabelText('Zoom out')).toBeInTheDocument();
			await expect.element(page.getByLabelText('Zoom in')).toBeInTheDocument();
			await expect.element(page.getByLabelText('Reset view')).toBeInTheDocument();
			await expect.element(page.getByLabelText('Rotation mode')).toBeInTheDocument();
		});
	});

	describe('sound toggle', () => {
		it('omits the sound toggle without a handler', async () => {
			renderToolbar();

			await expect.element(page.getByLabelText('Sound effects')).not.toBeInTheDocument();
		});

		it('reflects soundEnabled and calls onSoundToggle', async () => {
			const onSoundToggle = vi.fn();
			renderToolbar({ onSoundToggle, soundEnabled: false });
			await userEvent.click(page.getByLabelText('More puzzle actions'));

			const toggle = page.getByLabelText('Sound effects');
			await expect.element(toggle).toHaveAttribute('aria-pressed', 'false');
			await userEvent.click(toggle);

			expect(onSoundToggle).toHaveBeenCalledOnce();
		});
	});

	describe('undo/redo state', () => {
		it('disables undo button when canUndo is false', async () => {
			renderToolbar({ canUndo: false });

			await expect.element(page.getByLabelText('Undo')).toBeDisabled();
		});

		it('enables undo button when canUndo is true', async () => {
			renderToolbar({ canUndo: true });

			await expect.element(page.getByLabelText('Undo')).toBeEnabled();
		});

		it('disables redo button when canRedo is false', async () => {
			renderToolbar({ canRedo: false });

			await expect.element(page.getByLabelText('Redo')).toBeDisabled();
		});

		it('enables redo button when canRedo is true', async () => {
			renderToolbar({ canRedo: true });

			await expect.element(page.getByLabelText('Redo')).toBeEnabled();
		});
	});

	describe('rotation toggle', () => {
		it('shows rotation mode inactive when rotationEnabled is false', async () => {
			renderToolbar({ rotationEnabled: false });

			const toggleButton = page.getByLabelText('Rotation mode');
			await expect.element(toggleButton).toHaveAttribute('aria-pressed', 'false');
		});

		it('shows rotation mode active when rotationEnabled is true', async () => {
			renderToolbar({ rotationEnabled: true, rotationToggleDisabled: false });

			const toggleButton = page.getByLabelText('Rotation mode');
			await expect.element(toggleButton).toHaveAttribute('aria-pressed', 'true');
		});

		it('disables rotation mode when rotationToggleDisabled is true', async () => {
			renderToolbar({ rotationEnabled: true, rotationToggleDisabled: true });

			await expect.element(page.getByLabelText('Rotation mode')).toBeDisabled();
		});
	});

	describe('callbacks', () => {
		it('calls onUndo when undo button is clicked', async () => {
			const onUndo = vi.fn();
			renderToolbar({ onUndo, canUndo: true });

			await userEvent.click(page.getByLabelText('Undo'));
			expect(onUndo).toHaveBeenCalledOnce();
		});

		it('calls onRedo when redo button is clicked', async () => {
			const onRedo = vi.fn();
			renderToolbar({ onRedo, canRedo: true });

			await userEvent.click(page.getByLabelText('More puzzle actions'));
			await userEvent.click(page.getByLabelText('Redo'));
			expect(onRedo).toHaveBeenCalledOnce();
		});

		it('calls onHint when hint button is clicked', async () => {
			const onHint = vi.fn();
			renderToolbar({ onHint });

			await userEvent.click(page.getByLabelText('Hint'));
			expect(onHint).toHaveBeenCalledOnce();
		});

		it('calls onZoomIn when zoom in button is clicked', async () => {
			const onZoomIn = vi.fn();
			renderToolbar({ onZoomIn });

			// The unit surface is below 1024px, so secondary controls live
			// behind the compact More disclosure.
			await userEvent.click(page.getByLabelText('More puzzle actions'));
			await userEvent.click(page.getByLabelText('Zoom in'));
			expect(onZoomIn).toHaveBeenCalledOnce();
		});

		it('calls onZoomOut when zoom out button is clicked', async () => {
			const onZoomOut = vi.fn();
			renderToolbar({ onZoomOut });

			await userEvent.click(page.getByLabelText('More puzzle actions'));
			await userEvent.click(page.getByLabelText('Zoom out'));
			expect(onZoomOut).toHaveBeenCalledOnce();
		});

		it('calls onResetView when reset view button is clicked', async () => {
			const onResetView = vi.fn();
			renderToolbar({ onResetView });

			await userEvent.click(page.getByLabelText('More puzzle actions'));
			await userEvent.click(page.getByLabelText('Reset view'));
			expect(onResetView).toHaveBeenCalledOnce();
		});

		it('calls onRotationToggle when rotation mode button is clicked', async () => {
			const onRotationToggle = vi.fn();
			renderToolbar({ onRotationToggle });

			await userEvent.click(page.getByLabelText('More puzzle actions'));
			await userEvent.click(page.getByLabelText('Rotation mode'));
			expect(onRotationToggle).toHaveBeenCalledOnce();
		});

		it('calls onReferenceDown on peek button pointer down', async () => {
			const onReferenceDown = vi.fn();
			renderToolbar({ onReferenceDown });

			const peekButton = page.getByLabelText('Hold to peek reference');
			await peekButton.element().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
			expect(onReferenceDown).toHaveBeenCalledOnce();
		});

		it('calls onReferenceUp on peek button pointer up', async () => {
			const onReferenceUp = vi.fn();
			renderToolbar({ onReferenceUp });

			const peekButton = page.getByLabelText('Hold to peek reference');
			await peekButton.element().dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
			expect(onReferenceUp).toHaveBeenCalledOnce();
		});

		it('calls onReferenceUp on peek button pointer leave', async () => {
			const onReferenceUp = vi.fn();
			renderToolbar({ onReferenceUp });

			const peekButton = page.getByLabelText('Hold to peek reference');
			await peekButton.element().dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
			expect(onReferenceUp).toHaveBeenCalledOnce();
		});

		it('calls onReferenceDown/Up on peek button Space key press', async () => {
			const onReferenceDown = vi.fn();
			const onReferenceUp = vi.fn();
			renderToolbar({ onReferenceDown, onReferenceUp });

			const peekButton = page.getByLabelText('Hold to peek reference');
			await peekButton
				.element()
				.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
			expect(onReferenceDown).toHaveBeenCalledOnce();

			await peekButton
				.element()
				.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
			expect(onReferenceUp).toHaveBeenCalledOnce();
		});

		it('calls onReferenceDown/Up on peek button Enter key press', async () => {
			const onReferenceDown = vi.fn();
			const onReferenceUp = vi.fn();
			renderToolbar({ onReferenceDown, onReferenceUp });

			const peekButton = page.getByLabelText('Hold to peek reference');
			await peekButton
				.element()
				.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			expect(onReferenceDown).toHaveBeenCalledOnce();

			await peekButton
				.element()
				.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
			expect(onReferenceUp).toHaveBeenCalledOnce();
		});

		it('calls onReferenceUp when peek button loses focus during keyboard hold', async () => {
			const onReferenceDown = vi.fn();
			const onReferenceUp = vi.fn();
			renderToolbar({ onReferenceDown, onReferenceUp });

			const peekButton = page.getByLabelText('Hold to peek reference');
			await peekButton
				.element()
				.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
			expect(onReferenceDown).toHaveBeenCalledOnce();

			await peekButton.element().dispatchEvent(new FocusEvent('blur', { bubbles: true }));
			expect(onReferenceUp).toHaveBeenCalledOnce();
		});

		it('ignores non-Space/Enter keydown on the peek button', async () => {
			const onReferenceDown = vi.fn();
			renderToolbar({ onReferenceDown });

			const peekButton = page.getByLabelText('Hold to peek reference');
			await peekButton
				.element()
				.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
			expect(onReferenceDown).not.toHaveBeenCalled();
		});

		it('ignores non-Space/Enter keyup on the peek button', async () => {
			const onReferenceUp = vi.fn();
			renderToolbar({ onReferenceUp });

			const peekButton = page.getByLabelText('Hold to peek reference');
			await peekButton
				.element()
				.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
			expect(onReferenceUp).not.toHaveBeenCalled();
		});

		it('calls onReferenceToggle when toggle reference button is clicked', async () => {
			const onReferenceToggle = vi.fn();
			renderToolbar({ onReferenceToggle });

			await userEvent.click(page.getByLabelText('Toggle reference'));
			expect(onReferenceToggle).toHaveBeenCalledOnce();
		});
	});

	describe('hasReference gating', () => {
		it('shows reference actions when hasReference is true', async () => {
			renderToolbar({ hasReference: true });

			await expect.element(page.getByLabelText('Toggle reference')).toBeInTheDocument();
			await expect.element(page.getByLabelText('Hold to peek reference')).toBeInTheDocument();
		});

		it('hides reference actions when hasReference is false', async () => {
			renderToolbar({ hasReference: false });

			await expect.poll(() => page.getByLabelText('Toggle reference').query()).toBeNull();
			await expect.poll(() => page.getByLabelText('Hold to peek reference').query()).toBeNull();
		});

		it('shows reference actions by default when hasReference is not provided', async () => {
			renderToolbar();

			await expect.element(page.getByLabelText('Toggle reference')).toBeInTheDocument();
			await expect.element(page.getByLabelText('Hold to peek reference')).toBeInTheDocument();
		});
	});

	describe('reference availability', () => {
		it('reflects referenceToggled on the toggle reference aria-pressed state', async () => {
			renderToolbar({ referenceToggled: true });

			await expect
				.element(page.getByLabelText('Toggle reference'))
				.toHaveAttribute('aria-pressed', 'true');
		});

		it('disables peek while reference is toggled on', async () => {
			renderToolbar({ referenceToggled: true });

			await expect.element(page.getByLabelText('Hold to peek reference')).toBeDisabled();
			// The persistent toggle itself stays enabled so it can be turned off.
			await expect.element(page.getByLabelText('Toggle reference')).toBeEnabled();
		});

		it('disables both reference actions when no reference URL is available', async () => {
			renderToolbar({ referenceAvailable: false });

			await expect.element(page.getByLabelText('Toggle reference')).toBeDisabled();
			await expect.element(page.getByLabelText('Hold to peek reference')).toBeDisabled();
		});

		it('attaches the shared scoring description to Hint, Peek, and Toggle reference', async () => {
			renderToolbar();

			for (const label of ['Hint', 'Hold to peek reference', 'Toggle reference']) {
				await expect
					.element(page.getByLabelText(label))
					.toHaveAttribute('aria-describedby', 'assistance-scoring-help');
			}
			await expect
				.element(page.getByText('Hint affects timed results. Peek and Reference do not.'))
				.toBeInTheDocument();
		});
	});

	describe('canPause gating', () => {
		it('shows Pause button when canPause is true', async () => {
			renderToolbar({ canPause: true });

			await expect.element(page.getByLabelText('Pause mission')).toBeInTheDocument();
		});

		it('hides Pause button when canPause is false', async () => {
			renderToolbar({ canPause: false });

			await expect.poll(() => page.getByLabelText('Pause mission').query()).toBeNull();
		});

		it('hides Pause button by default when canPause is not provided', async () => {
			renderToolbar();

			await expect.poll(() => page.getByLabelText('Pause mission').query()).toBeNull();
		});
	});

	it('shows Setup when canOpenSetup is true', async () => {
		renderToolbar({ canOpenSetup: true });
		await expect.element(page.getByLabelText('Open mission setup')).toBeInTheDocument();
	});

	it('hides Setup when canOpenSetup is false', async () => {
		renderToolbar({ canOpenSetup: false });
		await expect.poll(() => page.getByLabelText('Open mission setup').query()).toBeNull();
	});

	it('toggles the secondary controls through More with explicit DOM state', async () => {
		renderToolbar({ canPause: true, canOpenSetup: true });

		const more = page.getByLabelText('More puzzle actions');
		const secondary = page.getByTestId('puzzle-toolbar-secondary');

		const tabbableActions = () => {
			const toolbar = page.getByTestId('puzzle-toolbar').element();
			return Array.from(
				toolbar.querySelectorAll<HTMLButtonElement>('[data-toolbar-action]')
			).filter(
				(button) => button.offsetParent !== null && !button.disabled && button.tabIndex === 0
			);
		};

		await expect.element(more).toHaveAttribute('aria-expanded', 'false');
		await expect.element(secondary).toHaveAttribute('data-open', 'false');
		expect(tabbableActions()).toHaveLength(1);

		(more.element() as HTMLButtonElement).click();
		await expect.element(more).toHaveAttribute('aria-expanded', 'true');
		await expect.element(secondary).toHaveAttribute('data-open', 'true');
		expect(tabbableActions()).toHaveLength(1);

		(more.element() as HTMLButtonElement).click();
		await expect.element(more).toHaveAttribute('aria-expanded', 'false');
		await expect.element(secondary).toHaveAttribute('data-open', 'false');
		expect(tabbableActions()).toHaveLength(1);
	});

	describe('secondary action labels', () => {
		// [aria-label, visible label] — the label must remain a substring of
		// the unchanged accessible name for axe label-content-name-mismatch.
		const labeledActions: Array<[string, string]> = [
			['Redo', 'Redo'],
			['Zoom out', 'Zoom out'],
			['Zoom in', 'Zoom in'],
			['Rotation mode', 'Rotation mode'],
			['Sound effects', 'Sound effects'],
			['Hold to peek reference', 'Hold to peek'],
			['Open family leaderboard', 'Leaderboard'],
			['Open mission setup', 'Mission setup']
		];

		async function openMore() {
			(page.getByLabelText('More puzzle actions').element() as HTMLButtonElement).click();
			await expect
				.element(page.getByTestId('puzzle-toolbar-secondary'))
				.toHaveAttribute('data-open', 'true');
		}

		it('renders a label inside each secondary action that stays within its accessible name', async () => {
			renderToolbar({ onSoundToggle: vi.fn(), canOpenLeaderboard: true, canOpenSetup: true });
			await openMore();

			for (const [accessibleName, labelText] of labeledActions) {
				const button = await page.getByLabelText(accessibleName).element();
				const label = button.querySelector<HTMLElement>('.toolbar-action-label');
				expect(label, `${accessibleName} label`).not.toBeNull();
				expect(label!.textContent?.trim()).toBe(labelText);
				expect(accessibleName.toLowerCase()).toContain(labelText.toLowerCase());
				expect(label!.checkVisibility(), `${accessibleName} label visible`).toBe(true);
			}
		});

		it('hides secondary action labels while More is closed on the desktop rail', async () => {
			await page.viewport(1440, 900);
			try {
				renderToolbar({
					canRedo: true,
					onSoundToggle: vi.fn(),
					canOpenLeaderboard: true,
					canOpenSetup: true
				});

				// On desktop (>=1024px) .toolbar-secondary[data-open='false'] is
				// display:contents, so Redo and Rotation mode are visible in the
				// closed rail while their text labels must stay hidden.
				for (const railButtonName of ['Redo', 'Rotation mode']) {
					const railButton = await page.getByLabelText(railButtonName).element();
					expect(railButton.checkVisibility(), `${railButtonName} rail button visible`).toBe(true);
				}

				for (const [accessibleName] of labeledActions) {
					const button = await page.getByLabelText(accessibleName).element();
					const label = button.querySelector<HTMLElement>('.toolbar-action-label');
					expect(label, `${accessibleName} label`).not.toBeNull();
					expect(label!.checkVisibility(), `${accessibleName} label hidden`).toBe(false);
				}
			} finally {
				await page.viewport(414, 896);
			}
		});

		it('disables text selection on press-and-hold toolbar buttons and labels', async () => {
			renderToolbar();
			await openMore();

			const peekButton = await page.getByLabelText('Hold to peek reference').element();
			const peekLabel = peekButton.querySelector<HTMLElement>('.toolbar-action-label');
			expect(peekLabel).not.toBeNull();
			expect(getComputedStyle(peekButton).userSelect).toBe('none');
			expect(getComputedStyle(peekLabel!).userSelect).toBe('none');
		});

		it('does not label primary rail actions', async () => {
			renderToolbar();
			await openMore();

			for (const name of ['Hint', 'Toggle reference', 'Undo', 'Reset view']) {
				const button = await page.getByLabelText(name).element();
				expect(button.querySelector('.toolbar-action-label')).toBeNull();
			}
		});

		it('sets compact open labels in the mono font on wrapping flexible-height buttons', async () => {
			// layout.css is not loaded for the isolated component render, so
			// inject sentinel families to prove which custom property is used.
			const style = document.createElement('style');
			style.textContent =
				':root { --font-mono: SentinelMono, monospace; --font-display: SentinelDisplay, serif; }';
			document.head.appendChild(style);
			try {
				renderToolbar();
				await openMore();

				const button = await page.getByLabelText('Rotation mode').element();
				const label = button.querySelector<HTMLElement>('.toolbar-action-label');
				expect(label).not.toBeNull();
				expect(getComputedStyle(label!).fontFamily.toLowerCase()).toContain('sentinelmono');
				expect(getComputedStyle(button).whiteSpace).toBe('normal');
			} finally {
				style.remove();
			}
		});

		it('moves roving focus into the open More panel with ArrowRight', async () => {
			renderToolbar({ canRedo: true });
			await openMore();

			const more = (await page
				.getByLabelText('More puzzle actions')
				.element()) as HTMLButtonElement;
			const redo = await page.getByRole('button', { name: 'Redo' }).element();

			more.focus();
			more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

			expect(document.activeElement).toBe(redo);
		});
	});

	describe('rotation lock explanation', () => {
		async function openMore() {
			(page.getByLabelText('More puzzle actions').element() as HTMLButtonElement).click();
			await expect
				.element(page.getByTestId('puzzle-toolbar-secondary'))
				.toHaveAttribute('data-open', 'true');
		}

		it('explains that unplaced pieces can still rotate when rotation stays enabled', async () => {
			renderToolbar({ rotationEnabled: true, rotationToggleDisabled: true });
			await openMore();

			const reason = document.getElementById('rotation-lock-reason');
			expect(reason).not.toBeNull();
			expect(reason!.textContent?.trim()).toBe(
				'Rotation mode is locked after the first placement; you can still rotate unplaced pieces.'
			);
			expect(reason!.checkVisibility()).toBe(true);
		});

		it('explains that rotation is unavailable when rotation is disabled', async () => {
			renderToolbar({ rotationEnabled: false, rotationToggleDisabled: true });
			await openMore();

			const reason = document.getElementById('rotation-lock-reason');
			expect(reason!.textContent?.trim()).toBe(
				'Rotation mode is locked after the first placement; piece rotation is unavailable in this run.'
			);
			expect(reason!.checkVisibility()).toBe(true);
		});

		it('stays attached to the disabled rotation button as sr-only while More is closed and unclips when open', async () => {
			await page.viewport(1440, 900);
			try {
				renderToolbar({ rotationEnabled: true, rotationToggleDisabled: true });

				const rotation = await page.getByLabelText('Rotation mode').element();
				expect(rotation.getAttribute('aria-describedby')).toBe('rotation-lock-reason');
				// The sr-only reference still resolves as the button's description —
				// the clip checks below verify presentation, not what AT receives.
				await expect
					.element(page.getByLabelText('Rotation mode'))
					.toHaveAccessibleDescription(
						'Rotation mode is locked after the first placement; you can still rotate unplaced pieces.'
					);

				const secondary = await page.getByTestId('puzzle-toolbar-secondary').element();
				const reason = document.getElementById('rotation-lock-reason');
				expect(reason).not.toBeNull();
				expect(secondary.contains(reason)).toBe(true);

				// On the closed desktop rail, #rotation-lock-reason stays in the
				// accessibility tree via sr-only rules instead of display:none.
				const closedStyle = getComputedStyle(reason!);
				expect(closedStyle.display).not.toBe('none');
				expect(closedStyle.position).toBe('absolute');
				expect(closedStyle.width).toBe('1px');
				expect(closedStyle.height).toBe('1px');

				await openMore();
				const openStyle = getComputedStyle(reason!);
				expect(openStyle.position).toBe('static');
				expect(reason!.getBoundingClientRect().height).toBeGreaterThan(1);
			} finally {
				await page.viewport(414, 896);
			}
		});
	});

	it('keeps the compact More panel a single scrollable column', async () => {
		renderToolbar();
		(page.getByLabelText('More puzzle actions').element() as HTMLButtonElement).click();
		const secondary = await page.getByTestId('puzzle-toolbar-secondary').element();

		const style = getComputedStyle(secondary);
		expect(style.flexDirection).toBe('column');
		expect(style.flexWrap).toBe('nowrap');
		expect(style.overflowY).toBe('auto');
	});

	it('lets players scroll to the last More action on a short screen', async () => {
		await page.viewport(414, 320);
		try {
			renderToolbar({
				onSoundToggle: vi.fn(),
				onOpenLeaderboard: vi.fn(),
				canOpenLeaderboard: true,
				onOpenSetup: vi.fn(),
				canOpenSetup: true,
				rotationToggleDisabled: true
			});
			(page.getByLabelText('More puzzle actions').element() as HTMLButtonElement).click();
			const secondary = await page.getByTestId('puzzle-toolbar-secondary').element();

			// Forced overflow — without it the reachability check below proves nothing.
			expect(secondary.scrollHeight).toBeGreaterThan(secondary.clientHeight);
			expect(secondary.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight + 1);

			secondary.scrollTop = secondary.scrollHeight;
			const panelRect = secondary.getBoundingClientRect();
			const lastAction = secondary.querySelector<HTMLElement>('[data-toolbar-action="setup"]');
			const lockReason = secondary.querySelector<HTMLElement>('#rotation-lock-reason');
			expect(lastAction).not.toBeNull();
			expect(lockReason).not.toBeNull();
			for (const el of [lastAction!, lockReason!]) {
				const rect = el.getBoundingClientRect();
				expect(rect.top).toBeGreaterThanOrEqual(panelRect.top);
				expect(rect.bottom).toBeLessThanOrEqual(panelRect.bottom + 1);
			}
		} finally {
			await page.viewport(414, 896);
		}
	});

	it('keeps a secondary callback wired through the compact container', async () => {
		const onZoomIn = vi.fn();
		renderToolbar({ onZoomIn });

		(page.getByLabelText('More puzzle actions').element() as HTMLButtonElement).click();
		const secondary = page.getByTestId('puzzle-toolbar-secondary').element();
		const zoomIn = secondary.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]');

		expect(zoomIn).not.toBeNull();
		zoomIn!.click();
		expect(onZoomIn).toHaveBeenCalledOnce();
	});
});
