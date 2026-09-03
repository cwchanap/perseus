// The single native owner of Http.request. Bodies arrive already
// JSON-stringified with headers set by the caller; this transport is a
// dumb pipe over @nativescript/core Http.
import { Http } from '@nativescript/core';
import type { PlayerHttpTransport } from './playerApi';
import type { PuzzleJsonRequest } from './puzzleApi';

export const nativePlayerHttpTransport: PlayerHttpTransport = async (request) => {
	const response = await Http.request({
		url: request.url,
		method: request.method,
		headers: request.headers,
		// Task 3A contract: bodies arrive already stringified (string | undefined).
		content: request.body as string | undefined,
		// Never follow redirects: the Authorization header must not be
		// forwarded to a different origin or protocol by the native HTTP
		// client. API endpoints return 2xx/4xx/5xx directly; a 3xx here
		// is surfaced as a non-2xx status for the caller to handle.
		dontFollowRedirects: true
	});

	let body: unknown = null;
	if (response.content) {
		try {
			body = response.content.toJSON();
		} catch {
			body = response.content.toString();
		}
	}

	return { status: response.statusCode, body };
};

export const nativePuzzleJsonRequest: PuzzleJsonRequest = async (url) => {
	const response = await nativePlayerHttpTransport({ method: 'GET', url });
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`puzzle_api_http_${response.status}`);
	}
	if (response.body === null) throw new Error('puzzle_api_empty_response');
	return response.body;
};
