// Same-account completion drain: submits a signed-in account's pending
// completion records sequentially through the player API and maps each
// response to a disposition using the shared HTTP failure mapping. Pure
// policy — no NativeScript imports, no direct storage or network access
// beyond the injected api/store.
import { completionFailureCodeFromHttpStatus, isFailureRetryable } from '@perseus/game-core';
import type { PersistedMobileSession } from '../account/mobileAccount';
import type { PlayerApi } from '../api/playerApi';
import type { CompletionStore } from './completionStore';

export type SubmissionDisposition = 'synced' | 'retryable' | 'auth_required' | 'terminal';

/**
 * Drain every pending completion record for the active session's account.
 *
 * - 2xx: the server has the run (or replayed it) — markSynced and continue.
 * - 401: stop with 'auth_required'; the caller runs the session-probe policy
 *   instead of deleting the bearer, and the record stays pending.
 * - Retryable codes (408/5xx) or a transport rejection: keep pending, stop.
 * - Terminal codes (400/403/404/409/429/other 4xx): markTerminal and continue.
 *
 * Returns 'synced' once at least one record was synced or retired as
 * terminal, 'empty' when the account had nothing pending.
 */
export async function drainPendingCompletions(args: {
	activeSession: PersistedMobileSession;
	api: PlayerApi;
	store: CompletionStore;
}): Promise<SubmissionDisposition | 'empty'> {
	const pending = args.store.listPendingForAccount(args.activeSession.user.id);
	let processed = false;
	for (const record of pending) {
		try {
			const response = await args.api.submitCompletion(
				record.puzzleId,
				record.request,
				args.activeSession.token
			);

			if (response.status >= 200 && response.status < 300) {
				args.store.markSynced(record.runId);
				processed = true;
				continue;
			}

			const code = completionFailureCodeFromHttpStatus(response.status);
			if (code === 'unauthorized') return 'auth_required';
			if (isFailureRetryable(code)) return 'retryable';

			args.store.markTerminal(record.runId);
			processed = true;
		} catch {
			// Transport failure: the record stays pending for the next trigger.
			return 'retryable';
		}
	}
	return processed ? 'synced' : 'empty';
}
