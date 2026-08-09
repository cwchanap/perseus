import { describe, expect, it } from 'vitest';
import { expectInvalid, load } from './persistence.test-fixtures';

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
		{ name: 'puzzleId', mutate: (r: Record<string, unknown>) => (r.puzzleId = 'other') },
		{ name: 'source=disk', mutate: (r: Record<string, unknown>) => (r.source = 'disk') },
		{ name: 'source=local', mutate: (r: Record<string, unknown>) => (r.source = 'local') },
		{
			name: 'lifecycle=disposed',
			mutate: (r: Record<string, unknown>) => (r.lifecycle = 'disposed')
		},
		{ name: 'mode=turbo', mutate: (r: Record<string, unknown>) => (r.mode = 'turbo') },
		{ name: 'origin=imported', mutate: (r: Record<string, unknown>) => (r.origin = 'imported') },
		{
			name: 'resultClass=invalid',
			mutate: (r: Record<string, unknown>) => (r.resultClass = 'invalid')
		},
		{ name: 'runId', mutate: (r: Record<string, unknown>) => (r.runId = 'not-a-run-id') }
	])('rejects an invalid identity field: $name', ({ mutate }) => {
		expectInvalid(mutate);
	});

	it.each(['5', -1, 1.5])('rejects elapsed value %j', (elapsed: unknown) => {
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

	it('rejects invalid timer state', () => {
		expectInvalid((record) => {
			record.timerStarted = 'yes';
		});
	});

	it.each(['1000', -1, 1.5])('rejects lastUpdated value %j', (lastUpdated: unknown) => {
		expectInvalid((record) => {
			record.lastUpdated = lastUpdated;
		});
	});

	it.each([
		[{}],
		[[null]],
		[[{ pieceId: '0', x: 0, y: 0 }]],
		[[{ pieceId: 0, x: '0', y: 0 }]],
		[[{ pieceId: 0, x: 0, y: '0' }]],
		[[{ pieceId: 99, x: 0, y: 0 }]],
		[
			[
				{ pieceId: 0, x: 0, y: 0 },
				{ pieceId: 0, x: 1, y: 0 }
			]
		],
		[[{ pieceId: 0, x: -1, y: 0 }]],
		[[{ pieceId: 0, x: 0, y: 2 }]]
	])('rejects invalid placements %j', (placedPieces: unknown) => {
		expectInvalid((record) => {
			record.placedPieces = placedPieces;
		});
	});

	it.each([[{}], [[0, 1, 2]], [[0, 1, 2, '3']], [[0, 1, 2, 99]], [[0, 1, 2, 2]]])(
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

	it('rejects rotation enabled without the rotationUsed fact', () => {
		expectInvalid((record) => {
			record.rotationEnabled = true;
			// facts.rotationUsed stays false; resultClass stays standard_timed
		});
	});

	it('rejects a hint count without the hintUsed fact', () => {
		expectInvalid((record) => {
			record.counters = { incorrectAttempts: 0, hintsUsed: 3, referenceActivations: 0 };
			// facts.hintUsed stays false
		});
	});

	it('rejects the hintUsed fact without a positive hint count', () => {
		expectInvalid((record) => {
			record.facts = { rotationUsed: false, hintUsed: true, ghostReferenceUsed: false };
			record.resultClass = 'assisted_timed';
			// counters.hintsUsed stays 0
		});
	});

	it('rejects ghostReferenceUsed without a reference activation', () => {
		expectInvalid((record) => {
			record.facts = { rotationUsed: false, hintUsed: false, ghostReferenceUsed: true };
			record.resultClass = 'assisted_timed';
			// counters.referenceActivations stays 0
		});
	});

	it('rejects placements without user activity', () => {
		expectInvalid((record) => {
			record.hasUserActivity = false;
			// placedPieces stays non-empty
		});
	});
});
