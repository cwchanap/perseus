import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	use: {
		baseURL: 'http://localhost:4173'
	},
	webServer: [
		{
			command: 'bun run build:bun && bun run start:bun',
			port: 3999,
			cwd: '../api',
			reuseExistingServer: !process.env.CI,
			env: {
				...process.env,
				PORT: '3999',
				JWT_SECRET: process.env.JWT_SECRET ?? 'e2e-test-secret',
				ADMIN_PASSKEY: process.env.ADMIN_PASSKEY ?? 'e2e-test-passkey',
				ALLOWED_ORIGINS:
					process.env.ALLOWED_ORIGINS ?? 'http://localhost:4173,http://127.0.0.1:4173',
				NODE_ENV: process.env.NODE_ENV ?? 'test'
			}
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
			use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } }
		},
		{
			name: 'chromium-tablet',
			use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } }
		},
		{
			name: 'webkit-mobile',
			use: { ...devices['Desktop Safari'], viewport: { width: 390, height: 844 } }
		},
		{
			name: 'webkit-tablet',
			use: { ...devices['Desktop Safari'], viewport: { width: 768, height: 1024 } }
		}
	]
});
