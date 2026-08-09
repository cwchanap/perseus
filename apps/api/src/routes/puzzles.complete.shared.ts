import {
	isRecordPuzzleCompletionV1,
	MAX_COMPLETION_TIME_SECONDS,
	type RecordPuzzleCompletionResponse,
	type RecordPuzzleCompletionV1
} from '@perseus/types';
import type { VersionedCompletionResult } from '@perseus/shared';

export type CompletionRequestParseResult =
	| { ok: true; value: RecordPuzzleCompletionV1 }
	| { ok: false; body: RecordPuzzleCompletionResponse; status: 400 };

type CompletionResultResponse = {
	body: RecordPuzzleCompletionResponse;
	status: 200 | 404 | 409 | 429;
};

type CompletionInternalErrorResponse = {
	body: RecordPuzzleCompletionResponse;
	status: 500;
};

function badRequest(message: string): CompletionRequestParseResult {
	return {
		ok: false,
		body: { error: 'bad_request', message },
		status: 400
	};
}

export function parseCompletionRequest(value: unknown): CompletionRequestParseResult {
	if (!isRecordPuzzleCompletionV1(value, MAX_COMPLETION_TIME_SECONDS)) {
		return badRequest('Invalid completion request');
	}
	return { ok: true, value };
}

export function completionResultToResponse(
	result: VersionedCompletionResult
): CompletionResultResponse {
	if (result.status === 'tombstoned') {
		return {
			body: { error: 'not_found', message: 'Puzzle not found' },
			status: 404
		};
	}
	if (result.status === 'quota_exceeded') {
		return {
			body: {
				error: 'completion_quota_exceeded',
				message: 'Completion history limit reached'
			},
			status: 429
		};
	}
	if (result.status === 'conflict') {
		return {
			body: {
				error: 'run_id_conflict',
				message: 'Run ID was already used for a different completion'
			},
			status: 409
		};
	}
	return { body: { ok: true }, status: 200 };
}

export function completionInternalErrorResponse(message: string): CompletionInternalErrorResponse {
	return {
		body: { error: 'internal_error', message },
		status: 500
	};
}
