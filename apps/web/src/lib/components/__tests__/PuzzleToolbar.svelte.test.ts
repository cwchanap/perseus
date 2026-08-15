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

function renderToolbar(overrides: Parameters<typeof createToolbarProps>[0] = {}) {
	return render(PuzzleToolbar, createToolbarProps(overrides));
}

describe('PuzzleToolbar', () => {
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

		await expect.element(more).toHaveAttribute('aria-expanded', 'false');
		await expect.element(secondary).toHaveAttribute('data-open', 'false');

		(more.element() as HTMLButtonElement).click();
		await expect.element(more).toHaveAttribute('aria-expanded', 'true');
		await expect.element(secondary).toHaveAttribute('data-open', 'true');

		(more.element() as HTMLButtonElement).click();
		await expect.element(more).toHaveAttribute('aria-expanded', 'false');
		await expect.element(secondary).toHaveAttribute('data-open', 'false');
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
