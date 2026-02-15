import { defineConfig } from '@playwright/test';

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
			command: 'bun run build && bun run preview -- --port 4173 --strictPort',
			port: 4173,
			cwd: '.',
			reuseExistingServer: !process.env.CI,
			env: {
				...process.env,
				PUBLIC_API_BASE: process.env.PUBLIC_API_BASE ?? 'http://localhost:3999'
			}
		}
	],
	testDir: 'e2e'
});
