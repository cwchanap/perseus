// Tests for the portable current-schema PuzzleSession codec
// (serializeSession / loadPersistedSession / isResumable / cross-field checks).
import { describe, it, expect } from 'vitest';
import {
	serializeSession,
	loadPersistedSession,
	isResumable,
	completionFailureCodeFromHttpStatus,
	isFailureRetryable
} from './codec';
import { context } from './codec.test-fixtures';
import type {
	PuzzleSessionState,
	PersistedPuzzleSessionV1,
	SessionValidationContext
} from './types';

function makeState(overrides: Partial<PuzzleSessionState> = {}): PuzzleSessionState {
	return {
		puzzleId: 'pz1',
		source: 'api',
		runId: '11111111-1111-4111-8111-111111111111',
		origin: 'new',
		lifecycle: 'active',
		mode: 'timed',
		elapsedActiveSeconds: 5,
		timerStarted: true,
		pieceCount: 4,
		gridCols: 2,
		gridRows: 2,
		// Partial board: an in-progress active session. A full board without a
		// sealed completion is a dead state and must be rejected by the loader.
		placedPieces: [
			{ pieceId: 0, x: 0, y: 0 },
			{ pieceId: 1, x: 1, y: 0 }
		],
		trayOrder: [0, 1, 2, 3],
		rotationEnabled: false,
		pieceRotations: {},
		selectedPieceId: null,
		activeReferenceMode: null,
		organization: null,
		viewport: null,
		counters: { incorrectAttempts: 1, hintsUsed: 0, referenceActivations: 0 },
		facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
		hasUserActivity: true,
		resultClass: 'standard_timed',
		sealedCompletion: null,
		canUndo: true,
		canRedo: false,
		...overrides
	};
}

const ctx: SessionValidationContext = context;

describe('serializeSession', () => {
	it('round-trips a schema v1 snapshot', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;

		const reloaded = loadPersistedSession(JSON.stringify(snapshot), ctx);

		expect(reloaded.status).toBe('loaded');
		if (reloaded.status === 'loaded') {
			expect(reloaded.snapshot).toEqual({ ...snapshot, lastUpdated: 1_000 });
		}
	});

	it('excludes transient runtime fields from the projection', () => {
		const snapshot = serializeSession(
			makeState({ selectedPieceId: 2, activeReferenceMode: 'hold', canUndo: true, canRedo: true }),
			1_000
		);

		expect(snapshot).not.toHaveProperty('selectedPieceId');
		expect(snapshot).not.toHaveProperty('activeReferenceMode');
		expect(snapshot).not.toHaveProperty('canUndo');
		expect(snapshot).not.toHaveProperty('canRedo');
		expect(snapshot).not.toHaveProperty('pieceCount');
	});

	it('returns null for a disposed session', () => {
		expect(serializeSession(makeState({ lifecycle: 'disposed' }), 1_000)).toBeNull();
	});

	it('omits organization when null', () => {
		const snapshot = serializeSession(makeState({ organization: null }), 1_000)!;
		expect(snapshot.organization).toBeUndefined();
	});

	it('preserves a recognized viewport across a load round-trip even when unset at runtime', () => {
		// A v1 snapshot carrying optional viewport state must survive load
		// (and subsequent re-serialization) even though the current route does
		// not populate it — the codec preserves recognized optional fields.
		const base = serializeSession(makeState({ viewport: null }), 1_000)!;
		const withViewport = { ...base, viewport: { zoom: 1.5, panX: -10, panY: 20 } };

		const loaded = loadPersistedSession(JSON.stringify(withViewport), ctx);
		expect(loaded.status).toBe('loaded');
		if (loaded.status === 'loaded') {
			expect(loaded.snapshot.viewport).toEqual({ zoom: 1.5, panX: -10, panY: 20 });
		}

		// An invalid viewport shape is rejected rather than silently dropped.
		const bad = { ...base, viewport: { zoom: 'big', panX: 0, panY: 0 } };
		expect(loadPersistedSession(JSON.stringify(bad), ctx).status).toBe('invalid');
	});
});

