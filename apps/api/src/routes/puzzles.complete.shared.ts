import {
	isRecordPuzzleCompletionV2,
	MAX_COMPLETION_TIME_SECONDS,
	type RecordPuzzleCompletionResponse,
	type RecordPuzzleCompletionV2
} from '@perseus/types';
import type { VersionedCompletionResult } from '@perseus/shared';

export type CompletionRequestParseResult =
	| { ok: true; value: RecordPuzzleCompletionV2 }
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
	if (!isRecordPuzzleCompletionV2(value, MAX_COMPLETION_TIME_SECONDS)) {
		return badRequest('Invalid completion request');
	}
	return { ok: true, value };
}

export function completionResultToResponse(
	result: VersionedCompletionResult & { awards?: import('@perseus/shared').CompletionAwardsResult }
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
	const awards =
		result.awards &&
		(result.awards.clearPoints !== undefined ||
			(result.awards.achievements?.length ?? 0) > 0 ||
			(result.awards.mastery?.length ?? 0) > 0 ||
			result.awards.personalBest !== undefined ||
			result.awards.puzzleRank !== undefined)
			? {
					...(result.awards.clearPoints !== undefined
						? { clearPoints: result.awards.clearPoints }
						: {}),
					...(result.awards.achievements?.length
						? { achievements: result.awards.achievements }
						: {}),
					...(result.awards.mastery?.length ? { mastery: result.awards.mastery } : {}),
					...(result.awards.personalBest ? { personalBest: result.awards.personalBest } : {}),
					...(result.awards.puzzleRank !== undefined
						? { puzzleRank: result.awards.puzzleRank }
						: {})
				}
			: undefined;
	return {
		body: awards ? { ok: true, awards } : { ok: true },
		status: 200
	};
}

export function completionInternalErrorResponse(message: string): CompletionInternalErrorResponse {
	return {
		body: { error: 'internal_error', message },
		status: 500
	};
}
