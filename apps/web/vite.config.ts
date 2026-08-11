import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import { gameplayRuntimeOverridePlugin } from './vite-plugins/gameplay-runtime-override-plugin';

// Captured when the config is created. An already-running Vitest process does
// not switch modes after environment mutation, so this is read at module-eval.
const harnessEnabled = process.env.PERSEUS_E2E_HARNESS === '1';

export default defineConfig({
	plugins: [
		gameplayRuntimeOverridePlugin({
			harnessEnabled,
			readerPath: harnessEnabled ? '/src/lib/testing/e2e-gameplay-runtime' : undefined
		}),
		tailwindcss(),
		sveltekit()
	],

	test: {
		expect: { requireAssertions: true },
		setupFiles: ['vitest-browser-svelte', 'src/vitest.setup.ts'],
		browser: {
			enabled: true,
			provider: playwright(),
			screenshotFailures: true,
			screenshotDirectory: 'test-artifacts/screenshots',
			instances: [{ browser: 'chromium', headless: true }]
		},
		include: ['src/**/*.{test,spec}.{js,ts}', 'src/**/*.svelte.{test,spec}.{js,ts}'],
		exclude: ['src/lib/server/**'],
		coverage: {
			provider: 'v8',
			reporter: ['lcov', 'text', 'html'],
			reportsDirectory: './coverage',
			exclude: ['**/*.svg', '**/*.css']
		}
	}
});