describe('loadPersistedSession validation', () => {
	it('returns missing for a null raw value', () => {
		expect(loadPersistedSession(null, ctx).status).toBe('missing');
	});

	it('returns invalid for malformed JSON', () => {
		expect(loadPersistedSession('{not json', ctx).status).toBe('invalid');
	});

	it('returns invalid for an unsupported schema version', () => {
		const future = JSON.stringify({ schemaVersion: 99, puzzleId: 'pz1' });
		const result = loadPersistedSession(future, ctx);
		expect(result).toEqual({ status: 'invalid', reason: 'unsupported_schema_version' });
	});

	it('returns invalid for an unversioned record', () => {
		const legacy = JSON.stringify({ puzzleId: 'pz1', placedPieces: [], lastUpdated: 10 });
		expect(loadPersistedSession(legacy, ctx)).toEqual({
			status: 'invalid',
			reason: 'unsupported_schema_version'
		});
	});

	it('accepts obsolete extra fields on a current-schema snapshot', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const withObsoleteField = { ...snapshot, obsoleteField: { oldTrayState: true } };
		const result = loadPersistedSession(JSON.stringify(withObsoleteField), ctx);

		expect(result.status).toBe('loaded');
		if (result.status === 'loaded') {
			expect(result.snapshot).not.toHaveProperty('obsoleteField');
		}
	});

	it('rejects a puzzle id mismatch', () => {
		const snapshot = serializeSession(makeState(), 1_000);
		const result = loadPersistedSession(JSON.stringify(snapshot), { ...ctx, puzzleId: 'other' });
		expect(result).toEqual({ status: 'invalid', reason: 'cross_field_violation' });
	});

	it('rejects a persisted disposed lifecycle', () => {
		const snapshot = serializeSession(makeState(), 1_000);
		const tampered = { ...snapshot, lifecycle: 'disposed' };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});
});

describe('isResumable', () => {
	it('is true for active + activity + no seal', () => {
		const snap = serializeSession(
			makeState({ lifecycle: 'active', hasUserActivity: true, sealedCompletion: null }),
			1
		)!;
		expect(isResumable(snap)).toBe(true);
	});

	it('is false for a sealed completion', () => {
		const seal: PersistedPuzzleSessionV1['sealedCompletion'] = {
			runId: 'r',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 5,
			completedAt: 1,
			localStats: { status: 'succeeded' },
			serverSubmission: { status: 'succeeded' },
			hintsUsed: 0,
			incorrectAttempts: 0,
			rotationEnabled: false,
			rotationUsed: false
		};
		const snap = serializeSession(
			makeState({ lifecycle: 'completed', sealedCompletion: seal }),
			1
		)!;
		expect(isResumable(snap)).toBe(false);
	});

	it('is false without user activity', () => {
		const snap = serializeSession(makeState({ hasUserActivity: false }), 1)!;
		expect(isResumable(snap)).toBe(false);
	});
});

describe('isResumable sealed-active guard', () => {
	it('is false for an active session carrying a sealed completion', () => {
		const seal: PersistedPuzzleSessionV1['sealedCompletion'] = {
			runId: 'r',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 5,
			completedAt: 1,
			localStats: { status: 'succeeded' },
			serverSubmission: { status: 'succeeded' },
			hintsUsed: 0,
			incorrectAttempts: 0,
			rotationEnabled: false,
			rotationUsed: false
		};
		const snap = serializeSession(
			makeState({ lifecycle: 'active', hasUserActivity: true, sealedCompletion: seal }),
			1
		)!;

		expect(isResumable(snap)).toBe(false);
	});
});

describe('completionFailureCodeFromHttpStatus', () => {
	it('maps completion HTTP statuses to failure codes', () => {
		expect(completionFailureCodeFromHttpStatus(400)).toBe('bad_request');
		expect(completionFailureCodeFromHttpStatus(401)).toBe('unauthorized');
		expect(completionFailureCodeFromHttpStatus(403)).toBe('bad_request');
		expect(completionFailureCodeFromHttpStatus(404)).toBe('not_found');
		expect(completionFailureCodeFromHttpStatus(408)).toBe('network_error');
		expect(completionFailureCodeFromHttpStatus(409)).toBe('run_id_conflict');
		expect(completionFailureCodeFromHttpStatus(429)).toBe('completion_quota_exceeded');
		expect(completionFailureCodeFromHttpStatus(500)).toBe('internal_error');
		expect(completionFailureCodeFromHttpStatus(503)).toBe('internal_error');
	});

	it('yields retryable codes for 401/408/5xx and terminal codes for 400/403/404/409/429', () => {
		for (const status of [401, 408, 500, 502, 503]) {
			expect(isFailureRetryable(completionFailureCodeFromHttpStatus(status))).toBe(true);
		}
		for (const status of [400, 403, 404, 409, 429]) {
			expect(isFailureRetryable(completionFailureCodeFromHttpStatus(status))).toBe(false);
		}
	});
});

