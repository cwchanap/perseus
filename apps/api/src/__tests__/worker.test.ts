/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../routes/puzzles.worker', () => {
	const app = new Hono();
	app.get('/', (c: any) => c.json({ puzzles: [] }));
	return { default: app };
});

vi.mock('../routes/admin.worker', () => {
	const app = new Hono();
	app.get('/session', (c: any) => c.json({ authenticated: false }));
	return { default: app };
});

vi.mock('../routes/auth.worker', () => {
	const app = new Hono();
	app.get('/session', (c: any) => c.json({ authenticated: false }));
	return { default: app };
});

vi.mock('../services/reaper', () => ({
	reapStuckPuzzles: vi.fn(),
	reapCleanupRecords: vi.fn(),
	reapOrphanedReservations: vi.fn()
}));

import worker from '../worker';
import { reapStuckPuzzles, reapCleanupRecords, reapOrphanedReservations } from '../services/reaper';

function createMockCtx(): ExecutionContext {
	return {
		waitUntil: vi.fn(),
		passThroughOnException: vi.fn()
	} as any;
}

describe('Worker Entry Point', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	describe('production env validation', () => {
		it('should return 500 server_misconfigured when missing env vars in production', async () => {
			const env = {
				NODE_ENV: undefined,
				JWT_SECRET: '',
				ADMIN_PASSKEY: '',
				GOOGLE_CLIENT_ID: '',
				GOOGLE_CLIENT_SECRET: '',
				AUTH_REDIRECT_BASE_URL: '',
				ALLOWED_ORIGINS: '',
				ASSETS: { fetch: vi.fn() }
			};

			const req = new Request('http://localhost/api/health');
			const res = await worker.fetch(req, env as any, createMockCtx());

			expect(res.status).toBe(500);
			const body = (await res.json()) as any;
			expect(body.error).toBe('server_misconfigured');
		});
	});

	describe('dev mode CORS fallback', () => {
		it('should fall back to localhost origins when ALLOWED_ORIGINS is not set', async () => {
			const env = {
				NODE_ENV: 'development',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				ADMIN_PASSKEY: 'test-passkey',
				GOOGLE_CLIENT_ID: 'google-client-id',
				GOOGLE_CLIENT_SECRET: 'google-client-secret',
				AUTH_REDIRECT_BASE_URL: 'http://localhost:5173',
				ALLOWED_ORIGINS: '',
				ASSETS: { fetch: vi.fn() }
			};

			const req = new Request('http://localhost/api/health', {
				headers: { Origin: 'http://localhost:5173' }
			});
			const res = await worker.fetch(req, env as any, createMockCtx());

			expect(res.status).toBe(200);
			expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
		});
	});

	describe('routing', () => {
		let validEnv: {
			NODE_ENV: string;
			JWT_SECRET: string;
			ADMIN_PASSKEY: string;
			GOOGLE_CLIENT_ID: string;
			GOOGLE_CLIENT_SECRET: string;
			AUTH_REDIRECT_BASE_URL: string;
			ALLOWED_ORIGINS: string;
			ASSETS: { fetch: ReturnType<typeof vi.fn> };
		};

		beforeEach(() => {
			validEnv = {
				NODE_ENV: 'development',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				ADMIN_PASSKEY: 'test-passkey',
				GOOGLE_CLIENT_ID: 'google-client-id',
				GOOGLE_CLIENT_SECRET: 'google-client-secret',
				AUTH_REDIRECT_BASE_URL: 'http://localhost:5173',
				ALLOWED_ORIGINS: '',
				ASSETS: { fetch: vi.fn(() => new Response('static asset')) }
			};
		});

		it('should route /api/health to Hono', async () => {
			const req = new Request('http://localhost/api/health');
			const res = await worker.fetch(req, validEnv as any, createMockCtx());

			expect(res.status).toBe(200);
			const body = (await res.json()) as any;
			expect(body.status).toBe('ok');
			expect(validEnv.ASSETS.fetch).not.toHaveBeenCalled();
		});

		it('should route /health to Hono', async () => {
			const req = new Request('http://localhost/health');
			const res = await worker.fetch(req, validEnv as any, createMockCtx());

			expect(res.status).toBe(200);
			const body = (await res.json()) as any;
			expect(body.status).toBe('ok');
		});

		it('should route non-API paths to ASSETS', async () => {
			const req = new Request('http://localhost/some-page');
			await worker.fetch(req, validEnv as any, createMockCtx());

			expect(validEnv.ASSETS.fetch).toHaveBeenCalledWith(req);
		});
	});

	describe('top-level error handler', () => {
		it('should return 500 JSON when ASSETS.fetch throws', async () => {
			const env = {
				NODE_ENV: 'development',
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				ADMIN_PASSKEY: 'test-passkey',
				GOOGLE_CLIENT_ID: 'google-client-id',
				GOOGLE_CLIENT_SECRET: 'google-client-secret',
				AUTH_REDIRECT_BASE_URL: 'http://localhost:5173',
				ALLOWED_ORIGINS: '',
				ASSETS: {
					fetch: vi.fn(() => {
						throw new Error('ASSETS unavailable');
					})
				}
			};

			const req = new Request('http://localhost/some-page');
			const res = await worker.fetch(req, env as any, createMockCtx());

			expect(res.status).toBe(500);
			const body = (await res.json()) as any;
			expect(body.error).toBe('internal_error');
		});
	});

	describe('scheduled handler (reaper)', () => {
		beforeEach(() => {
			(reapOrphanedReservations as any).mockResolvedValue({
				scanned: 0,
				candidates: 0,
				reaped: 0,
				errors: 0,
				details: []
			});
		});

		it('should call reapStuckPuzzles and log results', async () => {
			(reapStuckPuzzles as any).mockResolvedValue({
				scanned: 10,
				candidates: 2,
				reaped: 1,
				errors: 0,
				details: [{ puzzleId: 'p1', action: 'reaped' }]
			});
			(reapCleanupRecords as any).mockResolvedValue({
				scanned: 0,
				reaped: 0,
				errors: 0,
				details: []
			});
			const ctx = createMockCtx();
			const env = { PUZZLE_METADATA: {} } as any;

			await worker.scheduled!(undefined as any, env, ctx);

			// waitUntil is called with a promise — await it to complete
			const waitUntilCall = (ctx.waitUntil as any).mock.calls[0][0];
			await waitUntilCall;

			expect(reapStuckPuzzles).toHaveBeenCalledWith(env);
		});

		it('should not throw when reapStuckPuzzles rejects', async () => {
			(reapStuckPuzzles as any).mockRejectedValue(new Error('reaper failed'));
			(reapCleanupRecords as any).mockResolvedValue({
				scanned: 0,
				reaped: 0,
				errors: 0,
				details: []
			});
			const ctx = createMockCtx();
			const env = { PUZZLE_METADATA: {} } as any;

			await worker.scheduled!(undefined as any, env, ctx);

			// waitUntil is called with a promise — await it to complete
			const waitUntilCall = (ctx.waitUntil as any).mock.calls[0][0];
			await waitUntilCall;

			expect(reapStuckPuzzles).toHaveBeenCalledWith(env);
		});

		it('should log details when reaped > 0', async () => {
			const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			(reapStuckPuzzles as any).mockResolvedValue({
				scanned: 5,
				candidates: 1,
				reaped: 1,
				errors: 0,
				details: [{ puzzleId: 'p1', action: 'reaped' }]
			});
			(reapCleanupRecords as any).mockResolvedValue({
				scanned: 0,
				reaped: 0,
				errors: 0,
				details: []
			});
			const ctx = createMockCtx();
			const env = { PUZZLE_METADATA: {} } as any;

			await worker.scheduled!(undefined as any, env, ctx);
			const waitUntilCall = (ctx.waitUntil as any).mock.calls[0][0];
			await waitUntilCall;

			// Should have logged start, summary, and details
			expect(logSpy).toHaveBeenCalledWith('Reaper: starting scheduled run');
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('scanned=5'));
			expect(logSpy).toHaveBeenCalledWith('Reaper details:', expect.stringContaining('p1'));
		});

		it('should log reapCleanupRecords summary when scanned > 0', async () => {
			const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			(reapStuckPuzzles as any).mockResolvedValue({
				scanned: 0,
				candidates: 0,
				reaped: 0,
				errors: 0,
				details: []
			});
			(reapCleanupRecords as any).mockResolvedValue({
				scanned: 3,
				reaped: 2,
				errors: 1,
				details: [{ puzzleId: 'dup-1', action: 'cleanup-reaped' }]
			});
			const ctx = createMockCtx();
			const env = { PUZZLE_METADATA: {} } as any;

			await worker.scheduled!(undefined as any, env, ctx);
			const waitUntilCall = (ctx.waitUntil as any).mock.calls[0][0];
			await waitUntilCall;

			expect(reapCleanupRecords).toHaveBeenCalledWith(env);
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Reaper cleanup: scanned=3'));
			expect(logSpy).toHaveBeenCalledWith(
				'Reaper cleanup details:',
				expect.stringContaining('dup-1')
			);
		});

		it('should not throw when reapCleanupRecords rejects', async () => {
			(reapStuckPuzzles as any).mockResolvedValue({
				scanned: 0,
				candidates: 0,
				reaped: 0,
				errors: 0,
				details: []
			});
			(reapCleanupRecords as any).mockRejectedValue(new Error('cleanup reaper failed'));
			const ctx = createMockCtx();
			const env = { PUZZLE_METADATA: {} } as any;

			await worker.scheduled!(undefined as any, env, ctx);
			const waitUntilCall = (ctx.waitUntil as any).mock.calls[0][0];
			await waitUntilCall;

			expect(reapCleanupRecords).toHaveBeenCalledWith(env);
		});

		it('should call reapOrphanedReservations and log when candidates > 0', async () => {
			const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			(reapStuckPuzzles as any).mockResolvedValue({
				scanned: 0,
				candidates: 0,
				reaped: 0,
				errors: 0,
				details: []
			});
			(reapCleanupRecords as any).mockResolvedValue({
				scanned: 0,
				reaped: 0,
				errors: 0,
				details: []
			});
			(reapOrphanedReservations as any).mockResolvedValue({
				scanned: 20,
				candidates: 3,
				reaped: 2,
				errors: 1,
				details: [{ puzzleId: 'orphan-1', action: 'orphan-reaped' }]
			});
			const ctx = createMockCtx();
			const env = { PUZZLE_METADATA: {} } as any;

			await worker.scheduled!(undefined as any, env, ctx);
			const waitUntilCall = (ctx.waitUntil as any).mock.calls[0][0];
			await waitUntilCall;

			expect(reapOrphanedReservations).toHaveBeenCalledWith(env);
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Reaper orphan: scanned=20'));
			expect(logSpy).toHaveBeenCalledWith(
				'Reaper orphan details:',
				expect.stringContaining('orphan-1')
			);
		});

		it('should not throw when reapOrphanedReservations rejects', async () => {
			(reapStuckPuzzles as any).mockResolvedValue({
				scanned: 0,
				candidates: 0,
				reaped: 0,
				errors: 0,
				details: []
			});
			(reapCleanupRecords as any).mockResolvedValue({
				scanned: 0,
				reaped: 0,
				errors: 0,
				details: []
			});
			(reapOrphanedReservations as any).mockRejectedValue(new Error('orphan reaper failed'));
			const ctx = createMockCtx();
			const env = { PUZZLE_METADATA: {} } as any;

			await worker.scheduled!(undefined as any, env, ctx);
			const waitUntilCall = (ctx.waitUntil as any).mock.calls[0][0];
			await waitUntilCall;

			expect(reapOrphanedReservations).toHaveBeenCalledWith(env);
		});
	});
});
