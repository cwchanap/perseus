import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { initializeStorage } from './services/storage';
import puzzles from './routes/puzzles';
import admin from './routes/admin';

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
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173', 'http://localhost:4173'];
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

app.use('*', logger());
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

const port = process.env.PORT || 3000;

console.log(`🚀 Server running on http://localhost:${port}`);

export default {
	port,
	fetch: app.fetch
};
