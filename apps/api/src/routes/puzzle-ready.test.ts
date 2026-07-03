import { describe, it, expect } from 'vitest';
import { isPuzzleReady } from './puzzle-ready';

describe('isPuzzleReady', () => {
	it('returns false for null', () => {
		expect(isPuzzleReady(null)).toBe(false);
	});

	it('returns false for non-object primitives', () => {
		expect(isPuzzleReady('ready')).toBe(false);
		expect(isPuzzleReady(42)).toBe(false);
		expect(isPuzzleReady(true)).toBe(false);
		expect(isPuzzleReady(undefined)).toBe(false);
	});

	it('returns the explicit ready boolean when present', () => {
		expect(isPuzzleReady({ ready: true })).toBe(true);
		expect(isPuzzleReady({ ready: false })).toBe(false);
	});

	it('returns true when status is "ready" and no ready boolean', () => {
		expect(isPuzzleReady({ status: 'ready' })).toBe(true);
	});

	it('returns false when status is a non-ready string', () => {
		expect(isPuzzleReady({ status: 'processing' })).toBe(false);
		expect(isPuzzleReady({ status: 'failed' })).toBe(false);
	});

	it('returns false when status is a non-string value', () => {
		// Malformed objects (e.g. { status: 123 }) fall through to "not ready"
		// instead of being optimistically served as ready.
		expect(isPuzzleReady({ status: 123 })).toBe(false);
	});

	it('returns true for a legacy puzzle shape (string id + pieces array)', () => {
		expect(isPuzzleReady({ id: 'pz1', pieces: [] })).toBe(true);
		expect(isPuzzleReady({ id: 'pz1', pieces: [{}, {}] })).toBe(true);
	});

	it('returns false when id is present but pieces is missing or not an array', () => {
		expect(isPuzzleReady({ id: 'pz1' })).toBe(false);
		expect(isPuzzleReady({ id: 'pz1', pieces: 'not-array' })).toBe(false);
	});

	it('returns false when pieces is an array but id is not a string', () => {
		expect(isPuzzleReady({ id: 123, pieces: [] })).toBe(false);
	});

	it('returns false for an empty object (no recognizable fields)', () => {
		// The final fallthrough: {} matches none of the branches and must not
		// be optimistically served as ready.
		expect(isPuzzleReady({})).toBe(false);
	});

	it('prefers the explicit ready boolean over status', () => {
		// ready takes precedence over status, so a ready:false with status
		// 'ready' is treated as not ready.
		expect(isPuzzleReady({ ready: false, status: 'ready' })).toBe(false);
	});
});
