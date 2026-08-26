import { Http } from '@nativescript/core';
import type { PuzzleJsonRequest } from './puzzleApi';

export const nativePuzzleJsonRequest: PuzzleJsonRequest = async (url) => {
	const response = await Http.request({ url, method: 'GET' });
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(`puzzle_api_http_${response.statusCode}`);
	}
	if (!response.content) throw new Error('puzzle_api_empty_response');
	return response.content.toJSON();
};
