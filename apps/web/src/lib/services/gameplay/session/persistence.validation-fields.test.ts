import { describe, expect, it } from 'vitest';
import { loadPersistedSession } from './persistence';
import type { PersistedPuzzleSessionV1, SessionValidationContext } from './types';

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

function load(value: unknown) {
	return loadPersistedSession(JSON.stringify(value), context);
}

function expectInvalid(mutator: (record: Record<string, unknown>) => void): void {
	const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
	mutator(record);
	expect(load(record).status).toBe('invalid');
}

describe('PuzzleSession persisted field validation', () => {
	it.each([null, 42, 'snapshot'])('rejects non-object payload %j', (value: unknown) => {
		expect(load(value).status).toBe('invalid');
	});

	it.each(['1', 1.5, 0])('rejects schema version %j', (schemaVersion: unknown) => {
		expectInvalid((record) => {
			record.schemaVersion = schemaVersion;
		});
	});

	it.each([
		(record: Record<string, unknown>) => (record.puzzleId = 'other'),
		(record: Record<string, unknown>) => (record.source = 'disk'),
		(record: Record<string, unknown>) => (record.source = 'local'),
		(record: Record<string, unknown>) => (record.lifecycle = 'disposed'),
		(record: Record<string, unknown>) => (record.mode = 'turbo'),
		(record: Record<string, unknown>) => (record.origin = 'imported'),
		(record: Record<string, unknown>) => (record.timingQuality = 'guess'),
		(record: Record<string, unknown>) => (record.resultClass = 'invalid'),
		(record: Record<string, unknown>) => (record.runId = 'not-a-run-id')
	])('rejects an invalid identity field', (mutate) => {
		expectInvalid(mutate);
	});

	it.each(['5', -1, 1.5])('rejects elapsed value %j', (elapsed: unknown) => {
		expectInvalid((record) => {
			record.elapsedActiveSeconds = elapsed;
		});
	});

	it('rejects elapsed time in relaxed and legacy-unknown modes', () => {
		expectInvalid((record) => {
			record.mode = 'relaxed';
			record.resultClass = 'relaxed';
			record.elapsedActiveSeconds = 1;
		});
		expectInvalid((record) => {
			record.timingQuality = 'legacy_unknown';
			record.elapsedActiveSeconds = 1;
		});
	});

	it('rejects invalid timer state', () => {
		expectInvalid((record) => {
			record.timerStarted = 'yes';
		});
		expectInvalid((record) => {
			record.timingQuality = 'legacy_unknown';
			record.elapsedActiveSeconds = null;
			record.timerStarted = true;
		});
	});

	it.each(['1000', -1, 1.5])('rejects lastUpdated value %j', (lastUpdated: unknown) => {
		expectInvalid((record) => {
			record.lastUpdated = lastUpdated;
		});
	});

	it.each([
		{},
		[null],
		[{ pieceId: '0', x: 0, y: 0 }],
		[{ pieceId: 0, x: '0', y: 0 }],
		[{ pieceId: 0, x: 0, y: '0' }],
		[{ pieceId: 99, x: 0, y: 0 }],
		[
			{ pieceId: 0, x: 0, y: 0 },
			{ pieceId: 0, x: 1, y: 0 }
		],
		[{ pieceId: 0, x: -1, y: 0 }],
		[{ pieceId: 0, x: 0, y: 2 }]
	])('rejects invalid placements %j', (placedPieces: unknown) => {
		expectInvalid((record) => {
			record.placedPieces = placedPieces;
		});
	});

	it.each([{}, [0, 1, 2], [0, 1, 2, '3'], [0, 1, 2, 99], [0, 1, 2, 2]])(
		'rejects invalid tray order %j',
		(trayOrder: unknown) => {
			expectInvalid((record) => {
				record.trayOrder = trayOrder;
			});
		}
	);

	it('rejects an invalid rotation mode value', () => {
		expectInvalid((record) => {
			record.rotationEnabled = 1;
		});
	});

	it.each([null, { bad: 90 }, { 99: 90 }, { 0: 45 }])(
		'rejects invalid rotations %j',
		(pieceRotations: unknown) => {
			expectInvalid((record) => {
				record.pieceRotations = pieceRotations;
			});
		}
	);

	it.each([
		null,
		{ incorrectAttempts: '0', hintsUsed: 0, referenceActivations: 0 },
		{ incorrectAttempts: 0.5, hintsUsed: 0, referenceActivations: 0 },
		{ incorrectAttempts: -1, hintsUsed: 0, referenceActivations: 0 },
		{ incorrectAttempts: 0, hintsUsed: '0', referenceActivations: 0 },
		{ incorrectAttempts: 0, hintsUsed: 0.5, referenceActivations: 0 },
		{ incorrectAttempts: 0, hintsUsed: -1, referenceActivations: 0 },
		{ incorrectAttempts: 0, hintsUsed: 0, referenceActivations: '0' },
		{ incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0.5 },
		{ incorrectAttempts: 0, hintsUsed: 0, referenceActivations: -1 }
	])('rejects invalid counters %j', (counters: unknown) => {
		expectInvalid((record) => {
			record.counters = counters;
		});
	});

	it.each([
		null,
		{ rotationUsed: 1, hintUsed: false, ghostReferenceUsed: false },
		{ rotationUsed: false, hintUsed: 1, ghostReferenceUsed: false },
		{ rotationUsed: false, hintUsed: false, ghostReferenceUsed: 1 }
	])('rejects invalid facts %j', (facts: unknown) => {
		expectInvalid((record) => {
			record.facts = facts;
		});
	});

	it('rejects an invalid activity flag', () => {
		expectInvalid((record) => {
			record.hasUserActivity = 1;
		});
	});
});
