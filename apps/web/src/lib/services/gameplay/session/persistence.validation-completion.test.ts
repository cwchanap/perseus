import { describe, expect, it } from 'vitest';
import { context, expectInvalid, load, seal, validSnapshot } from './persistence.test-fixtures';

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

	it('rejects null completion effects instead of defaulting to not-applicable', () => {
		// A null effect is corruption: the engine and legacy migration always
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
