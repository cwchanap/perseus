// Component test for PuzzleCard
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleCard from '../PuzzleCard.svelte';
import { getThumbnailUrl } from '$lib/services/api';
import { getBestTime } from '$lib/services/stats';
import type { PuzzleSummary } from '$lib/types/puzzle';

vi.mock('$lib/services/stats', () => ({
	getBestTime: vi.fn().mockReturnValue(null)
}));

describe('PuzzleCard', () => {
	const mockPuzzle: PuzzleSummary = {
		id: 'test-puzzle-123',
		name: 'Test Puzzle',
		pieceCount: 25,
		status: 'ready'
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getBestTime).mockReturnValue(null);
	});

	it('should render puzzle name', async () => {
		render(PuzzleCard, { puzzle: mockPuzzle });

		await expect.element(page.getByText('Test Puzzle')).toBeVisible();
	});

	it('keeps the normal piece count without progress', async () => {
		render(PuzzleCard, { puzzle: mockPuzzle });

		await expect.element(page.getByText('25 PCS')).toBeVisible();
	});

	it('shows always-visible Continue progress for a resumable card', async () => {
		render(PuzzleCard, { puzzle: mockPuzzle, placedCount: 7 });

		await expect.element(page.getByText('CONTINUE · 7/25 PLACED')).toBeVisible();
		await expect
			.element(page.getByTestId('puzzle-card'))
			.toHaveAttribute('href', '/puzzle/test-puzzle-123');
	});

	it('should link to puzzle page', async () => {
		render(PuzzleCard, { puzzle: mockPuzzle });

		const link = page.getByTestId('puzzle-card');
		await expect.element(link).toHaveAttribute('href', '/puzzle/test-puzzle-123');
	});

	it('should render thumbnail image with correct alt text', async () => {
		render(PuzzleCard, { puzzle: mockPuzzle });

		const img = page.getByRole('img');
		await expect.element(img).toHaveAttribute('alt', 'Test Puzzle');
		await expect.element(img).toHaveAttribute('src', getThumbnailUrl(mockPuzzle.id));
	});

	it('should mark overlay play label as decorative', async () => {
		render(PuzzleCard, { puzzle: mockPuzzle });

		const overlay = page.getByTestId('card-overlay');
		await expect.element(overlay).toHaveAttribute('aria-hidden', 'true');
	});

	it('should not show best time badge when no best time exists', async () => {
		vi.mocked(getBestTime).mockReturnValue(null);
		render(PuzzleCard, { puzzle: mockPuzzle });

		const bestTimeBadge = page.getByTestId('card-best-time');
		await expect.element(bestTimeBadge).not.toBeInTheDocument();
	});

	it('should display best time when a personal best exists', async () => {
		vi.mocked(getBestTime).mockReturnValue(125); // 02:05
		render(PuzzleCard, { puzzle: mockPuzzle });

		const bestTimeBadge = page.getByTestId('card-best-time');
		await expect.element(bestTimeBadge).toBeVisible();
		await expect.element(page.getByText('◆ 02:05')).toBeVisible();
	});

	it('should render category badge when puzzle has a category', async () => {
		const puzzleWithCategory: PuzzleSummary = {
			...mockPuzzle,
			category: 'Animals'
		};
		render(PuzzleCard, { puzzle: puzzleWithCategory });

		const badge = page.getByTestId('category-badge');
		await expect.element(badge).toBeVisible();
		await expect.element(badge).toHaveTextContent('Animals');
	});

	it('should not render category badge when puzzle has no category', async () => {
		render(PuzzleCard, { puzzle: mockPuzzle });

		const badge = page.getByTestId('category-badge');
		await expect.element(badge).not.toBeInTheDocument();
	});

	it('should render a non-clickable card with status overlay for processing puzzles', async () => {
		const processingPuzzle: PuzzleSummary = {
			...mockPuzzle,
			status: 'processing'
		};
		render(PuzzleCard, { puzzle: processingPuzzle });

		const card = page.getByTestId('puzzle-card');
		await expect.element(card).not.toHaveAttribute('href');
		await expect.element(page.getByTestId('card-status-overlay')).toBeVisible();
		await expect.element(page.getByTestId('card-overlay')).not.toBeInTheDocument();
	});

	it('does not expose Continue progress for non-ready cards', async () => {
		render(PuzzleCard, {
			puzzle: { ...mockPuzzle, status: 'processing' },
			placedCount: 7
		});

		await expect.element(page.getByText(/CONTINUE/)).not.toBeInTheDocument();
	});

	it('should render a non-clickable card with FAILED label for failed puzzles', async () => {
		const failedPuzzle: PuzzleSummary = {
			...mockPuzzle,
			status: 'failed'
		};
		render(PuzzleCard, { puzzle: failedPuzzle });

		const card = page.getByTestId('puzzle-card');
		await expect.element(card).not.toHaveAttribute('href');
		await expect.element(page.getByTestId('card-status-overlay')).toBeVisible();
		await expect.element(page.getByText('FAILED')).toBeVisible();
	});

	it('skips DOM update for unchanged progress text on re-render', async () => {
		const view = render(PuzzleCard, { puzzle: mockPuzzle, placedCount: 7 });
		await expect.element(page.getByText('CONTINUE · 7/25 PLACED')).toBeVisible();

		// Re-render with the same placedCount but a different puzzle name.
		// Svelte's compiled text-interpolation guard sees the value hasn't
		// changed and skips the DOM write — exercising the "no-change" branch.
		await view.rerender({ puzzle: { ...mockPuzzle, name: 'Updated' }, placedCount: 7 });
		await expect.element(page.getByText('CONTINUE · 7/25 PLACED')).toBeVisible();
		await expect.element(page.getByText('Updated')).toBeVisible();
	});

	it('skips DOM update for unchanged piece-count text on re-render', async () => {
		const view = render(PuzzleCard, { puzzle: mockPuzzle });
		await expect.element(page.getByText('25 PCS')).toBeVisible();

		// Re-render with the same pieceCount but a different puzzle name.
		await view.rerender({ puzzle: { ...mockPuzzle, name: 'Renamed' } });
		await expect.element(page.getByText('25 PCS')).toBeVisible();
		await expect.element(page.getByText('Renamed')).toBeVisible();
	});

	it('renders empty fallback when placedCount is null in progress text', async () => {
		// Svelte 5 compiles {placedCount} and {puzzle.pieceCount} with ?? '' null
		// guards. null !== undefined is true, so hasProgress is still true and the
		// if-true branch renders — but both ?? '' fallbacks fire.
		render(PuzzleCard, {
			puzzle: { ...mockPuzzle, pieceCount: null as unknown as number },
			placedCount: null as unknown as number
		});

		await expect.element(page.getByText('CONTINUE · / PLACED')).toBeVisible();
	});

	it('renders empty fallback when pieceCount is null in non-progress text', async () => {
		// Exercise the ?? '' null guard on puzzle.pieceCount in the else branch.
		render(PuzzleCard, {
			puzzle: { ...mockPuzzle, pieceCount: null as unknown as number }
		});

		await expect.element(page.getByText(/^\s*PCS$/)).toBeVisible();
	});
});
