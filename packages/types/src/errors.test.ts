import { describe, it, expect } from 'vitest';
import { ErrorCode, ERROR_HTTP_STATUS } from './errors';

describe('ErrorCode', () => {
	it('uses lowercase snake_case for every value (wire-format invariant)', () => {
		for (const value of Object.values(ErrorCode)) {
			expect(value).toMatch(/^[a-z][a-z0-9_]*$/);
		}
	});

	it('has no duplicate values (stable API contract for clients)', () => {
		const values = Object.values(ErrorCode);
		expect(new Set(values).size).toBe(values.length);
	});

	it('maps every code with a universal HTTP status to a valid status code', () => {
		for (const status of Object.values(ERROR_HTTP_STATUS)) {
			expect(typeof status).toBe('number');
			expect(status!).toBeGreaterThanOrEqual(400);
			expect(status!).toBeLessThan(600);
		}
	});

	it('covers the codes currently emitted by both runtimes (regression guard)', () => {
		// If a new error string is introduced in source, add it here as an
		// ErrorCode member. This test prevents silent drift past the enum.
		const expected = [
			'bad_request',
			'unauthorized',
			'forbidden',
			'not_found',
			'conflict',
			'too_many_requests',
			'internal_error',
			'server_misconfigured',
			'service_unavailable',
			'unavailable',
			'invalid_piece_id'
		];
		expect(Object.values(ErrorCode).sort()).toEqual([...new Set(expected)].sort());
	});
});
