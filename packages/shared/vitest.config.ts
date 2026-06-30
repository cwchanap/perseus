import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Miniflare spawns a workerd subprocess for D1, which needs more time
		// than the default 5s timeout during startup.
		testTimeout: 30_000,
		hookTimeout: 30_000
	}
});
