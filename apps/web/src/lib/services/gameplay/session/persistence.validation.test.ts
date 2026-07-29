import { describe, expect, it } from 'vitest';
import {
	createSessionStorageAdapter,
	loadPersistedSession,
	serializeSession
} from './persistence';
import type {
	PersistedPuzzleSessionV1,
	PuzzleSessionState,
	SessionPersistenceError,
	SessionValidationContext
} from './types';

const RUN_ID = '11111111-1111-4111-8111-111111111111';

const context: SessionValidationContext = {
	puzzleId: 'pz1',
	source: 'api',
	pieceIds: [0, 1, 2, 3],
	gridCols: 2,
	gridRows: 2,
	pieceCount: 4
};

function validSnapshot(): PersistedPuzzleSessionV1 {
	return {
		schemaVersion: 1,
		puzzleId: 'pz1',
		source: 'api',
		lifecycle: 'active',
		mode: 'timed',
		runId: RUN_ID,
		origin: 'new',
		elapsedActiveSeconds: 5,
		timingQuality: 'known',
		timerStarted: true,
		placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
		trayOrder: [0, 1, 2, 3],
		rotationEnabled: false,
		pieceRotations: {},
		counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
		facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
		hasUserActivity: true,
		resultClass: 'standard_timed',
		sealedCompletion: null,
		lastUpdated: 1_000
	};
}

