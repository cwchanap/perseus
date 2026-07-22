import { describe, expect, it } from 'vitest';
import { isIdempotencyCommitConflict } from '../idempotency-conflict';

describe('isIdempotencyCommitConflict', () => {
	it('returns true for owner conflict', () => {
		expect(isIdempotencyCommitConflict(new Error('Reservation owned by another puzzle'))).toBe(
			true
		);
	});

	it('returns true for status conflict', () => {
		expect(
			isIdempotencyCommitConflict(new Error('Cannot committed reservation in status failed'))
		).toBe(true);
	});

	it('returns false for transient failures', () => {
		expect(isIdempotencyCommitConflict(new Error('DO unavailable'))).toBe(false);
		expect(
			isIdempotencyCommitConflict(new Error('Failed to commit idempotency key (HTTP 503)'))
		).toBe(false);
	});
});
