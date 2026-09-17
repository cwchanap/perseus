import { afterEach, describe, expect, it, mock } from 'bun:test';
import { probeAccessToken, probeServiceToken } from './token';
import { fetchExistingKeys, uploadWithRetry } from './upload';
import { accessAppFor } from './types';

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe('admin CLI path', () => {
	it('derives the dedicated CLI Access URL', () => {
		expect(accessAppFor('https://perseus.cwchanap.dev/')).toBe(
			'https://perseus.cwchanap.dev/api/admin/cli/puzzle-families'
		);
	});

	it('probes Access through the dedicated CLI alias', async () => {
		const urls: string[] = [];
		globalThis.fetch = mock(async (input: string | URL | Request) => {
			urls.push(String(input));
			return new Response('', { status: 200 });
		}) as unknown as typeof fetch;

		expect(await probeAccessToken('https://perseus.cwchanap.dev', 'jwt')).toBe('ok');
		expect(await probeServiceToken('https://perseus.cwchanap.dev', 'id', 'secret')).toBe('ok');
		expect(urls).toEqual([
			'https://perseus.cwchanap.dev/api/admin/cli/puzzle-families',
			'https://perseus.cwchanap.dev/api/admin/cli/puzzle-families'
		]);
	});

	it('uses the dedicated CLI alias for list and create requests', async () => {
		const calls: Array<{ url: string; method: string }> = [];
		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), method: init?.method ?? 'GET' });
			if ((init?.method ?? 'GET') === 'GET') {
				return new Response(JSON.stringify({ families: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			return new Response(JSON.stringify({ id: 'family-id' }), {
				status: 201,
				headers: { 'Content-Type': 'application/json' }
			});
		}) as unknown as typeof fetch;

		await fetchExistingKeys('https://perseus.cwchanap.dev', {});
		await uploadWithRetry(
			'https://perseus.cwchanap.dev',
			{},
			new FormData(),
			'Puzzle',
			'Puzzle\u00001:1'
		);

		expect(calls).toEqual([
			{
				url: 'https://perseus.cwchanap.dev/api/admin/cli/puzzle-families',
				method: 'GET'
			},
			{
				url: 'https://perseus.cwchanap.dev/api/admin/cli/puzzle-families',
				method: 'POST'
			}
		]);
	});
});
