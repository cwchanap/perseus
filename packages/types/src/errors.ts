/**
 * Canonical API error codes used across both API runtimes (Bun + Cloudflare
 * Worker) and the workflows worker.
 *
 * Centralizing these in `@perseus/types` prevents the string-literal drift
 * that previously produced ad-hoc variants for the same semantic error
 * (e.g. `'unavailable'` vs `'service_unavailable'`). The enum's values
 * intentionally equal the wire-format strings clients already see, so
 * existing call sites can migrate incrementally — `ErrorCode.Conflict ===
 * 'conflict'` is true at runtime, and string literals continue to work
 * until they are migrated.
 *
 * When adding a new code:
 *   1. Add it to the enum (lowercase snake_case, matching existing style).
 *   2. Add it to `ERROR_HTTP_STATUS` if it has a universal HTTP mapping.
 *   3. Use `ErrorCode.X` at the call site instead of a raw string literal.
 */
export enum ErrorCode {
	BadRequest = 'bad_request',
	Unauthorized = 'unauthorized',
	Forbidden = 'forbidden',
	NotFound = 'not_found',
	Conflict = 'conflict',
	TooManyRequests = 'too_many_requests',
	InternalError = 'internal_error',
	ServerMisconfigured = 'server_misconfigured',
	ServiceUnavailable = 'service_unavailable',
	/** Puzzle exists but piece generation is incomplete (HTTP 409). */
	PuzzleUnavailable = 'unavailable',
	/** Client supplied a piece index that does not exist for this puzzle. */
	InvalidPieceId = 'invalid_piece_id'
}

/** Wire-format error body returned by all API error responses. */
export interface ApiErrorResponse {
	error: ErrorCode;
	message: string;
}

/**
 * Canonical HTTP status for each error code. Codes whose status depends on
 * context (e.g. {@link ErrorCode.PuzzleUnavailable}, currently 409 only on
 * the puzzle-read path) are omitted — callers must pass an explicit status.
 */
export const ERROR_HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
	[ErrorCode.BadRequest]: 400,
	[ErrorCode.Unauthorized]: 401,
	[ErrorCode.Forbidden]: 403,
	[ErrorCode.NotFound]: 404,
	[ErrorCode.Conflict]: 409,
	[ErrorCode.TooManyRequests]: 429,
	[ErrorCode.InternalError]: 500,
	[ErrorCode.ServerMisconfigured]: 500,
	[ErrorCode.ServiceUnavailable]: 503
};
