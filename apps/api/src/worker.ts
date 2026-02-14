// Perseus API Worker Entry Point
// Serves both /api/* routes via Hono and static web assets

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { WorkflowParams } from './types/workflow';

// Workflow binding type (Cloudflare Workers)
interface WorkflowBinding<T = unknown> {
	create(options: { id: string; params: T }): Promise<{ id: string }>;
	get(id: string): Promise<{ id: string; status: string }>;
}

// Worker environment bindings
export interface Env {
	PUZZLES_BUCKET: R2Bucket;
	PUZZLE_METADATA: KVNamespace;
	PUZZLE_METADATA_DO: DurableObjectNamespace;
	PUZZLE_WORKFLOW: WorkflowBinding<WorkflowParams>;
	JWT_SECRET: string;
	ADMIN_PASSKEY: string;
	ALLOWED_ORIGINS?: string;
	NODE_ENV?: string;
	TRUSTED_PROXY?: string;
	/** Comma-separated list of trusted proxy IPs. Only used when TRUSTED_PROXY=true.
	 * When set, X-Forwarded-For is only trusted if the immediate peer (c.req.ip or connection remote address)
	 * is in this list. This prevents IP spoofing from untrusted clients.
	 * IMPORTANT: Only enable TRUSTED_PROXY=true when behind a reverse proxy that overwrites X-Forwarded-For.
	 */
	TRUSTED_PROXY_LIST?: string;
	ASSETS: Fetcher;
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', logger());

app.use('*', async (c, next) => {
	const env = c.env;
	const isDev = env.NODE_ENV === 'development';
	const isProd = !isDev; // Treat unset/staging/production as production

	const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173', 'http://localhost:4173'];
	const envOrigins = (env.ALLOWED_ORIGINS || '')
		.split(',')
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0);

	// In dev: allow localhost if no origins specified
	// In prod (including unset NODE_ENV): require explicit ALLOWED_ORIGINS
	const allowedOrigins = isDev
		? envOrigins.length > 0
			? envOrigins
			: DEFAULT_ALLOWED_ORIGINS
		: envOrigins;

	// Always validate critical env vars in production (including unset NODE_ENV)
	if (isProd) {
		const missingEnv = [];
		if (allowedOrigins.length === 0) missingEnv.push('ALLOWED_ORIGINS');
		if (!env.JWT_SECRET) missingEnv.push('JWT_SECRET');
		if (!env.ADMIN_PASSKEY) missingEnv.push('ADMIN_PASSKEY');

		if (missingEnv.length > 0) {
			console.error(`Missing required env vars in production: ${missingEnv.join(', ')}`);

			return c.json(
				{
					error: 'server_misconfigured',
					message: 'Server configuration error'
				},
				500
			);
		}
	}

	return cors({
		origin: allowedOrigins,
		credentials: true
	})(c, next);
});

// Health check (also at /health for backward compatibility)
app.get('/health', (c) => {
	return c.json({ status: 'ok' });
});

app.get('/api/health', (c) => {
	return c.json({ status: 'ok' });
});

// Root API info
app.get('/api', (c) => {
	return c.json({
		message: 'Perseus API',
		version: '0.0.1',
		timestamp: new Date().toISOString()
	});
});

import puzzles from './routes/puzzles.worker';
import admin from './routes/admin.worker';

app.route('/api/puzzles', puzzles);
app.route('/api/admin', admin);

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			const url = new URL(request.url);

			if (
				url.pathname === '/api' ||
				url.pathname.startsWith('/api/') ||
				url.pathname === '/health'
			) {
				return app.fetch(request, env, ctx);
			}

			return env.ASSETS.fetch(request);
		} catch (error) {
			console.error('Unhandled error in worker fetch:', error);
			const origin = request.headers.get('origin');
			const corsHeaders: Record<string, string> = {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': origin || '*',
				'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization'
			};
			return new Response(
				JSON.stringify({
					error: 'internal_error',
					message: 'An unexpected error occurred'
				}),
				{
					status: 500,
					headers: corsHeaders
				}
			);
		}
	}
};
