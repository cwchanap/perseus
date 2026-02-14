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

import worker from '../worker';

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
		const validEnv = {
			NODE_ENV: 'development',
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			ADMIN_PASSKEY: 'test-passkey',
			ALLOWED_ORIGINS: '',
			ASSETS: { fetch: vi.fn(() => new Response('static asset')) }
		};

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
});