// --- Patch coverage: validation branches --------------------------------------

describe('serializeSession with organization', () => {
	it('includes a cloned organization when present', () => {
		const org = {
			filter: 'edges' as const,
			activeTray: 'group-a',
			membership: { 0: 'group-a' },
			names: { 'group-a': 'Edges' }
		};
		const snapshot = serializeSession(makeState({ organization: org }), 1_000)!;
		expect(snapshot.organization).toEqual(org);
		// Mutating the source state after serialization must not affect the snapshot.
		org.names['group-a'] = 'Mutated';
		expect(snapshot.organization?.names['group-a']).toBe('Edges');
	});
});

// Serializer cloning moved from web persistence.validation-storage.test.ts:
// the snapshot must be a clone, not a reference, of engine state.
describe('serializeSession cloning', () => {
	const RUN_ID = '11111111-1111-4111-8111-111111111111';

	function validState(overrides: Partial<PuzzleSessionState> = {}): PuzzleSessionState {
		return {
			puzzleId: 'pz1',
			source: 'api',
			runId: RUN_ID,
			origin: 'new',
			lifecycle: 'active',
			mode: 'timed',
			elapsedActiveSeconds: 5,
			timerStarted: true,
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2,
			placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
			trayOrder: [0, 1, 2, 3],
			rotationEnabled: false,
			pieceRotations: {},
			selectedPieceId: null,
			activeReferenceMode: null,
			organization: null,
			viewport: null,
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
			hasUserActivity: true,
			resultClass: 'standard_timed',
			sealedCompletion: null,
			canUndo: false,
			canRedo: false,
			...overrides
		};
	}

	it('serializes cloned organization, gameplay, and completion data', () => {
		const state = validState({
			organization: {
				filter: 'edges',
				activeTray: 'side',
				membership: { 0: 'side' },
				names: { side: 'Side' }
			},
			pieceRotations: { 0: 90 },
			sealedCompletion: {
				runId: RUN_ID,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 5,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' },
				hintsUsed: 0,
				incorrectAttempts: 0,
				rotationEnabled: false,
				rotationUsed: false
			}
		});
		const snapshot = serializeSession(state, 2_000)!;

		state.placedPieces[0].x = 1;
		state.trayOrder[0] = 3;
		state.pieceRotations[0] = 180;
		state.counters.incorrectAttempts = 9;
		state.facts.rotationUsed = true;
		state.organization!.membership[0] = 'main';
		state.organization!.names.side = 'Changed';
		state.sealedCompletion!.localStats.status = 'failed';

		expect(snapshot.placedPieces[0].x).toBe(0);
		expect(snapshot.trayOrder[0]).toBe(0);
		expect(snapshot.pieceRotations[0]).toBe(90);
		expect(snapshot.counters.incorrectAttempts).toBe(0);
		expect(snapshot.facts.rotationUsed).toBe(false);
		expect(snapshot.organization).toEqual({
			filter: 'edges',
			activeTray: 'side',
			membership: { 0: 'side' },
			names: { side: 'Side' }
		});
		expect(snapshot.sealedCompletion?.localStats.status).toBe('succeeded');
	});
});

