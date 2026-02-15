import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		include: ['src/**/*.test.ts'],
		exclude: ['src/__tests__/puzzles.test.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['lcov', 'text', 'html'],
			reportsDirectory: './coverage'
		}
	}
});
