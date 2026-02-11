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
	ASSETS: Fetcher;
}

// Create Hono app with typed env
const app = new Hono<{ Bindings: Env }>();

// Middleware
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

// Import and mount route handlers
import puzzles from './routes/puzzles.worker';
import admin from './routes/admin.worker';

app.route('/api/puzzles', puzzles);
app.route('/api/admin', admin);

// Export for Cloudflare Workers
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Route /api and /api/* plus /health to Hono app
		if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/health') {
			return app.fetch(request, env, ctx);
		}

		// Serve static assets for all other routes
		// The assets binding handles SPA fallback via wrangler config
		return env.ASSETS.fetch(request);
	}
};
