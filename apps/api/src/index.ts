import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors());

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

// Example API route
app.get('/api/hello', (c) => {
	const name = c.req.query('name') || 'World';
	return c.json({ message: `Hello, ${name}!` });
});

const port = process.env.PORT || 3000;

console.log(`🚀 Server running on http://localhost:${port}`);

export default {
	port,
	fetch: app.fetch
};
