import { describe, expect, it } from 'vitest';
import type { PersistedPuzzleSessionV1 } from './types';
import { load, validSnapshot } from './persistence.test-fixtures';

function configuredRotation(
	lifecycle: PersistedPuzzleSessionV1['lifecycle']
): PersistedPuzzleSessionV1 {
	return {
		...validSnapshot(),
		lifecycle,
		elapsedActiveSeconds: 0,
		timerStarted: false,
		placedPieces: [],
		rotationEnabled: true,
		pieceRotations: { 0: 90, 1: 180, 2: 270, 3: 0 },
		counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
		facts: { rotationUsed: true, hintUsed: false, ghostReferenceUsed: false },
		hasUserActivity: false,
		resultClass: 'rotation_timed',
		sealedCompletion: null
	};
}

describe('pre-activity configured rotation validation', () => {
	it.each(['setup', 'active', 'paused'] as const)(
		'loads a configured rotation snapshot in %s lifecycle',
		(lifecycle) => {
			expect(load(configuredRotation(lifecycle))).toMatchObject({ status: 'loaded' });
		}
	);

	it.each([
		['started timer', { timerStarted: true }],
		['placed piece', { placedPieces: [{ pieceId: 0, x: 0, y: 0 }] }],
		[
			'incorrect attempt',
			{
				counters: { incorrectAttempts: 1, hintsUsed: 0, referenceActivations: 0 }
			}
		],
		[
			'hint use',
			{
				counters: { incorrectAttempts: 0, hintsUsed: 1, referenceActivations: 0 },
				facts: { rotationUsed: true, hintUsed: true, ghostReferenceUsed: false },
				resultClass: 'assisted_timed'
			}
		],
		['completed lifecycle', { lifecycle: 'completed' }]
	] as const)('rejects a false-activity snapshot with %s', (_name, patch) => {
		expect(load({ ...configuredRotation('active'), ...patch }).status).toBe('invalid');
	});
});
