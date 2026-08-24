import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		include: ['src/**/*.test.ts'],
		expect: { requireAssertions: true },
		coverage: {
			provider: 'v8',
			reporter: ['lcov', 'text', 'html'],
			reportsDirectory: './coverage'
		}
	}
});
