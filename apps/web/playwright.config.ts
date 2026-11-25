import { defineConfig, devices } from '@playwright/test';
import { assertPortFree } from '../../scripts/assert-port-free';

// `--list` starts no servers, so an occupied port is not a problem there.
if (!process.env.TEST_WORKER_INDEX && !process.argv.includes('--list')) {
	await assertPortFree('127.0.0.1', 3999);
}

export default defineConfig({
	use: {
		baseURL: 'http://127.0.0.1:4173'
	},
	webServer: [
		{
			command: 'bun run dev:e2e',
			url: 'http://127.0.0.1:3999/api',
			cwd: '../api',
			reuseExistingServer: false,
			timeout: 180_000
		},
		{
			command: 'bun run build:e2e && bun run preview -- --host 127.0.0.1 --port 4173 --strictPort',
			port: 4173,
			cwd: '.',
			reuseExistingServer: false,
			timeout: 180_000,
			env: {
				...process.env,
				PUBLIC_API_BASE: 'http://127.0.0.1:3999'
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
