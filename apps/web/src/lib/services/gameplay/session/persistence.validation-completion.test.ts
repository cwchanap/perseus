import { describe, expect, it } from 'vitest';
import {
	context,
	expectInvalid,
	load,
	seal,
	validSnapshot,
	fullBoardPlacements,
	RUN_ID
} from './persistence.test-fixtures';

describe('PuzzleSession completion persistence validation', () => {
	it('rejects completed snapshots without a valid seal', () => {
		expectInvalid((record) => {
			record.lifecycle = 'completed';
		});
		expectInvalid((record) => {
			record.lifecycle = 'completed';
			record.sealedCompletion = 'sealed';
		});
	});

	it.each([
		{ runId: '22222222-2222-4222-8222-222222222222' },
		{ resultClass: 'invalid' },
		{ completedAt: '1000' },
		{ elapsedActiveSeconds: '5' },
		{ elapsedActiveSeconds: -1 },
		{ localStats: 'done' },
		{ serverSubmission: 'done' },
		{ localStats: { status: 'failed', retryable: true } },
		{ serverSubmission: { status: 'failed', code: 'network_error' } },
		{ localStats: { status: 'unknown' } }
	])('rejects an invalid seal patch %j', (patch: Record<string, unknown>) => {
		expectInvalid((record) => {
			record.lifecycle = 'completed';
			record.sealedCompletion = seal(patch);
		});
	});

	it.each([null, { filter: 'invalid' }, { activeTray: 1 }, { membership: [] }, { names: [] }])(
		'rejects invalid organization %j',
		(organization: unknown) => {
			expectInvalid((record) => {
				record.organization = organization;
			});
		}
	);

	it('loads failed and pending effects and defaults organization fields', () => {
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.lifecycle = 'completed';
		record.placedPieces = fullBoardPlacements();
		record.sealedCompletion = seal({
			localStats: { status: 'failed', code: 'storage_error', retryable: true },
			serverSubmission: { status: 'pending' }
		});
		record.organization = {};

		const result = load(record);

		expect(result.status).toBe('loaded');
		if (result.status === 'loaded') {
			expect(result.snapshot.organization).toEqual({
				filter: 'all',
				activeTray: 'main',
				membership: {},
				names: {}
			});
		}
	});

	it('rejects an old seal lacking the summary facts instead of back-filling from outer state', () => {
		// Snapshots persisted before hintsUsed/incorrectAttempts/
		// rotationEnabled/rotationUsed were added to SealedCompletion cannot
		// be safely back-filled: the outer counters/facts may have diverged
		// from the completion boundary via complete → dismiss → undo → hint
		// → redo before the snapshot was ever loaded by this version.
		// Requiring the fields invalidates those old snapshots cleanly rather
		// than reconstructing contradictory facts (e.g. a standard_timed
		// seal with hintsUsed: 1).
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.lifecycle = 'completed';
		record.placedPieces = fullBoardPlacements();
		// Simulate a pre-upgrade seal that lacks the four summary fields.
		record.sealedCompletion = {
			runId: RUN_ID,
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 5,
			completedAt: 1_000,
			localStats: { status: 'succeeded' },
			serverSubmission: { status: 'succeeded' }
		};

		expect(load(record).status).toBe('invalid');
	});

	it('rejects a seal whose hintsUsed exceeds the outer counters (corruption)', () => {
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.lifecycle = 'completed';
		record.placedPieces = fullBoardPlacements();
		record.sealedCompletion = seal({ hintsUsed: 5 });

		expect(load(record).status).toBe('invalid');
	});

	it('rejects a seal with a non-integer hintsUsed', () => {
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.lifecycle = 'completed';
		record.placedPieces = fullBoardPlacements();
		record.sealedCompletion = seal({ hintsUsed: 1.5 });

		expect(load(record).status).toBe('invalid');
	});

	it('rejects null completion effects instead of defaulting to not-applicable', () => {
		// A null effect is corruption: the current engine always
		// emit a concrete state. Defaulting null to not_applicable would let a
		// corrupted API snapshot load and permanently suppress both local
		// stats and the server submission.
		const base = () => {
			const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
			record.lifecycle = 'completed';
			return record;
		};

		const nullLocal = base();
		nullLocal.sealedCompletion = seal({ localStats: null });
		expect(load(nullLocal).status).toBe('invalid');

		const nullServer = base();
		nullServer.sealedCompletion = seal({ serverSubmission: null });
		expect(load(nullServer).status).toBe('invalid');
	});

	it('rejects a not_applicable local-stats effect (local stats apply to every completion)', () => {
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.lifecycle = 'completed';
		record.sealedCompletion = seal({ localStats: { status: 'not_applicable' } });
		expect(load(record).status).toBe('invalid');
	});

	it('rejects a not_applicable server submission for an API puzzle', () => {
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.lifecycle = 'completed';
		record.sealedCompletion = seal({ serverSubmission: { status: 'not_applicable' } });
		// default context source is 'api'
		expect(load(record).status).toBe('invalid');
	});

	it('allows a not_applicable server submission for a local puzzle', () => {
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.lifecycle = 'completed';
		record.placedPieces = fullBoardPlacements();
		record.source = 'local';
		record.sealedCompletion = seal({
			serverSubmission: { status: 'not_applicable' }
		});
		const result = load(record, { ...context, source: 'local' });
		expect(result.status).toBe('loaded');
		if (result.status === 'loaded') {
			expect(result.snapshot.sealedCompletion?.serverSubmission).toEqual({
				status: 'not_applicable'
			});
		}
	});

	it('rejects a non-not_applicable server submission for a local puzzle', () => {
		const base = () => {
			const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
			record.lifecycle = 'completed';
			record.placedPieces = fullBoardPlacements();
			record.source = 'local';
			return record;
		};

		const pending = base();
		pending.sealedCompletion = seal({ serverSubmission: { status: 'pending' } });
		expect(load(pending, { ...context, source: 'local' }).status).toBe('invalid');

		const failed = base();
		failed.sealedCompletion = seal({
			serverSubmission: { status: 'failed', code: 'network_error', retryable: true }
		});
		expect(load(failed, { ...context, source: 'local' }).status).toBe('invalid');
	});

	it('rejects a local-stats failure that does not use the storage_error code', () => {
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.lifecycle = 'completed';
		record.placedPieces = fullBoardPlacements();
		record.sealedCompletion = seal({
			localStats: { status: 'failed', code: 'network_error', retryable: true }
		});
		expect(load(record).status).toBe('invalid');
	});

	it('rejects a server-submission failure that uses the storage_error code', () => {
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.lifecycle = 'completed';
		record.placedPieces = fullBoardPlacements();
		record.sealedCompletion = seal({
			serverSubmission: { status: 'failed', code: 'storage_error', retryable: true }
		});
		expect(load(record).status).toBe('invalid');
	});

	it('loads a retained seal whose result class diverges from the outer class after undo, hint, and redo', () => {
		// Regression: completing a standard timed run, then undoing, using a
		// hint, and redoing retains the original standard_timed seal while the
		// outer result class recomputes to assisted_timed. The engine produces
		// this state legitimately (sealedCompletion is retained across
		// undo/redo without resealing; hintUsed is monotonic). The loader must
		// accept it: each result class is validated independently, and the
		// seal records the class under which effects were submitted while the
		// outer class records current live eligibility.
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.lifecycle = 'completed';
		record.placedPieces = fullBoardPlacements();
		// Outer state reflects the post-hint live class.
		record.counters = { incorrectAttempts: 0, hintsUsed: 1, referenceActivations: 0 };
		record.facts = { rotationUsed: false, hintUsed: true, ghostReferenceUsed: false };
		record.resultClass = 'assisted_timed';
		// Seal retains the original standard_timed completion boundary.
		record.sealedCompletion = seal({
			hintsUsed: 0,
			resultClass: 'standard_timed'
		});

		const result = load(record);

		expect(result.status).toBe('loaded');
		if (result.status === 'loaded') {
			expect(result.snapshot.resultClass).toBe('assisted_timed');
			expect(result.snapshot.sealedCompletion?.resultClass).toBe('standard_timed');
			expect(result.snapshot.sealedCompletion?.hintsUsed).toBe(0);
		}
	});

	it.each([
		{ code: 'bad_request', retryable: true },
		{ code: 'not_found', retryable: true },
		{ code: 'run_id_conflict', retryable: true },
		{ code: 'completion_quota_exceeded', retryable: true },
		{ code: 'network_error', retryable: false },
		{ code: 'internal_error', retryable: false },
		{ code: 'unauthorized', retryable: false },
		{ code: 'storage_error', retryable: false }
	])('rejects a failed effect whose retryable flag mismatches its code %j', (failure) => {
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.lifecycle = 'completed';
		record.placedPieces = fullBoardPlacements();
		record.sealedCompletion = seal({
			serverSubmission: { status: 'failed', code: failure.code, retryable: failure.retryable }
		});
		expect(load(record).status).toBe('invalid');
	});
});

