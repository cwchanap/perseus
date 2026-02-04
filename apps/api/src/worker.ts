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

let loggedAllowedOriginsWarning = false;

// Middleware
app.use('*', logger());

app.use('*', async (c, next) => {
	const env = c.env;
	const isProd = env.NODE_ENV === 'production';

	const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173', 'http://localhost:4173'];
	const envOrigins = (env.ALLOWED_ORIGINS || '')
		.split(',')
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0);

	const allowedOrigins = envOrigins.length > 0 ? envOrigins : isProd ? [] : DEFAULT_ALLOWED_ORIGINS;

	if (isProd) {
		const missingEnv = [];
		if (allowedOrigins.length === 0) missingEnv.push('ALLOWED_ORIGINS');
		if (!env.JWT_SECRET) missingEnv.push('JWT_SECRET');
		if (!env.ADMIN_PASSKEY) missingEnv.push('ADMIN_PASSKEY');

		if (missingEnv.length > 0) {
			if (!loggedAllowedOriginsWarning) {
				loggedAllowedOriginsWarning = true;
				console.warn(`Missing required production env vars: ${missingEnv.join(', ')}`);
			}

			return c.json(
				{
					error: 'server_misconfigured',
					message: isProd
						? 'Server configuration error'
						: `Missing required production env vars: ${missingEnv.join(', ')}`
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

		// Route /api/* to Hono app
		if (url.pathname.startsWith('/api')) {
			return app.fetch(request, env, ctx);
		}

		// Serve static assets for all other routes
		// The assets binding handles SPA fallback via wrangler config
		return env.ASSETS.fetch(request);
	}
};
