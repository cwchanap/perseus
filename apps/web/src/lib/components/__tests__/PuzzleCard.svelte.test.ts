// Component test for PuzzleCard
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from '@vitest/browser/context';
import PuzzleCard from '../PuzzleCard.svelte';
import { getThumbnailUrl } from '$lib/services/api';
import type { PuzzleSummary } from '$lib/types/puzzle';

describe('PuzzleCard', () => {
  const mockPuzzle: PuzzleSummary = {
    id: 'test-puzzle-123',
    name: 'Test Puzzle',
    pieceCount: 25,
    thumbnailUrl: '/api/puzzles/test-puzzle-123/thumbnail'
  };

  it('should render puzzle name', async () => {
    render(PuzzleCard, { puzzle: mockPuzzle });

    await expect.element(page.getByText('Test Puzzle')).toBeVisible();
  });

  it('should render piece count', async () => {
    render(PuzzleCard, { puzzle: mockPuzzle });

    await expect.element(page.getByText('25 pieces')).toBeVisible();
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
});