describe('PuzzleSession seal internal consistency (sealed facts vs seal.resultClass)', () => {
	// Helper: a completed full-board record with an explicit outer state.
	// The outer facts/counters/resultClass must be self-consistent (the
	// validateV1 cross-field checks catch outer corruption separately); these
	// tests isolate the seal's own internal consistency.
	function completedRecord(outer: {
		counters?: Record<string, number>;
		facts?: Record<string, boolean>;
		resultClass?: string;
		rotationEnabled?: boolean;
		pieceRotations?: Record<number, number>;
	}): Record<string, unknown> {
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.lifecycle = 'completed';
		record.placedPieces = fullBoardPlacements();
		if (outer.counters) record.counters = outer.counters;
		if (outer.facts) record.facts = outer.facts;
		if (outer.resultClass) record.resultClass = outer.resultClass;
		if (outer.rotationEnabled !== undefined) record.rotationEnabled = outer.rotationEnabled;
		if (outer.pieceRotations) record.pieceRotations = outer.pieceRotations;
		return record;
	}

	it('rejects a standard_timed seal with hintsUsed > 0 (should be assisted_timed)', () => {
		const record = completedRecord({
			counters: { incorrectAttempts: 0, hintsUsed: 1, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: true, ghostReferenceUsed: false },
			resultClass: 'assisted_timed'
		});
		record.sealedCompletion = seal({ hintsUsed: 1, resultClass: 'standard_timed' });
		expect(load(record).status).toBe('invalid');
	});

	it('rejects a standard_timed seal with rotationUsed: true (should be rotation_timed)', () => {
		const record = completedRecord({
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: true, hintUsed: false, ghostReferenceUsed: false },
			resultClass: 'rotation_timed',
			rotationEnabled: true,
			pieceRotations: { 0: 0, 1: 0, 2: 0, 3: 0 }
		});
		record.sealedCompletion = seal({ rotationUsed: true, resultClass: 'standard_timed' });
		expect(load(record).status).toBe('invalid');
	});

	it('rejects a standard_timed seal when outer ghostReferenceUsed is true (should be assisted_timed)', () => {
		const record = completedRecord({
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 1 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: true },
			resultClass: 'assisted_timed'
		});
		record.sealedCompletion = seal({
			hintsUsed: 0,
			rotationUsed: false,
			resultClass: 'standard_timed'
		});
		expect(load(record).status).toBe('invalid');
	});

	it('rejects a rotation_timed seal with rotationUsed: false', () => {
		const record = completedRecord({
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
			resultClass: 'standard_timed'
		});
		record.sealedCompletion = seal({ rotationUsed: false, resultClass: 'rotation_timed' });
		expect(load(record).status).toBe('invalid');
	});

	it('rejects a rotation_timed seal with hintsUsed > 0 (should be assisted_timed)', () => {
		const record = completedRecord({
			counters: { incorrectAttempts: 0, hintsUsed: 1, referenceActivations: 0 },
			facts: { rotationUsed: true, hintUsed: true, ghostReferenceUsed: false },
			resultClass: 'assisted_timed',
			rotationEnabled: true,
			pieceRotations: { 0: 0, 1: 0, 2: 0, 3: 0 }
		});
		record.sealedCompletion = seal({
			hintsUsed: 1,
			rotationUsed: true,
			resultClass: 'rotation_timed'
		});
		expect(load(record).status).toBe('invalid');
	});

	it('rejects a rotation_timed seal when outer ghostReferenceUsed is true (should be assisted_timed)', () => {
		const record = completedRecord({
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 1 },
			facts: { rotationUsed: true, hintUsed: false, ghostReferenceUsed: true },
			resultClass: 'assisted_timed',
			rotationEnabled: true,
			pieceRotations: { 0: 0, 1: 0, 2: 0, 3: 0 }
		});
		record.sealedCompletion = seal({
			hintsUsed: 0,
			rotationUsed: true,
			resultClass: 'rotation_timed'
		});
		expect(load(record).status).toBe('invalid');
	});

	it('rejects a seal with rotationUsed: true when the outer monotonic rotationUsed is false', () => {
		const record = completedRecord({
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
			resultClass: 'standard_timed'
		});
		record.sealedCompletion = seal({
			hintsUsed: 0,
			rotationUsed: true,
			resultClass: 'rotation_timed'
		});
		expect(load(record).status).toBe('invalid');
	});

	it('rejects an assisted_timed seal with no source of assistance (hintsUsed 0, no ghost reference)', () => {
		const record = completedRecord({
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
			resultClass: 'standard_timed'
		});
		record.sealedCompletion = seal({
			hintsUsed: 0,
			rotationUsed: false,
			resultClass: 'assisted_timed'
		});
		expect(load(record).status).toBe('invalid');
	});

	it('loads a valid assisted_timed seal with hint-based assistance (hintsUsed > 0)', () => {
		const record = completedRecord({
			counters: { incorrectAttempts: 0, hintsUsed: 1, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: true, ghostReferenceUsed: false },
			resultClass: 'assisted_timed'
		});
		record.sealedCompletion = seal({
			hintsUsed: 1,
			rotationUsed: false,
			resultClass: 'assisted_timed'
		});
		const result = load(record);
		expect(result.status).toBe('loaded');
		if (result.status === 'loaded') {
			expect(result.snapshot.sealedCompletion?.resultClass).toBe('assisted_timed');
			expect(result.snapshot.sealedCompletion?.hintsUsed).toBe(1);
		}
	});

	it('loads a valid assisted_timed seal with ghost-reference assistance (hintsUsed 0, outer ghostReferenceUsed true)', () => {
		const record = completedRecord({
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 1 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: true },
			resultClass: 'assisted_timed'
		});
		record.sealedCompletion = seal({
			hintsUsed: 0,
			rotationUsed: false,
			resultClass: 'assisted_timed'
		});
		const result = load(record);
		expect(result.status).toBe('loaded');
		if (result.status === 'loaded') {
			expect(result.snapshot.sealedCompletion?.resultClass).toBe('assisted_timed');
			expect(result.snapshot.sealedCompletion?.hintsUsed).toBe(0);
		}
	});

	it('loads a valid rotation_timed seal (rotationUsed true, no hints, no ghost reference)', () => {
		const record = completedRecord({
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: true, hintUsed: false, ghostReferenceUsed: false },
			resultClass: 'rotation_timed',
			rotationEnabled: true,
			pieceRotations: { 0: 0, 1: 0, 2: 0, 3: 0 }
		});
		record.sealedCompletion = seal({
			hintsUsed: 0,
			rotationUsed: true,
			rotationEnabled: true,
			resultClass: 'rotation_timed'
		});
		const result = load(record);
		expect(result.status).toBe('loaded');
		if (result.status === 'loaded') {
			expect(result.snapshot.sealedCompletion?.resultClass).toBe('rotation_timed');
			expect(result.snapshot.sealedCompletion?.rotationUsed).toBe(true);
		}
	});

	it('loads a valid rotation_timed seal with rotationEnabled false (rotation disabled after enabling)', () => {
		// The user enabled rotation (rotationUsed stays true), disabled it
		// (rotationEnabled false), then placed all pieces and completed. The
		// seal captures rotationEnabled false + rotationUsed true, which is
		// a legitimate rotation_timed completion.
		const record = completedRecord({
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: true, hintUsed: false, ghostReferenceUsed: false },
			resultClass: 'rotation_timed',
			rotationEnabled: false,
			pieceRotations: { 0: 0, 1: 0, 2: 0, 3: 0 }
		});
		record.sealedCompletion = seal({
			hintsUsed: 0,
			rotationUsed: true,
			rotationEnabled: false,
			resultClass: 'rotation_timed'
		});
		const result = load(record);
		expect(result.status).toBe('loaded');
		if (result.status === 'loaded') {
			expect(result.snapshot.sealedCompletion?.rotationEnabled).toBe(false);
			expect(result.snapshot.sealedCompletion?.rotationUsed).toBe(true);
		}
	});
});

