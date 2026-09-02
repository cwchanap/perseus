// Pure player-session HTTP boundary for mobile: no NativeScript imports.
// Task 3B supplies the native transport; this module pins paths, headers,
// and response validation.
import {
	isMobilePlayerSessionResponse,
	isPlayerSessionResponse,
	type MobilePlayerSessionResponse,
	type PlayerSessionResponse,
	type RecordPuzzleCompletionV2
} from '@perseus/types';

export interface PlayerHttpRequest {
	method: 'GET' | 'POST';
	url: string;
	headers?: Record<string, string>;
	body?: unknown;
}

export interface PlayerHttpResponse {
	status: number;
	body: unknown;
}

export type PlayerHttpTransport = (request: PlayerHttpRequest) => Promise<PlayerHttpResponse>;

export interface PlayerApi {
	exchangeGoogleIdToken(idToken: string): Promise<MobilePlayerSessionResponse>;
	getSession(token: string): Promise<PlayerSessionResponse>;
	logout(token: string): Promise<void>;
	submitCompletion(
		puzzleId: string,
		request: RecordPuzzleCompletionV2,
		token: string
	): Promise<PlayerHttpResponse>;
}

function requireOk(status: number): void {
	if (status < 200 || status >= 300) throw new Error(`player_api_http_${status}`);
}

export function createPlayerApi(options: {
	baseUrl: string;
	transport: PlayerHttpTransport;
}): PlayerApi {
	const baseUrl = options.baseUrl.replace(/\/+$/, '');
	const transport = options.transport;

	return {
		async exchangeGoogleIdToken(idToken: string): Promise<MobilePlayerSessionResponse> {
			const response = await transport({
				method: 'POST',
				url: `${baseUrl}/api/auth/mobile/google`,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ idToken })
			});
			requireOk(response.status);
			if (!isMobilePlayerSessionResponse(response.body)) {
				throw new Error('invalid_mobile_session_response');
			}
			return response.body;
		},

		async getSession(token: string): Promise<PlayerSessionResponse> {
			const response = await transport({
				method: 'GET',
				url: `${baseUrl}/api/auth/session`,
				headers: { Authorization: `Bearer ${token}` }
			});
			requireOk(response.status);
			if (!isPlayerSessionResponse(response.body)) {
				throw new Error('invalid_session_response');
			}
			return response.body;
		},

		async logout(token: string): Promise<void> {
			const response = await transport({
				method: 'POST',
				url: `${baseUrl}/api/auth/logout`,
				headers: { Authorization: `Bearer ${token}` }
			});
			requireOk(response.status);
		},

		async submitCompletion(
			puzzleId: string,
			request: RecordPuzzleCompletionV2,
			token: string
		): Promise<PlayerHttpResponse> {
			return transport({
				method: 'POST',
				url: `${baseUrl}/api/puzzles/${encodeURIComponent(puzzleId)}/complete`,
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(request)
			});
		}
	};
}
