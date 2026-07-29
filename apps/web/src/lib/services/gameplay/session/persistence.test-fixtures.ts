import { expect } from 'vitest';
import { loadPersistedSession } from './persistence';
import type { PersistedPuzzleSessionV1, SessionValidationContext } from './types';

export const RUN_ID = '11111111-1111-4111-8111-111111111111';

export const context: SessionValidationContext = {
	puzzleId: 'pz1',
	source: 'api',
	pieceIds: [0, 1, 2, 3],
	gridCols: 2,
	gridRows: 2,
	pieceCount: 4
};

export function validSnapshot(): PersistedPuzzleSessionV1 {
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

export function load(value: unknown, ctx: SessionValidationContext = context) {
	return loadPersistedSession(JSON.stringify(value) ?? null, ctx);
}

export function expectInvalid(mutator: (record: Record<string, unknown>) => void): void {
	const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
	mutator(record);
	expect(load(record).status).toBe('invalid');
}

export function seal(patch: Record<string, unknown> = {}) {
	return {
		runId: RUN_ID,
		resultClass: 'standard_timed',
		timingQuality: 'known',
		elapsedActiveSeconds: 5,
		completedAt: 1_000,
		localStats: { status: 'succeeded' },
		serverSubmission: { status: 'succeeded' },
		...patch
	};
}

export function memoryStorage(store: Record<string, string>): Storage {
	return {
		get length() {
			return Object.keys(store).length;
		},
		key: (i: number) => Object.keys(store)[i] ?? null,
		getItem: (k: string) => (k in store ? store[k] : null),
		setItem: (k: string, v: string) => {
			store[k] = v;
		},
		removeItem: (k: string) => {
			delete store[k];
		},
		clear: () => {
			for (const key of Object.keys(store)) {
				delete store[key];
			}
		}
	};
}
