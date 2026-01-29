import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		include: ['src/**/*.test.ts'],
		exclude: ['src/__tests__/**'] // Exclude old bun:test based tests
	}
});
