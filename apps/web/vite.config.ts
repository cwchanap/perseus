import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { gameplayRuntimeOverridePlugin } from './vite-plugins/gameplay-runtime-override-plugin.ts';

// Captured when the config is created. An already-running Vitest process does
// not switch modes after environment mutation, so this is read at module-eval.
const harnessEnabled = process.env.PERSEUS_E2E_HARNESS === '1';

export default defineConfig({
	// Compile-time harness flag: dead-code-eliminated to `false` in prod/unit builds.
	define: { __PERSEUS_E2E_HARNESS__: JSON.stringify(harnessEnabled) },
	plugins: [
		gameplayRuntimeOverridePlugin({
			harnessEnabled,
			readerPath: harnessEnabled ? '/src/lib/testing/e2e-gameplay-runtime' : undefined
		}),
		tailwindcss(),
		sveltekit({
			// Consult https://svelte.dev/docs/kit/integrations
			// for more information about preprocessors
			preprocess: vitePreprocess(),
			// Static hosting SPA fallback.
			// Some static hosts (e.g. Surge) expect a `200.html` fallback for client-side routing.
			adapter: adapter({ fallback: '200.html' }),
			// shortcut: kit 3 removed $lib for #lib; keep the $lib alias until the
			// ~260 usages migrate to #lib, then delete this line
			alias: { $lib: 'src/lib' }
		})
	],

	// @testing-library/svelte-core (via vitest-browser-svelte v3) ships raw
	// .svelte sources: keep it out of esbuild prebundling and let the Svelte
	// plugin compile it.
	ssr: {
		noExternal: ['@testing-library/svelte-core']
	},
	optimizeDeps: {
		exclude: ['@testing-library/svelte-core']
	},

	test: {
		expect: { requireAssertions: true },
		setupFiles: ['vitest-browser-svelte', 'src/vitest.setup.ts'],
		browser: {
			enabled: true,
			provider: playwright(),
			// v4 semantics: locator strings match substrings. Tests rely on it
			// (e.g. getByLabel('Puzzle piece 1') vs 'Puzzle piece 1, rotated 90 degrees').
			locators: { exact: false },
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
