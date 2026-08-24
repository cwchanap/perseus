import { describe, expect, it } from 'vitest';
import type { PersistedPuzzleSessionV1 } from './types';
import { load, validSnapshot } from './codec.test-fixtures';

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
		[
			'positive elapsed time',
			// A timed run whose timer never started cannot have accumulated
			// time; accepting it would let a fabricated snapshot restore a
			// positive clock and later continue timing from it.
			{ elapsedActiveSeconds: 30 }
		],
		['completed lifecycle', { lifecycle: 'completed' }]
	] as const)('rejects a false-activity snapshot with %s', (_name, patch) => {
		expect(load({ ...configuredRotation('active'), ...patch }).status).toBe('invalid');
	});

	it('rejects a configured-rotation snapshot with rotationEnabled: false and residual rotations', () => {
		// configure_setup clears both the rotation map and the rotation fact
		// when rotation is disabled, so rotationEnabled: false alongside a
		// non-empty pieceRotations map and rotationUsed: true is corruption.
		// Without requiring rotationEnabled in the pre-activity exception,
		// such a malformed snapshot would load with rotation shown as
		// disabled while retaining rotation_timed eligibility.
		const malformed = {
			...configuredRotation('active'),
			rotationEnabled: false,
			pieceRotations: { 0: 90, 1: 180, 2: 270, 3: 0 },
			facts: { rotationUsed: true, hintUsed: false, ghostReferenceUsed: false },
			resultClass: 'rotation_timed' as const
		};
		expect(load(malformed).status).toBe('invalid');
	});
});
