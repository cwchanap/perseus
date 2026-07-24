// Perseus API Worker Entry Point
// Serves both /api/* routes via Hono and static web assets

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { DEFAULT_DEV_ORIGINS } from './services/player-auth.shared';
import type { WorkflowParams } from './types/workflow';

// Workflow binding type (Cloudflare Workers)
// Matches the real Cloudflare Workflows API: get() returns an instance whose
// status() is an async method, not a string property. Keeping this honest at
// the source eliminates `as unknown as` casts at every call site.
export interface WorkflowInstance {
	id: string;
	status(): Promise<{ status: string }>;
	terminate(options?: { rollback?: boolean }): Promise<void>;
}
export interface WorkflowBinding<T = unknown> {
	create(options: { id: string; params: T }): Promise<{ id: string }>;
	get(id: string): Promise<WorkflowInstance>;
}

// Worker environment bindings
export interface Env {
	PUZZLES_BUCKET: R2Bucket;
	PUZZLE_METADATA: KVNamespace;
	PUZZLE_METADATA_DO: DurableObjectNamespace;
	PUZZLE_WORKFLOW: WorkflowBinding<WorkflowParams>;
	DB: D1Database;
	JWT_SECRET: string;
	ADMIN_PASSKEY: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	AUTH_REDIRECT_BASE_URL: string;
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

const logMiddleware = logger();

// SECURITY: Skip request logging on the OAuth callback path to prevent
// OAuth authorization codes and state tokens from being written to logs.
app.use('*', async (c, next) => {
	if (c.req.path === '/api/auth/google/callback') {
		return next();
	}
	return logMiddleware(c, next);
});

app.use('*', async (c, next) => {
	const env = c.env;
	const isDev = env.NODE_ENV === 'development';
	const isProd = !isDev; // Treat unset/staging/production as production

	const DEFAULT_ALLOWED_ORIGINS = DEFAULT_DEV_ORIGINS;
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
import auth from './routes/auth.worker';
import player from './routes/player.worker';

app.route('/api/puzzles', puzzles);
app.route('/api/admin', admin);
app.route('/api/auth', auth);
app.route('/api/player', player);

import {
	reapStuckPuzzles,
	reapCleanupRecords,
	reapOrphanedReservations,
	reapOrphanedAvatars
} from './services/reaper';

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

			const assetResponse = await env.ASSETS.fetch(request);
			// SvelteKit static adapter uses 200.html as the SPA fallback, but
			// Cloudflare Workers Assets expects index.html. Serve 200.html manually.
			if (assetResponse.status === 404) {
				return env.ASSETS.fetch(new Request(new URL('/200.html', request.url).toString()));
			}
			return assetResponse;
		} catch (error) {
			console.error('Unhandled error in worker fetch:', error);
			const requestOrigin = request.headers.get('origin');
			// Validate origin against allowed origins before setting CORS header
			const isDev = env.NODE_ENV === 'development';
			const DEFAULT_ALLOWED_ORIGINS = DEFAULT_DEV_ORIGINS;
			const envOrigins = (env.ALLOWED_ORIGINS || '')
				.split(',')
				.map((origin) => origin.trim())
				.filter((origin) => origin.length > 0);
			const allowedOrigins = isDev
				? envOrigins.length > 0
					? envOrigins
					: DEFAULT_ALLOWED_ORIGINS
				: envOrigins;
			const validatedOrigin =
				requestOrigin && allowedOrigins.includes(requestOrigin) ? requestOrigin : '*';
			const corsHeaders: Record<string, string> = {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': validatedOrigin,
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
	},

	// Cron-triggered reaper: cleans up orphaned puzzle metadata + R2 images
	// left behind when a puzzle create dies mid-flight or a workflow
	// errors/terminates. Runs hourly; see wrangler.production.toml [triggers].
	// The reaper is safe to run concurrently with normal traffic — deletions
	// are idempotent and only target puzzles whose workflows are confirmed dead.
	async scheduled(
		_controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext
	): Promise<void> {
		ctx.waitUntil(
			(async () => {
				console.log('Reaper: starting scheduled run');
				try {
					const result = await reapStuckPuzzles(env);
					console.log(
						`Reaper: scanned=${result.scanned} candidates=${result.candidates} ` +
							`reaped=${result.reaped} errors=${result.errors}`
					);
					if (result.details.length > 0) {
						console.log('Reaper details:', JSON.stringify(result.details));
					}
				} catch (err) {
					console.error('Reaper: scheduled run failed:', err);
				}
				// Process explicit cleanup records left by the admin route
				// when it deferred R2/KV cleanup after unconfirmed workflow
				// termination. These records ensure completed duplicate
				// puzzles are eventually cleaned up.
				try {
					const cleanupResult = await reapCleanupRecords(env);
					if (cleanupResult.scanned > 0) {
						console.log(
							`Reaper cleanup: scanned=${cleanupResult.scanned} ` +
								`reaped=${cleanupResult.reaped} errors=${cleanupResult.errors}`
						);
						if (cleanupResult.details.length > 0) {
							console.log('Reaper cleanup details:', JSON.stringify(cleanupResult.details));
						}
					}
				} catch (err) {
					console.error('Reaper cleanup: scheduled run failed:', err);
				}
				// Reap puzzles whose idempotency key was reclaimed by a retry
				// (ownership-mismatch reconciliation). Closes the gap where a
				// failed writeCleanupRecord leaves a completed orphan that neither
				// the stuck-processing reaper nor the cleanup-record reaper can
				// reach. See reapOrphanedReservations for the full rationale.
				try {
					const orphanResult = await reapOrphanedReservations(env);
					if (orphanResult.candidates > 0) {
						console.log(
							`Reaper orphan: scanned=${orphanResult.scanned} ` +
								`candidates=${orphanResult.candidates} ` +
								`reaped=${orphanResult.reaped} errors=${orphanResult.errors}`
						);
						if (orphanResult.details.length > 0) {
							console.log('Reaper orphan details:', JSON.stringify(orphanResult.details));
						}
					}
				} catch (err) {
					console.error('Reaper orphan: scheduled run failed:', err);
				}
				// Garbage-collect orphaned versioned avatar R2 objects left by
				// concurrent upload races the read-after-write cleanup cannot
				// fully cover. Delayed GC: only deletes objects older than
				// AVATAR_GC_AGE_MS whose token is no longer authoritative.
				try {
					const avatarResult = await reapOrphanedAvatars(env);
					if (avatarResult.candidates > 0) {
						console.log(
							`Reaper avatar GC: scanned=${avatarResult.scanned} ` +
								`candidates=${avatarResult.candidates} ` +
								`reaped=${avatarResult.reaped} errors=${avatarResult.errors}`
						);
						if (avatarResult.details.length > 0) {
							console.log('Reaper avatar GC details:', JSON.stringify(avatarResult.details));
						}
					}
				} catch (err) {
					console.error('Reaper avatar GC: scheduled run failed:', err);
				}
			})()
		);
	}
};
