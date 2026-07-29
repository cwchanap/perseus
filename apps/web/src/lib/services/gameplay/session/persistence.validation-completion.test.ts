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

function load(value: unknown, ctx: SessionValidationContext = context) {
	return loadPersistedSession(JSON.stringify(value), ctx);
}

function expectInvalid(mutator: (record: Record<string, unknown>) => void): void {
	const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
	mutator(record);
	expect(load(record).status).toBe('invalid');
}

function seal(patch: Record<string, unknown> = {}) {
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
		{ timingQuality: 'invalid' },
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

	it('defaults null completion effects to not-applicable', () => {
		const record = JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
		record.lifecycle = 'completed';
		record.sealedCompletion = seal({
			elapsedActiveSeconds: null,
			localStats: null,
			serverSubmission: null
		});

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
	it('rejects mismatched puzzle data and invalid legacy state', () => {
		expect(load({ puzzleId: 'other', placedPieces: [] }).status).toBe('invalid');
		expect(load({ puzzleId: 'pz1', placedPieces: [{ pieceId: 99, x: 0, y: 0 }] }).status).toBe(
			'invalid'
		);
		expect(load({ puzzleId: 'pz1', placedPieces: [], pieceRotations: { 0: 45 } }).status).toBe(
			'invalid'
		);
	});

	it('normalizes numeric and invalid legacy timestamps', () => {
		const numeric = load({ puzzleId: 'pz1', placedPieces: [], lastUpdated: 12.9 });
		const invalid = load({ puzzleId: 'pz1', placedPieces: [], lastUpdated: 'invalid' });

		expect(numeric.status).toBe('migrated');
		expect(invalid.status).toBe('migrated');
		if (numeric.status === 'migrated' && invalid.status === 'migrated') {
			expect(numeric.snapshot.lastUpdated).toBe(12);
			expect(invalid.snapshot.lastUpdated).toBe(0);
		}
	});

	it('marks a completed local legacy puzzle as not applicable for server submission', () => {
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
			{ ...context, source: 'local' }
		);

		expect(result.status).toBe('migrated');
		if (result.status === 'migrated') {
			expect(result.snapshot.sealedCompletion?.serverSubmission).toEqual({
				status: 'not_applicable'
			});
		}
	});
});
