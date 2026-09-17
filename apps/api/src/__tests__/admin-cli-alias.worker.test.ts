/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

function emptyApp() {
	return new Hono();
}

vi.mock('../routes/puzzles.worker', () => ({ default: emptyApp() }));
vi.mock('../routes/puzzle-families.worker', () => ({ default: emptyApp() }));
vi.mock('../routes/leaderboard.worker', () => ({ default: emptyApp() }));
vi.mock('../routes/auth.worker', () => ({ default: emptyApp() }));
vi.mock('../routes/player.worker', () => ({ default: emptyApp() }));
vi.mock('../routes/admin.worker', () => {
	const app = new Hono();
	app.get('/puzzle-families', (c) => c.json({ families: [], source: 'admin' }));
	return { default: app };
});
vi.mock('../services/reaper', () => ({
	reapStuckPuzzles: vi.fn(),
	reapCleanupRecords: vi.fn(),
	reapLegacyCleanupRecords: vi.fn(),
	reapOrphanedReservations: vi.fn(),
	reapOrphanedAvatars: vi.fn()
}));

import worker from '../worker';

function createMockCtx(): ExecutionContext {
	return {
		waitUntil: vi.fn(),
		passThroughOnException: vi.fn()
	} as any;
}

function createEnv() {
	return {
		NODE_ENV: 'development',
		JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
		GOOGLE_CLIENT_ID: 'google-client-id',
		GOOGLE_CLIENT_SECRET: 'google-client-secret',
		AUTH_REDIRECT_BASE_URL: 'http://localhost:5173',
		ALLOWED_ORIGINS: '',
		ASSETS: { fetch: vi.fn(() => new Response('static asset')) }
	};
}

describe('admin CLI route alias', () => {
	it('keeps the browser admin endpoint mounted', async () => {
		const response = await worker.fetch(
			new Request('http://localhost/api/admin/puzzle-families'),
			createEnv() as any,
			createMockCtx()
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ families: [], source: 'admin' });
	});

	it('mounts the same admin handlers under the dedicated CLI alias', async () => {
		const response = await worker.fetch(
			new Request('http://localhost/api/admin/cli/puzzle-families'),
			createEnv() as any,
			createMockCtx()
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ families: [], source: 'admin' });
	});
});
