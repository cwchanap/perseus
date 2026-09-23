import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	use: {
		baseURL: 'http://localhost:4173',
		// HPA-465: the puzzle route holds a 500 ms final-board reveal before
		// results on the first completion seal. Several smoke tests pause
		// Playwright's clock, under which the reveal timer would never expire;
		// a top-level reduced-motion default bypasses it so existing E2E
		// completion semantics stay immediate across every project. This must
		// live under `contextOptions`: a bare `use.reducedMotion` key is not a
		// test option in Playwright 1.57 and is silently ignored, while
		// `contextOptions` is passed through to browser.newContext().
		contextOptions: { reducedMotion: 'reduce' }
	},
	webServer: [
		{
			command: 'bun run dev:e2e',
			url: 'http://localhost:3999/api',
			cwd: '../api',
			reuseExistingServer: !process.env.CI,
			timeout: 180_000
		},
		{
			command: 'bun run build:e2e && bun run preview -- --port 4173 --strictPort',
			port: 4173,
			cwd: '.',
			reuseExistingServer: !process.env.CI,
			env: {
				...process.env,
				PUBLIC_API_BASE: process.env.PUBLIC_API_BASE ?? 'http://localhost:3999'
			}
		}
	],
	testDir: 'e2e',
	testMatch: '**/*.spec.ts',
	trace: 'retain-on-failure',
	screenshot: 'on-first-failure',
	failOnFlakyTests: Boolean(process.env.CI),
	reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
	outputDir: 'test-results',
	projects: [
		{
			name: 'chromium-desktop',
			use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
		},
		{
			name: 'chromium-mobile',
			// Touch + mobile viewport semantics: tap interaction and mobile-layout
			// paths are exercised under a touch-capable context.
			use: {
				...devices['Desktop Chrome'],
				viewport: { width: 390, height: 844 },
				hasTouch: true,
				isMobile: true
			}
		},
		{
			name: 'chromium-tablet',
			use: {
				...devices['Desktop Chrome'],
				viewport: { width: 768, height: 1024 },
				hasTouch: true,
				isMobile: true
			}
		},
		{
			name: 'webkit-mobile',
			use: {
				...devices['Desktop Safari'],
				viewport: { width: 390, height: 844 },
				hasTouch: true,
				isMobile: true
			}
		},
		{
			name: 'webkit-tablet',
			use: {
				...devices['Desktop Safari'],
				viewport: { width: 768, height: 1024 },
				hasTouch: true,
				isMobile: true
			}
		}
	]
});