describe('PuzzleSession full-board and canonical placement validation', () => {
	it('rejects a full board with an active lifecycle and no seal (dead state)', () => {
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.placedPieces = fullBoardPlacements();
		// lifecycle stays 'active', sealedCompletion stays null
		expect(load(record).status).toBe('invalid');
	});

	it('rejects a full board with a paused lifecycle and no seal', () => {
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.placedPieces = fullBoardPlacements();
		record.lifecycle = 'paused';
		expect(load(record).status).toBe('invalid');
	});

	it('accepts a full board only with a completed lifecycle and seal', () => {
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.placedPieces = fullBoardPlacements();
		record.lifecycle = 'completed';
		record.sealedCompletion = seal({});
		expect(load(record).status).toBe('loaded');
	});

	it('rejects a placement in a wrong (in-bounds) cell', () => {
		// Piece 2's canonical cell is (0,1); placing it at (1,0) is in bounds
		// but not its correct cell. Without canonical validation this would
		// load and let effects replay with pieces in wrong cells.
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.placedPieces = [
			{ pieceId: 0, x: 0, y: 0 },
			{ pieceId: 2, x: 1, y: 0 }
		];
		expect(load(record).status).toBe('invalid');
	});

	it('rejects a placement whose coordinates mismatch the persisted piece id', () => {
		// Piece 0's canonical cell is (0,0); (1,1) belongs to piece 3.
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.placedPieces = [{ pieceId: 0, x: 1, y: 1 }];
		expect(load(record).status).toBe('invalid');
	});
});
