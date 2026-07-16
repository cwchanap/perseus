import { vi } from 'vitest';

/**
 * Shared mock overrides for @perseus/shared used by admin worker test files.
 * Each test file dynamically imports this inside its vi.mock factory so the
 * helper is not accessed before mock initialization:
 *
 *   vi.mock('@perseus/shared', async (importOriginal) => {
 *       const original = await importOriginal<typeof import('@perseus/shared')>();
 *       const { sharedMockOverrides } = await import('./helpers/shared-mock');
 *       return { ...original, ...sharedMockOverrides };
 *   });
 *
 * The overrides replace the D1 ownership/stats functions with no-op mocks so
 * tests don't bind a real D1 session. Original exports (detectImageType,
 * parseImageDimensions, etc.) are preserved by the spread in each factory.
 */
export const sharedMockOverrides = {
	insertPuzzleOwnership: vi.fn().mockResolvedValue(undefined),
	deletePuzzleOwnership: vi.fn().mockResolvedValue(undefined),
	deletePuzzleStats: vi.fn().mockResolvedValue(undefined),
	SYSTEM_OWNER_ID: 'system'
};