function validState(overrides: Partial<PuzzleSessionState> = {}): PuzzleSessionState {
	return {
		puzzleId: 'pz1',
		source: 'api',
		runId: RUN_ID,
		origin: 'new',
		lifecycle: 'active',
		mode: 'timed',
		timingQuality: 'known',
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

function cloneRecord(): Record<string, unknown> {
	return JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
}

function load(value: unknown, ctx: SessionValidationContext = context) {
	const raw = JSON.stringify(value);
	if (raw === undefined) throw new Error('test value must be JSON serializable');
	return loadPersistedSession(raw, ctx);
}

function expectInvalid(mutator: (record: Record<string, unknown>) => void): void {
	const record = cloneRecord();
	mutator(record);
	expect(load(record).status).toBe('invalid');
}

describe('PuzzleSession persistence validation', () => {
	it.each([
		['null', null],
		['number', 42],
		['string', 'snapshot']
	])('rejects a non-object %s payload', (_name: string, value: unknown) => {
		expect(load(value).status).toBe('invalid');
	});

	it.each([
		['non-number schema version', '1'],
		['fractional schema version', 1.5],
		['unsupported older schema version', 0]
	])('rejects %s', (_name: string, schemaVersion: unknown) => {
		expectInvalid((record) => {
			record.schemaVersion = schemaVersion;
		});
	});

	it.each([
		['wrong puzzle id', (record: Record<string, unknown>) => (record.puzzleId = 'other')],
		['unknown source', (record: Record<string, unknown>) => (record.source = 'disk')],
		['source mismatch', (record: Record<string, unknown>) => (record.source = 'local')],
		['unknown lifecycle', (record: Record<string, unknown>) => (record.lifecycle = 'disposed')],
		['unknown mode', (record: Record<string, unknown>) => (record.mode = 'turbo')],
		['unknown origin', (record: Record<string, unknown>) => (record.origin = 'imported')],
		['unknown timing quality', (record: Record<string, unknown>) => (record.timingQuality = 'guess')],
		['unknown result class', (record: Record<string, unknown>) => (record.resultClass = 'invalid')],
		['invalid run id', (record: Record<string, unknown>) => (record.runId = 'not-a-run-id')]
	] as const)('rejects %s', (_name: string, mutate: (record: Record<string, unknown>) => void) => {
		expectInvalid(mutate);
	});

	it.each([
		['string elapsed time', '5'],
		['negative elapsed time', -1],
		['fractional elapsed time', 1.5]
	])('rejects %s', (_name: string, elapsed: unknown) => {
		expectInvalid((record) => {
			record.elapsedActiveSeconds = elapsed;
		});
	});

	it('rejects elapsed time in relaxed mode', () => {
		expectInvalid((record) => {
			record.mode = 'relaxed';
			record.resultClass = 'relaxed';
			record.elapsedActiveSeconds = 1;
		});
	});

	it('rejects elapsed time for legacy-unknown timing', () => {
		expectInvalid((record) => {
			record.timingQuality = 'legacy_unknown';
			record.elapsedActiveSeconds = 1;
		});
	});

	it('rejects a non-boolean timerStarted value', () => {
		expectInvalid((record) => {
			record.timerStarted = 'yes';
		});
	});

	it('rejects a started timer for legacy-unknown timing', () => {
		expectInvalid((record) => {
			record.timingQuality = 'legacy_unknown';
			record.elapsedActiveSeconds = null;
			record.timerStarted = true;
		});
	});

	it.each([
		['string lastUpdated', '1000'],
		['negative lastUpdated', -1],
		['fractional lastUpdated', 1.5]
	])('rejects %s', (_name: string, lastUpdated: unknown) => {
		expectInvalid((record) => {
			record.lastUpdated = lastUpdated;
		});
	});

	it.each([
		['non-array placements', {}],
		['non-object placement', [null]],
		['non-integer piece id', [{ pieceId: '0', x: 0, y: 0 }]],
		['non-integer x', [{ pieceId: 0, x: '0', y: 0 }]],
		['non-integer y', [{ pieceId: 0, x: 0, y: '0' }]],
		['unknown piece id', [{ pieceId: 99, x: 0, y: 0 }]],
		[
			'duplicate piece id',
			[
				{ pieceId: 0, x: 0, y: 0 },
				{ pieceId: 0, x: 1, y: 0 }
			]
		],
		['negative placement coordinate', [{ pieceId: 0, x: -1, y: 0 }]],
		['out-of-bounds placement coordinate', [{ pieceId: 0, x: 0, y: 2 }]]
	])('rejects %s', (_name: string, placedPieces: unknown) => {
		expectInvalid((record) => {
			record.placedPieces = placedPieces;
		});
	});

	it.each([
		['non-array tray order', {}],
		['wrong tray order length', [0, 1, 2]],
		['non-integer tray id', [0, 1, 2, '3']],
		['unknown tray id', [0, 1, 2, 99]],
		['duplicate tray id', [0, 1, 2, 2]]
	])('rejects %s', (_name: string, trayOrder: unknown) => {
		expectInvalid((record) => {
			record.trayOrder = trayOrder;
		});
	});

	it('rejects a non-boolean rotationEnabled value', () => {
		expectInvalid((record) => {
			record.rotationEnabled = 1;
		});
	});

	it.each([
		['non-object rotations', null],
		['non-integer rotation key', { bad: 90 }],
		['unknown rotation piece id', { 99: 90 }],
		['unsupported rotation value', { 0: 45 }]
	])('rejects %s', (_name: string, pieceRotations: unknown) => {
		expectInvalid((record) => {
			record.pieceRotations = pieceRotations;
		});
	});

	it.each([
		['non-object counters', null],
		['non-number incorrectAttempts', { incorrectAttempts: '0', hintsUsed: 0, referenceActivations: 0 }],
		['fractional incorrectAttempts', { incorrectAttempts: 0.5, hintsUsed: 0, referenceActivations: 0 }],
		['negative incorrectAttempts', { incorrectAttempts: -1, hintsUsed: 0, referenceActivations: 0 }],
		['non-number hintsUsed', { incorrectAttempts: 0, hintsUsed: '0', referenceActivations: 0 }],
		['fractional hintsUsed', { incorrectAttempts: 0, hintsUsed: 0.5, referenceActivations: 0 }],
		['negative hintsUsed', { incorrectAttempts: 0, hintsUsed: -1, referenceActivations: 0 }],
		['non-number referenceActivations', { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: '0' }],
		['fractional referenceActivations', { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0.5 }],
		['negative referenceActivations', { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: -1 }]
	])('rejects %s', (_name: string, counters: unknown) => {
		expectInvalid((record) => {
			record.counters = counters;
		});
	});

	it.each([
		['non-object facts', null],
		['non-boolean rotationUsed', { rotationUsed: 1, hintUsed: false, ghostReferenceUsed: false }],
		['non-boolean hintUsed', { rotationUsed: false, hintUsed: 1, ghostReferenceUsed: false }],
		['non-boolean ghostReferenceUsed', { rotationUsed: false, hintUsed: false, ghostReferenceUsed: 1 }]
	])('rejects %s', (_name: string, facts: unknown) => {
		expectInvalid((record) => {
			record.facts = facts;
		});
	});

	it('rejects a non-boolean hasUserActivity value', () => {
		expectInvalid((record) => {
			record.hasUserActivity = 1;
		});
	});

	it('rejects a completed lifecycle without a seal', () => {
		expectInvalid((record) => {
			record.lifecycle = 'completed';
		});
	});

	it('rejects a non-object completion seal', () => {
		expectInvalid((record) => {
			record.lifecycle = 'completed';
			record.sealedCompletion = 'sealed';
		});
	});

	it.each([
		['run id mismatch', { runId: '22222222-2222-4222-8222-222222222222' }],
		['invalid result class', { resultClass: 'invalid' }],
		['invalid timing quality', { timingQuality: 'invalid' }],
		['invalid completedAt', { completedAt: '1000' }],
		['invalid elapsed time', { elapsedActiveSeconds: '5' }],
		['negative sealed elapsed time', { elapsedActiveSeconds: -1 }],
		['invalid local stats effect', { localStats: 'done' }],
		['invalid server effect', { serverSubmission: 'done' }],
		['failed local effect without code', { localStats: { status: 'failed', retryable: true } }],
		['failed server effect without retryable', { serverSubmission: { status: 'failed', code: 'network_error' } }]
	])('rejects a seal with %s', (_name: string, patch: Record<string, unknown>) => {
		expectInvalid((record) => {
			const seal = {
				runId: RUN_ID,
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 5,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' },
				...(patch as Record<string, unknown>)
			};
			record.lifecycle = 'completed';
			record.sealedCompletion = seal;
		});
	});

	it.each([
		['non-object organization', null],
		['invalid filter', { filter: 'invalid' }],
		['non-string active tray', { activeTray: 1 }],
		['array membership', { membership: [] }],
		['array names', { names: [] }]
	])('rejects %s', (_name: string, organization: unknown) => {
		expectInvalid((record) => {
			record.organization = organization;
		});
	});

	it('loads valid completion effect states and defaults partial organization fields', () => {
		const record = cloneRecord();
		record.lifecycle = 'completed';
		record.sealedCompletion = {
			runId: RUN_ID,
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 5,
			completedAt: 1_000,
			localStats: { status: 'failed', code: 'storage_error', retryable: true },
			serverSubmission: { status: 'pending' }
		};
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

	it('defaults null completion effects to not-applicable', () => {
		const record = cloneRecord();
		record.lifecycle = 'completed';
		record.sealedCompletion = {
			runId: RUN_ID,
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: null,
			completedAt: 1_000,
			localStats: null,
			serverSubmission: null
		};

		const result = load(record);

		expect(result.status).toBe('loaded');
		if (result.status === 'loaded') {
			expect(result.snapshot.sealedCompletion?.localStats).toEqual({ status: 'not_applicable' });
			expect(result.snapshot.sealedCompletion?.serverSubmission).toEqual({
				status: 'not_applicable'
			});
		}
	});
});

describe('PuzzleSession legacy migration edge cases', () => {
	it('rejects a legacy record for another puzzle', () => {
		expect(load({ puzzleId: 'other', placedPieces: [] }).status).toBe('invalid');
	});

	it('rejects invalid legacy placements', () => {
		expect(load({ puzzleId: 'pz1', placedPieces: [{ pieceId: 99, x: 0, y: 0 }] }).status).toBe(
			'invalid'
		);
	});

	it('rejects invalid legacy rotations', () => {
		expect(
			load({ puzzleId: 'pz1', placedPieces: [], pieceRotations: { 0: 45 } }).status
		).toBe('invalid');
	});

	it('normalizes a positive numeric legacy timestamp', () => {
		const result = load({ puzzleId: 'pz1', placedPieces: [], lastUpdated: 12.9 });
		expect(result.status).toBe('migrated');
		if (result.status === 'migrated') {
			expect(result.snapshot.lastUpdated).toBe(12);
		}
	});

	it('uses zero for an invalid legacy timestamp', () => {
		const result = load({ puzzleId: 'pz1', placedPieces: [], lastUpdated: 'invalid' });
		expect(result.status).toBe('migrated');
		if (result.status === 'migrated') {
			expect(result.snapshot.lastUpdated).toBe(0);
		}
	});

	it('marks a completed local legacy puzzle as not applicable for server submission', () => {
		const localContext: SessionValidationContext = { ...context, source: 'local' };
		const result = load(
			{
				puzzleId: 'pz1',
				placedPieces: [
					{ pieceId: 0, x: 0, y: 0 },
					{ pieceId: 1, x: 1, y: 0 },
					{ pieceId: 2, x: 0, y: 1 },
					{ pieceId: 3, x: 1, y: 1 }
				]
			},
			localContext
		);
		expect(result.status).toBe('migrated');
		if (result.status === 'migrated') {
			expect(result.snapshot.sealedCompletion?.serverSubmission).toEqual({
				status: 'not_applicable'
			});
		}
	});
});

describe('PuzzleSession persistence adapter and cloning', () => {
	it('reports storage read and remove failures', () => {
		const errors: SessionPersistenceError[] = [];
		const storage = {
			length: 0,
			key: () => null,
			getItem: () => {
				throw new Error('read failed');
			},
			setItem: () => {},
			removeItem: () => {
				throw new Error('remove failed');
			},
			clear: () => {}
		} satisfies Storage;
		const adapter = createSessionStorageAdapter({ storage, onError: (error) => errors.push(error) });

		expect(adapter.loadSession('pz1', context).status).toBe('missing');
		expect(() => adapter.clearSession('pz1')).not.toThrow();
		expect(errors.map((error) => error.kind)).toEqual(['read_error', 'remove_error']);
	});

	it('serializes cloned organization, placement, rotation, counter, fact, and seal data', () => {
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
				timingQuality: 'known',
				elapsedActiveSeconds: 5,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
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
		expect(snapshot.sealedCompletion).toEqual(state.sealedCompletion);
	});
});
