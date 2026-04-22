import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPuzzle, ApiError } from '../api';

beforeEach(() => {
	vi.restoreAllMocks();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// ─── normalizeErrorPayload - array payload ────────────────────────────────────

describe('API Service - normalizeErrorPayload with array error body', () => {
	it('falls back to Unknown error when error response body is a JSON array', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify(['error1', 'error2']), {
					status: 400,
					statusText: 'Bad Request',
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		const err = await fetchPuzzle('p1').catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.error).toBe('Unknown error');
		expect(err.message).toBe('Bad Request');
	});

	it('falls back to Unknown error when error response body is a number', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response('42', {
					status: 500,
					statusText: 'Internal Server Error',
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		const err = await fetchPuzzle('p1').catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.error).toBe('Unknown error');
		expect(err.message).toBe('Internal Server Error');
	});
});

// ─── normalizeErrorPayload - non-string error field ──────────────────────────

describe('API Service - normalizeErrorPayload with non-string fields', () => {
	it('uses Unknown error when error field is a non-string value', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 404, message: 'not found' }), {
					status: 404,
					statusText: 'Not Found',
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		const err = await fetchPuzzle('p1').catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.error).toBe('Unknown error');
		expect(err.message).toBe('not found');
	});

	it('uses statusText fallback when message field is a non-string value', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'bad_request', message: { detail: 'oops' } }), {
					status: 400,
					statusText: 'Bad Request',
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		const err = await fetchPuzzle('p1').catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.error).toBe('bad_request');
		expect(err.message).toBe('Bad Request');
	});

	it('uses all defaults when both error and message fields are missing', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ code: 'ERR_UNKNOWN' }), {
					status: 503,
					statusText: 'Service Unavailable',
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		const err = await fetchPuzzle('p1').catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.error).toBe('Unknown error');
		expect(err.message).toBe('Service Unavailable');
	});
});

// ─── handleResponse - null JSON body ─────────────────────────────────────────

describe('API Service - handleResponse with null JSON body', () => {
	it('throws Invalid JSON response when response body is JSON null', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response('null', {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		await expect(fetchPuzzle('p1')).rejects.toThrow(/Invalid JSON response/);
	});
});
