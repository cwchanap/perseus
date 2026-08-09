import { describe, expect, it } from 'vitest';
import {
	context,
	expectInvalid,
	load,
	seal,
	validSnapshot,
	fullBoardPlacements
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
