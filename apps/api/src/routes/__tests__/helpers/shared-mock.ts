import { vi } from 'vitest';

/**
 * Shared mock overrides for @perseus/shared used by admin worker test files.
 * Each test file imports this and spreads it into its inline vi.mock factory:
 *
 *   import { sharedMockOverrides } from './helpers/shared-mock';
 *   vi.mock('@perseus/shared', async (importOriginal) => {
 *       const original = await importOriginal<typeof import('@perseus/shared')>();
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