describe('loadPersistedSession additional validation branches', () => {
	it('returns invalid:not_object for a JSON primitive', () => {
		expect(loadPersistedSession('42', ctx)).toEqual({ status: 'invalid', reason: 'not_object' });
	});

	it('returns invalid:unsupported_schema_version when schemaVersion is not current', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = { ...snapshot, schemaVersion: 1.5 };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'unsupported_schema_version'
		});
	});

	it('returns invalid:unsupported_schema_version for a past non-zero version', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = { ...snapshot, schemaVersion: 0 };
		// Any schema version other than the current version is unsupported.
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'unsupported_schema_version'
		});
	});

	it('rejects a relaxed mode record with non-null elapsed', () => {
		const snapshot = serializeSession(
			makeState({ mode: 'relaxed', elapsedActiveSeconds: null, timerStarted: false }),
			1_000
		)!;
		const tampered = { ...snapshot, elapsedActiveSeconds: 10 };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a record with a non-integer lastUpdated', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = { ...snapshot, lastUpdated: 1.5 };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a record with invalid facts (missing boolean field)', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = { ...snapshot, facts: { rotationUsed: true, hintUsed: false } };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a standard_timed record with hintUsed: true (should be assisted_timed)', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			facts: { rotationUsed: false, hintUsed: true, ghostReferenceUsed: false },
			resultClass: 'standard_timed'
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a standard_timed record with ghostReferenceUsed: true (should be assisted_timed)', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: true },
			resultClass: 'standard_timed'
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a standard_timed record with rotationUsed: true (should be rotation_timed)', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			facts: { rotationUsed: true, hintUsed: false, ghostReferenceUsed: false },
			resultClass: 'standard_timed'
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a rotation_timed record with hintUsed: true (should be assisted_timed)', () => {
		const snapshot = serializeSession(
			makeState({
				rotationEnabled: true,
				facts: { rotationUsed: true, hintUsed: false, ghostReferenceUsed: false },
				resultClass: 'rotation_timed'
			}),
			1_000
		)!;
		const tampered = {
			...snapshot,
			facts: { rotationUsed: true, hintUsed: true, ghostReferenceUsed: false },
			resultClass: 'rotation_timed'
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a non-relaxed record with relaxed mode (should be relaxed)', () => {
		const snapshot = serializeSession(
			makeState({
				mode: 'relaxed',
				resultClass: 'relaxed',
				elapsedActiveSeconds: null,
				timerStarted: false
			}),
			1_000
		)!;
		const tampered = {
			...snapshot,
			resultClass: 'standard_timed'
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('accepts a record whose resultClass matches the monotonic facts', () => {
		const snapshot = serializeSession(
			makeState({
				facts: { rotationUsed: false, hintUsed: true, ghostReferenceUsed: false },
				resultClass: 'assisted_timed',
				counters: { incorrectAttempts: 1, hintsUsed: 1, referenceActivations: 0 }
			}),
			1_000
		)!;
		const result = loadPersistedSession(JSON.stringify(snapshot), ctx);
		expect(result.status).toBe('loaded');
	});

	it('rejects a record with invalid counters (negative incorrectAttempts)', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			counters: { incorrectAttempts: -1, hintsUsed: 0, referenceActivations: 0 }
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a record with non-integer hintsUsed', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			counters: { incorrectAttempts: 0, hintsUsed: 1.5, referenceActivations: 0 }
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a record with negative referenceActivations', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: -2 }
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a seal with a pending localStats state', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 5,
				completedAt: 1_000,
				localStats: { status: 'bogus' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a seal with a failed state missing code', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 5,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'failed', retryable: true }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a seal with a non-finite completedAt', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 5,
				completedAt: Infinity,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a seal with a negative elapsedActiveSeconds', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: -1,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a known timed seal with elapsed 0 (server requires positive)', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 0,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a known timed seal with fractional elapsed (server requires integer)', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 1.5,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a known timed seal with null elapsed (server requires a number)', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: null,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a relaxed seal with a numeric elapsed (server requires null)', () => {
		const snapshot = serializeSession(
			makeState({
				mode: 'relaxed',
				resultClass: 'relaxed',
				elapsedActiveSeconds: null,
				timerStarted: false
			}),
			1_000
		)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'relaxed',
				elapsedActiveSeconds: 5,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a seal with a negative completedAt', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: snapshot.runId,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 5,
				completedAt: -1,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a seal with a runId mismatch', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			lifecycle: 'completed',
			sealedCompletion: {
				runId: 'different-run-id',
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 5,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a completed lifecycle without a seal', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = { ...snapshot, lifecycle: 'completed', sealedCompletion: null };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects an organization with an invalid filter', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			organization: { filter: 'bogus', activeTray: 'main', membership: {}, names: {} }
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects an organization with a non-string activeTray', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			organization: { filter: 'all', activeTray: 123, membership: {}, names: {} }
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects an organization with a non-object membership', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			organization: { filter: 'all', activeTray: 'main', membership: 'not-object', names: {} }
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects an organization with a non-object names', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			organization: { filter: 'all', activeTray: 'main', membership: {}, names: [] }
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('accepts a valid organization with explicit fields', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			organization: {
				filter: 'corners',
				activeTray: 'main',
				membership: { 0: 'g1' },
				names: { g1: 'Corners' }
			}
		};
		const result = loadPersistedSession(JSON.stringify(tampered), ctx);
		expect(result.status).toBe('loaded');
		if (result.status === 'loaded') {
			expect(result.snapshot.organization?.filter).toBe('corners');
			expect(result.snapshot.organization?.membership[0]).toBe('g1');
		}
	});

	it('rejects an organization with a membership entry for an unknown piece ID', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = {
			...snapshot,
			organization: {
				filter: 'all',
				activeTray: 'main',
				membership: { 99: 'g1' },
				names: { g1: 'Group 1' }
			}
		};
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a record with a non-numeric elapsedActiveSeconds', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = { ...snapshot, elapsedActiveSeconds: 'not-a-number' };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a record with a negative elapsedActiveSeconds', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = { ...snapshot, elapsedActiveSeconds: -5 };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('rejects a record with a non-integer elapsedActiveSeconds', () => {
		const snapshot = serializeSession(makeState(), 1_000)!;
		const tampered = { ...snapshot, elapsedActiveSeconds: 1.5 };
		expect(loadPersistedSession(JSON.stringify(tampered), ctx)).toEqual({
			status: 'invalid',
			reason: 'cross_field_violation'
		});
	});

	it('round-trips a completed snapshot with a valid sealed completion', () => {
		const seal: PersistedPuzzleSessionV1['sealedCompletion'] = {
			runId: '11111111-1111-4111-8111-111111111111',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 42,
			completedAt: 1_000,
			localStats: { status: 'succeeded' },
			serverSubmission: { status: 'failed', code: 'network_error', retryable: true },
			hintsUsed: 0,
			incorrectAttempts: 0,
			rotationEnabled: false,
			rotationUsed: false
		};
		const snapshot = serializeSession(
			makeState({
				lifecycle: 'completed',
				sealedCompletion: seal,
				placedPieces: [
					{ pieceId: 0, x: 0, y: 0 },
					{ pieceId: 1, x: 1, y: 0 },
					{ pieceId: 2, x: 0, y: 1 },
					{ pieceId: 3, x: 1, y: 1 }
				]
			}),
			1_000
		)!;
		const result = loadPersistedSession(JSON.stringify(snapshot), ctx);
		expect(result.status).toBe('loaded');
		if (result.status === 'loaded') {
			expect(result.snapshot.sealedCompletion).not.toBeNull();
			expect(result.snapshot.sealedCompletion?.serverSubmission.status).toBe('failed');
		}
	});

	it('round-trips a completed local snapshot with a not_applicable server submission', () => {
		// not_applicable server submission is valid only for local puzzles;
		// for an API puzzle it would suppress the server submission.
		const localCtx: SessionValidationContext = { ...ctx, source: 'local' };
		const seal: PersistedPuzzleSessionV1['sealedCompletion'] = {
			runId: '11111111-1111-4111-8111-111111111111',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 42,
			completedAt: 1_000,
			localStats: { status: 'succeeded' },
			serverSubmission: { status: 'not_applicable' },
			hintsUsed: 0,
			incorrectAttempts: 0,
			rotationEnabled: false,
			rotationUsed: false
		};
		const snapshot = serializeSession(
			makeState({
				lifecycle: 'completed',
				sealedCompletion: seal,
				source: 'local',
				placedPieces: [
					{ pieceId: 0, x: 0, y: 0 },
					{ pieceId: 1, x: 1, y: 0 },
					{ pieceId: 2, x: 0, y: 1 },
					{ pieceId: 3, x: 1, y: 1 }
				]
			}),
			1_000
		)!;
		const result = loadPersistedSession(JSON.stringify(snapshot), localCtx);
		expect(result.status).toBe('loaded');
		if (result.status === 'loaded') {
			expect(result.snapshot.sealedCompletion?.serverSubmission.status).toBe('not_applicable');
		}
	});

	it('rejects a not_applicable server submission for an API puzzle', () => {
		const seal: PersistedPuzzleSessionV1['sealedCompletion'] = {
			runId: '11111111-1111-4111-8111-111111111111',
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 42,
			completedAt: 1_000,
			localStats: { status: 'succeeded' },
			serverSubmission: { status: 'not_applicable' },
			hintsUsed: 0,
			incorrectAttempts: 0,
			rotationEnabled: false,
			rotationUsed: false
		};
		const snapshot = serializeSession(
			makeState({ lifecycle: 'completed', sealedCompletion: seal }),
			1_000
		)!;
		const result = loadPersistedSession(JSON.stringify(snapshot), ctx);
		expect(result.status).toBe('invalid');
	});
});
