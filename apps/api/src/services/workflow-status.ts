// Shared classification of Cloudflare Workflows instance statuses and errors.
//
// Cloudflare's WorkflowInstance.status() returns one of:
//   queued | running | paused | errored | terminated | complete |
//   waitingForPause | waiting | rollingBack | unknown
// (https://developers.cloudflare.com/workflows/build/trigger-workflows/)
//
// Active (non-terminal) statuses indicate the workflow may still make
// progress — treating them as dead would mint duplicate workflows on retry
// or reap puzzles whose generation is still legitimately in flight. Only
// `errored`, `terminated`, and the `unknown` fallback string are terminal.
// `complete` is terminal-success: every step succeeded, so the authoritative
// PuzzleMetadataDO has status 'ready' — callers treat it as alive/not-stuck
// (a KV read still showing 'processing' is eventual-consistency lag).

/** Statuses that mean the workflow may still make progress. */
export const ACTIVE_WORKFLOW_STATUSES = new Set([
	'queued',
	'running',
	'paused',
	'waiting',
	'waitingForPause',
	'rollingBack',
	'complete'
]);

/** Statuses that mean the workflow has permanently failed. */
export const DEAD_WORKFLOW_STATUSES = new Set(['errored', 'terminated', 'unknown']);

export function isAliveWorkflowStatus(status: string): boolean {
	return ACTIVE_WORKFLOW_STATUSES.has(status);
}

export function isDeadWorkflowStatus(status: string): boolean {
	return DEAD_WORKFLOW_STATUSES.has(status);
}

/**
 * Cloudflare's WorkflowBinding.get() throws an error whose code is
 * `instance.not_found` when the instance was never created (or was deleted).
 * The miniflare runtime (local dev) and the production runtime both surface
 * this code; we also match on the message as a fallback for runtimes that
 * only populate the message. A not-found instance means the original create
 * died before PUZZLE_WORKFLOW.create — the puzzle is orphaned, not transient.
 */
export function isWorkflowNotFoundError(err: unknown): boolean {
	if (!err) return false;
	const code = (err as { code?: unknown }).code;
	const message = (err as { message?: unknown }).message;
	const codeStr = typeof code === 'string' ? code : '';
	const msgStr = typeof message === 'string' ? message : '';
	return codeStr.includes('not_found') || msgStr.includes('not_found');
}
