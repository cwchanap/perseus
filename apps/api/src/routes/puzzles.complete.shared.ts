import {
	isRecordPuzzleCompletionV1,
	type RecordPuzzleCompletionResponse,
	type RecordPuzzleCompletionV1
} from '@perseus/types';
import type { LegacyCompletionWriteExecution, VersionedCompletionResult } from '@perseus/shared';

const MAX_COMPLETION_TIME_SECONDS = 24 * 60 * 60;

export type ParsedCompletionRequest =
	| { kind: 'legacy'; timeSeconds: number }
	| { kind: 'versioned'; request: RecordPuzzleCompletionV1 };

export type CompletionRequestParseResult =
	| { ok: true; value: ParsedCompletionRequest }
	| { ok: false; body: RecordPuzzleCompletionResponse; status: 400 };

type CompletionResultResponse = {
	body: RecordPuzzleCompletionResponse;
	status: 200 | 404 | 409 | 429;
};

export type CompletionRouteResult = VersionedCompletionResult | LegacyCompletionWriteExecution;

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
	if (typeof value === 'object' && value !== null && Object.hasOwn(value, 'version')) {
		if (!isRecordPuzzleCompletionV1(value, MAX_COMPLETION_TIME_SECONDS)) {
			return badRequest('Invalid versioned completion request');
		}
		return { ok: true, value: { kind: 'versioned', request: value } };
	}

	if (
		typeof value !== 'object' ||
		value === null ||
		Object.keys(value).length !== 1 ||
		!Object.hasOwn(value, 'timeSeconds')
	) {
		return badRequest('timeSeconds must be a number of at least 1 second');
	}

	const timeSeconds = (value as { timeSeconds: unknown }).timeSeconds;
	if (typeof timeSeconds !== 'number' || !Number.isFinite(timeSeconds) || timeSeconds < 1) {
		return badRequest('timeSeconds must be a number of at least 1 second');
	}
	if (timeSeconds > MAX_COMPLETION_TIME_SECONDS) {
		return badRequest('timeSeconds exceeds the maximum allowed solve time');
	}

	return {
		ok: true,
		value: { kind: 'legacy', timeSeconds: Math.floor(timeSeconds) }
	};
}

export function completionResultToResponse(
	result: CompletionRouteResult
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
