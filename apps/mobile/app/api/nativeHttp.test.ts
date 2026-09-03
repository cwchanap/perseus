import { describe, expect, it, vi } from 'vitest';

// Mock the native Http module so the transport can be exercised in vitest
// without a NativeScript runtime. The mock is hoisted before the import of
// nativeHttp.ts below.
vi.mock('@nativescript/core', () => ({
	Http: { request: vi.fn() }
}));

// Imported after the mock so its `Http` reference resolves to the mock.
// eslint-disable-next-line import/first
import { Http } from '@nativescript/core';
// eslint-disable-next-line import/first
import { nativePuzzleJsonRequest } from './nativeHttp';

type HttpContent = {
	toJSON: () => unknown;
	toString: () => string;
};
type ScriptedResponse = {
	statusCode: number;
	content?: HttpContent;
};

function mockResponse(response: ScriptedResponse): void {
	vi.mocked(Http.request).mockResolvedValueOnce(response as never);
}

/** A 2xx response whose content parses as the given JSON value. */
function jsonBody(status: number, value: unknown): ScriptedResponse {
	return {
		statusCode: status,
		content: { toJSON: () => value, toString: () => JSON.stringify(value) }
	};
}

/**
 * A 2xx response whose content is a raw string: toJSON throws (not valid
 * JSON) so the transport falls back to toString, which returns the given
 * text. This mirrors how a non-JSON 2xx body is decoded at runtime.
 */
function textBody(status: number, text: string): ScriptedResponse {
	return {
		statusCode: status,
		content: {
			toJSON: () => {
				throw new SyntaxError('Unexpected token');
			},
			toString: () => text
		}
	};
}

describe('nativePuzzleJsonRequest', () => {
	it('returns the parsed body on a 2xx response with a non-empty JSON value', async () => {
		const payload = { id: 'puzzle-1', ok: true };
		mockResponse(jsonBody(200, payload));

		await expect(
			nativePuzzleJsonRequest('https://api.example.test/puzzles/puzzle-1')
		).resolves.toEqual(payload);
	});

	it('rejects a non-2xx status with puzzle_api_http_<status>', async () => {
		mockResponse(jsonBody(503, null));

		await expect(
			nativePuzzleJsonRequest('https://api.example.test/puzzles/puzzle-1')
		).rejects.toThrow('puzzle_api_http_503');
	});

	it('rejects a 2xx response with no content as puzzle_api_empty_response', async () => {
		mockResponse({ statusCode: 200 });

		await expect(
			nativePuzzleJsonRequest('https://api.example.test/puzzles/puzzle-1')
		).rejects.toThrow('puzzle_api_empty_response');
	});

	it('rejects a 2xx response whose body is an empty string', async () => {
		mockResponse(textBody(200, ''));

		await expect(
			nativePuzzleJsonRequest('https://api.example.test/puzzles/puzzle-1')
		).rejects.toThrow('puzzle_api_empty_response');
	});

	it('rejects a 2xx response whose body is only whitespace', async () => {
		mockResponse(textBody(204, '   \n\t  '));

		await expect(
			nativePuzzleJsonRequest('https://api.example.test/puzzles/puzzle-1')
		).rejects.toThrow('puzzle_api_empty_response');
	});

	it('preserves a non-empty string body that is not whitespace-only', async () => {
		mockResponse(textBody(200, 'not-json-but-nonempty'));

		await expect(
			nativePuzzleJsonRequest('https://api.example.test/puzzles/puzzle-1')
		).resolves.toBe('not-json-but-nonempty');
	});
});
