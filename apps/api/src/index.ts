import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { DEFAULT_DEV_ORIGINS } from './services/player-auth.shared';
import { initializeStorage } from './services/storage';
import { initializePlayerAuthStorage } from './services/player-auth';
import puzzles from './routes/puzzles';
import admin from './routes/admin';
import auth from './routes/auth';
import player from './routes/player';

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value || value.trim().length === 0) {
		console.error(`Missing required environment variable: ${name}`);
		process.exit(1);
	}
	return value;
}

// Validate required env vars early
requireEnv('JWT_SECRET');
requireEnv('ADMIN_PASSKEY');

const app = new Hono();

// Initialize storage on startup
try {
	await initializeStorage();
	await initializePlayerAuthStorage();
} catch (error) {
	console.error('Failed to initialize storage');
	if (error instanceof Error) {
		console.error(error.stack || error.message);
	} else {
		console.error(error);
	}
	process.exit(1);
}

// Middleware
const DEFAULT_ALLOWED_ORIGINS = DEFAULT_DEV_ORIGINS;
const envOrigins = (process.env.ALLOWED_ORIGINS || '')
	.split(',')
	.map((origin) => origin.trim())
	.filter((origin) => origin.length > 0);

if (process.env.NODE_ENV === 'production' && envOrigins.length === 0) {
	console.error('ALLOWED_ORIGINS must be set in production');
	process.exit(1);
}

const isProd = process.env.NODE_ENV === 'production';
const allowedOrigins =
	envOrigins.length > 0 ? envOrigins : isProd ? envOrigins : DEFAULT_ALLOWED_ORIGINS;

// SECURITY: Skip request logging on the OAuth callback path to prevent
// OAuth authorization codes and state tokens from being written to logs.
const logMiddleware = logger();
app.use('*', async (c, next) => {
	if (c.req.path === '/api/auth/google/callback') {
		return next();
	}
	return logMiddleware(c, next);
});
app.use(
	'*',
	cors({
		origin: allowedOrigins,
		credentials: true
	})
);

// Routes
app.get('/', (c) => {
	return c.json({
		message: 'Perseus API',
		version: '0.0.1',
		timestamp: new Date().toISOString()
	});
});

app.get('/health', (c) => {
	return c.json({ status: 'ok' });
});

// Mount route groups
app.route('/api/puzzles', puzzles);
app.route('/api/admin', admin);
app.route('/api/auth', auth);
app.route('/api/player', player);

const port = process.env.PORT || 3000;

console.log(`🚀 Server running on http://localhost:${port}`);

export default {
	port,
	fetch: app.fetch
};
