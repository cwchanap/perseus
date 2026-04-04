import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import PuzzleToolbar from '../PuzzleToolbar.svelte';

describe('PuzzleToolbar', () => {
	describe('rendering', () => {
		it('renders the toolbar container', async () => {
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: false,
				rotationToggleDisabled: false
			});

			await expect.element(page.getByTestId('puzzle-toolbar')).toBeInTheDocument();
		});

		it('renders all control buttons', async () => {
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: false,
				rotationToggleDisabled: false
			});

			await expect.element(page.getByLabelText('Undo')).toBeInTheDocument();
			await expect.element(page.getByLabelText('Redo')).toBeInTheDocument();
			await expect.element(page.getByLabelText('Hint')).toBeInTheDocument();
			await expect.element(page.getByLabelText('Reference')).toBeInTheDocument();
			await expect.element(page.getByLabelText('Zoom out')).toBeInTheDocument();
			await expect.element(page.getByLabelText('Zoom in')).toBeInTheDocument();
			await expect.element(page.getByLabelText('Reset view')).toBeInTheDocument();
			await expect.element(page.getByLabelText('Rotation mode')).toBeInTheDocument();
		});
	});

	describe('undo/redo state', () => {
		it('disables undo button when canUndo is false', async () => {
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: false,
				rotationToggleDisabled: false
			});

			await expect.element(page.getByLabelText('Undo')).toBeDisabled();
		});

		it('enables undo button when canUndo is true', async () => {
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: true,
				canRedo: false,
				rotationEnabled: false
			});

			await expect.element(page.getByLabelText('Undo')).toBeEnabled();
		});

		it('disables redo button when canRedo is false', async () => {
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: false,
				rotationToggleDisabled: false
			});

			await expect.element(page.getByLabelText('Redo')).toBeDisabled();
		});

		it('enables redo button when canRedo is true', async () => {
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: true,
				rotationEnabled: false
			});

			await expect.element(page.getByLabelText('Redo')).toBeEnabled();
		});
	});

	describe('rotation toggle', () => {
		it('shows rotation mode inactive when rotationEnabled is false', async () => {
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: false
			});

			const toggleButton = page.getByLabelText('Rotation mode');
			await expect.element(toggleButton).toHaveAttribute('aria-pressed', 'false');
		});

		it('shows rotation mode active when rotationEnabled is true', async () => {
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: true,
				rotationToggleDisabled: false
			});

			const toggleButton = page.getByLabelText('Rotation mode');
			await expect.element(toggleButton).toHaveAttribute('aria-pressed', 'true');
		});

		it('disables rotation mode when rotationToggleDisabled is true', async () => {
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: true,
				rotationToggleDisabled: true
			});

			await expect.element(page.getByLabelText('Rotation mode')).toBeDisabled();
		});
	});

	describe('callbacks', () => {
		it('calls onUndo when undo button is clicked', async () => {
			const onUndo = vi.fn();
			render(PuzzleToolbar, {
				onUndo,
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: true,
				canRedo: false,
				rotationEnabled: false
			});

			await userEvent.click(page.getByLabelText('Undo'));
			expect(onUndo).toHaveBeenCalledOnce();
		});

		it('calls onRedo when redo button is clicked', async () => {
			const onRedo = vi.fn();
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo,
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: true,
				rotationEnabled: false
			});

			await userEvent.click(page.getByLabelText('Redo'));
			expect(onRedo).toHaveBeenCalledOnce();
		});

		it('calls onHint when hint button is clicked', async () => {
			const onHint = vi.fn();
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint,
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: false
			});

			await userEvent.click(page.getByLabelText('Hint'));
			expect(onHint).toHaveBeenCalledOnce();
		});

		it('calls onZoomIn when zoom in button is clicked', async () => {
			const onZoomIn = vi.fn();
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn,
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: false
			});

			await userEvent.click(page.getByLabelText('Zoom in'));
			expect(onZoomIn).toHaveBeenCalledOnce();
		});

		it('calls onZoomOut when zoom out button is clicked', async () => {
			const onZoomOut = vi.fn();
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut,
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: false
			});

			await userEvent.click(page.getByLabelText('Zoom out'));
			expect(onZoomOut).toHaveBeenCalledOnce();
		});

		it('calls onResetView when reset view button is clicked', async () => {
			const onResetView = vi.fn();
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView,
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: false
			});

			await userEvent.click(page.getByLabelText('Reset view'));
			expect(onResetView).toHaveBeenCalledOnce();
		});

		it('calls onRotationToggle when rotation mode button is clicked', async () => {
			const onRotationToggle = vi.fn();
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle,
				canUndo: false,
				canRedo: false,
				rotationEnabled: false
			});

			await userEvent.click(page.getByLabelText('Rotation mode'));
			expect(onRotationToggle).toHaveBeenCalledOnce();
		});

		it('calls onReferenceDown on reference button pointer down', async () => {
			const onReferenceDown = vi.fn();
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown,
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: false
			});

			const refButton = page.getByLabelText('Reference');
			await refButton.element().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
			expect(onReferenceDown).toHaveBeenCalledOnce();
		});

		it('calls onReferenceUp on reference button pointer up', async () => {
			const onReferenceUp = vi.fn();
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp,
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: false
			});

			const refButton = page.getByLabelText('Reference');
			await refButton.element().dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
			expect(onReferenceUp).toHaveBeenCalledOnce();
		});

		it('calls onReferenceUp on reference button pointer leave', async () => {
			const onReferenceUp = vi.fn();
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp,
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: false
			});

			const refButton = page.getByLabelText('Reference');
			await refButton.element().dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
			expect(onReferenceUp).toHaveBeenCalledOnce();
		});

		it('calls onReferenceDown/Up on reference button Space key press', async () => {
			const onReferenceDown = vi.fn();
			const onReferenceUp = vi.fn();
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown,
				onReferenceUp,
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: false
			});

			const refButton = page.getByLabelText('Reference');
			await refButton
				.element()
				.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
			expect(onReferenceDown).toHaveBeenCalledOnce();

			await refButton
				.element()
				.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
			expect(onReferenceUp).toHaveBeenCalledOnce();
		});

		it('calls onReferenceDown/Up on reference button Enter key press', async () => {
			const onReferenceDown = vi.fn();
			const onReferenceUp = vi.fn();
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown,
				onReferenceUp,
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: false
			});

			const refButton = page.getByLabelText('Reference');
			await refButton
				.element()
				.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			expect(onReferenceDown).toHaveBeenCalledOnce();

			await refButton
				.element()
				.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
			expect(onReferenceUp).toHaveBeenCalledOnce();
		});
	});

	describe('hasReference gating', () => {
		it('shows Reference button when hasReference is true', async () => {
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: false,
				hasReference: true
			});

			await expect.element(page.getByLabelText('Reference')).toBeInTheDocument();
		});

		it('hides Reference button when hasReference is false', async () => {
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: false,
				hasReference: false
			});

			await expect.element(page.getByLabelText('Reference')).not.toBeInTheDocument();
		});

		it('shows Reference button by default when hasReference is not provided', async () => {
			render(PuzzleToolbar, {
				onUndo: vi.fn(),
				onRedo: vi.fn(),
				onHint: vi.fn(),
				onReferenceDown: vi.fn(),
				onReferenceUp: vi.fn(),
				onZoomIn: vi.fn(),
				onZoomOut: vi.fn(),
				onResetView: vi.fn(),
				onRotationToggle: vi.fn(),
				canUndo: false,
				canRedo: false,
				rotationEnabled: false
			});

			await expect.element(page.getByLabelText('Reference')).toBeInTheDocument();
		});
	});
});
