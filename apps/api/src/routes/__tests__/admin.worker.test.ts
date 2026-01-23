import { describe, it, expect } from 'vitest';
import admin from '../admin.worker';

describe('Admin Routes - JSON Parsing', () => {
	const mockEnv = {
		ADMIN_PASSKEY: 'test-passkey',
		JWT_SECRET: 'test-secret',
		RATE_LIMIT_KV: {} as KVNamespace
	};

	describe('POST /login', () => {
		it('should return 400 for malformed JSON', async () => {
			const req = new Request('http://localhost/login', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'cf-connecting-ip': '127.0.0.1'
				},
				body: '{invalid json}'
			});

			const res = await admin.fetch(req, mockEnv);

			// Verify status code first
			expect(res.status).toBe(400);

			const body = await res.json();
			expect(body.error).toBe('bad_request');
			expect(body.message).toContain('Invalid JSON');
		});

		it('should return 400 for missing Content-Type', async () => {
			const req = new Request('http://localhost/login', {
				method: 'POST',
				headers: {
					'cf-connecting-ip': '127.0.0.1'
				},
				body: 'not json'
			});

			const res = await admin.fetch(req, mockEnv);

			// Verify status code
			expect(res.status).toBe(400);

			const body = await res.json();
			expect(body.error).toBe('bad_request');
		});
	});
});
