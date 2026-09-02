import { describe, expect, it } from 'vitest';
import type {
	MobilePlayerSessionResponse,
	PlayerUser,
	RecordPuzzleCompletionV2
} from '@perseus/types';
import {
	createPlayerApi,
	type PlayerHttpRequest,
	type PlayerHttpResponse,
	type PlayerHttpTransport
} from './playerApi';

function playerUser(): PlayerUser {
	return {
		id: 'player-1',
		email: 'player@example.test',
		name: 'Player One',
		createdAt: 1720000000000,
		lastLoginAt: 1720000000000
	};
}

function mobileSession(): MobilePlayerSessionResponse {
	return { token: 'session-token', expiresAt: 1720000600000, user: playerUser() };
}

function completionRequest(): RecordPuzzleCompletionV2 {
	return {
		version: 2,
		runId: 'run-1',
		resultClass: 'standard_timed',
		elapsedActiveSeconds: 90,
		hintsUsed: 1,
		incorrectAttempts: 2
	};
}

function scriptedTransport(
	responses: PlayerHttpResponse[],
	requests: PlayerHttpRequest[]
): PlayerHttpTransport {
	return async (request) => {
		requests.push(request);
		const response = responses.shift();
		if (!response) throw new Error('no_scripted_response');
		return response;
	};
}

function failingTransport(): PlayerHttpTransport {
	return async () => {
		throw new Error('transport_offline');
	};
}

describe('createPlayerApi', () => {
	describe('exchangeGoogleIdToken', () => {
		it('posts the id token to the mobile exchange path and returns the validated session', async () => {
			const requests: PlayerHttpRequest[] = [];
			const session = mobileSession();
			const api = createPlayerApi({
				baseUrl: 'https://api.example.test/',
				transport: scriptedTransport([{ status: 200, body: session }], requests)
			});

			await expect(api.exchangeGoogleIdToken('google-id-token')).resolves.toEqual(session);
			expect(requests).toEqual([
				{
					method: 'POST',
					url: 'https://api.example.test/api/auth/mobile/google',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ idToken: 'google-id-token' })
				}
			]);
		});

		it('rejects a non-2xx status', async () => {
			const api = createPlayerApi({
				baseUrl: 'https://api.example.test',
				transport: scriptedTransport([{ status: 401, body: { error: 'unauthorized' } }], [])
			});

			await expect(api.exchangeGoogleIdToken('google-id-token')).rejects.toThrow(
				'player_api_http_401'
			);
		});

		it('rejects a 2xx body that fails the mobile session guard', async () => {
			const api = createPlayerApi({
				baseUrl: 'https://api.example.test',
				transport: scriptedTransport([{ status: 200, body: { token: 'x' } }], [])
			});

			await expect(api.exchangeGoogleIdToken('google-id-token')).rejects.toThrow(
				'invalid_mobile_session_response'
			);
		});
	});

	describe('getSession', () => {
		it('sends the bearer token and accepts the unauthenticated shape', async () => {
			const requests: PlayerHttpRequest[] = [];
			const api = createPlayerApi({
				baseUrl: 'https://api.example.test',
				transport: scriptedTransport([{ status: 200, body: { authenticated: false } }], requests)
			});

			expect(await api.getSession('token')).toEqual({ authenticated: false });
			expect(requests).toEqual([
				{
					method: 'GET',
					url: 'https://api.example.test/api/auth/session',
					headers: { Authorization: 'Bearer token' }
				}
			]);
		});

		it('accepts the authenticated shape with the refreshed player', async () => {
			const player = playerUser();
			const api = createPlayerApi({
				baseUrl: 'https://api.example.test',
				transport: scriptedTransport(
					[{ status: 200, body: { authenticated: true, user: player } }],
					[]
				)
			});

			expect(await api.getSession('token')).toEqual({ authenticated: true, user: player });
		});

		it('rejects a 2xx body that fails the session guard', async () => {
			const api = createPlayerApi({
				baseUrl: 'https://api.example.test',
				transport: scriptedTransport([{ status: 200, body: { authenticated: true } }], [])
			});

			await expect(api.getSession('token')).rejects.toThrow('invalid_session_response');
		});

		it('rejects a non-2xx status', async () => {
			const api = createPlayerApi({
				baseUrl: 'https://api.example.test',
				transport: scriptedTransport([{ status: 500, body: null }], [])
			});

			await expect(api.getSession('token')).rejects.toThrow('player_api_http_500');
		});
	});

	describe('logout', () => {
		it('posts the bearer token to the logout path', async () => {
			const requests: PlayerHttpRequest[] = [];
			const api = createPlayerApi({
				baseUrl: 'https://api.example.test',
				transport: scriptedTransport([{ status: 200, body: { success: true } }], requests)
			});

			await expect(api.logout('token')).resolves.toBeUndefined();
			expect(requests).toEqual([
				{
					method: 'POST',
					url: 'https://api.example.test/api/auth/logout',
					headers: { Authorization: 'Bearer token' }
				}
			]);
		});

		it('rejects a non-2xx status', async () => {
			const api = createPlayerApi({
				baseUrl: 'https://api.example.test',
				transport: scriptedTransport([{ status: 503, body: null }], [])
			});

			await expect(api.logout('token')).rejects.toThrow('player_api_http_503');
		});
	});

	describe('submitCompletion', () => {
		it('posts the v2 payload and returns the raw response unchanged', async () => {
			const requests: PlayerHttpRequest[] = [];
			const request = completionRequest();
			const api = createPlayerApi({
				baseUrl: 'https://api.example.test',
				transport: scriptedTransport(
					[{ status: 409, body: { error: 'run_id_conflict' } }],
					requests
				)
			});

			await expect(api.submitCompletion('variant-1', request, 'token')).resolves.toEqual({
				status: 409,
				body: { error: 'run_id_conflict' }
			});
			expect(requests).toEqual([
				{
					method: 'POST',
					url: 'https://api.example.test/api/puzzles/variant-1/complete',
					headers: {
						Authorization: 'Bearer token',
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(request)
				}
			]);
		});

		it('returns a 2xx raw response without validation', async () => {
			const api = createPlayerApi({
				baseUrl: 'https://api.example.test',
				transport: scriptedTransport([{ status: 200, body: { ok: true } }], [])
			});

			await expect(
				api.submitCompletion('variant-1', completionRequest(), 'token')
			).resolves.toEqual({
				status: 200,
				body: { ok: true }
			});
		});

		it('rejects only when the transport rejects', async () => {
			const api = createPlayerApi({
				baseUrl: 'https://api.example.test',
				transport: failingTransport()
			});

			await expect(api.submitCompletion('variant-1', completionRequest(), 'token')).rejects.toThrow(
				'transport_offline'
			);
		});
	});
});
