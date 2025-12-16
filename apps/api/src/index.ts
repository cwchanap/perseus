import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { initializeStorage } from './services/storage';
import puzzles from './routes/puzzles';
import admin from './routes/admin';

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
app.use('*', logger());
app.use(
	'*',
	cors({
		origin: ['http://localhost:5173', 'http://localhost:4173'],
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
