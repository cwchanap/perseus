import { describe, expect, it } from 'vitest';
import { completionRequestFromSeal, type SealedCompletion } from '@perseus/game-core';
import type { FileOps } from '../storage/fileStore';
import { createCompletionStore, type MobileCompletionRecordV1 } from './completionStore';

const ROOT = '/Documents/perseus/completions';
const PUZZLE_ID = '123e4567-e89b-42d3-a456-426614174000';
const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-9222-222222222222';
const RUN_C = '33333333-3333-4333-a333-333333333333';
const RUN_D = '44444444-4444-4444-b444-444444444444';

/**
 * In-memory FileOps whose replace/remove actually mutate the virtual
 * directory, so list-after-write behaves like the real filesystem.
 */
function fakeFileOps(): FileOps {
	const files = new Map<string, string>();
	return {
		readText: (path) => files.get(path) ?? null,
		writeText: (path, content) => {
			files.set(path, content);
		},
		replace: (fromPath, toPath) => {
			const content = files.get(fromPath);
			if (content === undefined) throw new Error(`replace: missing ${fromPath}`);
			files.delete(fromPath);
			files.set(toPath, content);
		},
		remove: (path) => {
			files.delete(path);
		},
		list: (rootPath) => {
			const prefix = rootPath ? `${rootPath.replace(/\/+$/, '')}/` : '';
			return Array.from(files.keys())
				.filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
				.map((path) => path.slice(prefix.length))
				.sort();
		}
	};
}

function seal(runId: string, completedAt: number): SealedCompletion {
	return {
		runId,
		resultClass: 'standard_timed',
		elapsedActiveSeconds: 5,
		completedAt,
		localStats: { status: 'succeeded' },
		serverSubmission: { status: 'succeeded' },
		hintsUsed: 0,
		incorrectAttempts: 0,
		rotationEnabled: false,
		rotationUsed: false
	};
}

function createStore() {
	const fileOps = fakeFileOps();
	return { fileOps, store: createCompletionStore({ rootPath: ROOT, fileOps }) };
}

function readRecord(fileOps: FileOps, runId: string): MobileCompletionRecordV1 | null {
	const raw = fileOps.readText(`${ROOT}/${runId}.json`);
	return raw === null ? null : (JSON.parse(raw) as MobileCompletionRecordV1);
}

function writeRaw(fileOps: FileOps, runId: string, record: Record<string, unknown>): void {
	fileOps.writeText(`${ROOT}/${runId}.json`, JSON.stringify(record));
}

function validRecord(runId: string): Record<string, unknown> {
	return {
		version: 1,
		runId,
		puzzleId: PUZZLE_ID,
		completedAt: 1_000,
		accountId: 'account-a',
		request: completionRequestFromSeal(seal(runId, 1_000)),
		syncStatus: 'pending'
	};
}

describe('recordCompletion', () => {
	it('persists signed-out completions as local_only and never lists them', () => {
		const { fileOps, store } = createStore();
		const completed = seal(RUN_A, 1_000);

		const record = store.recordCompletion({
			puzzleId: PUZZLE_ID,
			seal: completed,
			accountId: null
		});

		expect(record.syncStatus).toBe('local_only');
		expect(record.accountId).toBeNull();
		expect(record.request).toEqual(completionRequestFromSeal(completed));
		expect(record.completedAt).toBe(completed.completedAt);
		expect(readRecord(fileOps, RUN_A)).toEqual(record);
		expect(store.listPendingForAccount('account-a')).toEqual([]);
	});

	it('persists signed-in completions as pending in the same file', () => {
		const { fileOps, store } = createStore();
		const completed = seal(RUN_A, 1_000);

		const record = store.recordCompletion({
			puzzleId: PUZZLE_ID,
			seal: completed,
			accountId: 'account-a'
		});

		expect(record.syncStatus).toBe('pending');
		expect(record.accountId).toBe('account-a');
		expect(record.request).toEqual(completionRequestFromSeal(completed));
		expect(record.completedAt).toBe(completed.completedAt);
		expect(readRecord(fileOps, RUN_A)).toEqual(record);
		expect(store.listPendingForAccount('account-a')).toEqual([record]);
	});
});

describe('current-format validation', () => {
	function expectRejected(runId: string, record: Record<string, unknown>): void {
		const { fileOps, store } = createStore();
		writeRaw(fileOps, runId, record);
		expect(store.listPendingForAccount('account-a')).toEqual([]);
		expect(fileOps.readText(`${ROOT}/${runId}.json`)).toBeNull();
	}

	it('removes records whose version is not 1', () => {
		expectRejected(RUN_A, { ...validRecord(RUN_A), version: 2 });
	});

	it('removes records whose runId does not match the file name', () => {
		expectRejected(RUN_A, validRecord(RUN_B));
	});

	it('removes records whose runId does not match the request runId', () => {
		expectRejected(RUN_A, {
			...validRecord(RUN_A),
			request: completionRequestFromSeal(seal(RUN_B, 1_000))
		});
	});

	it('removes records with a non-finite completedAt', () => {
		expectRejected(RUN_A, { ...validRecord(RUN_A), completedAt: 'abc' });
		expectRejected(RUN_B, { ...validRecord(RUN_B), completedAt: Number.NaN });
	});

	it('removes records whose puzzleId is not a puzzle id', () => {
		expectRejected(RUN_A, { ...validRecord(RUN_A), puzzleId: 'pz1' });
	});

	it('removes records whose request fails V2 validation', () => {
		expectRejected(RUN_A, {
			...validRecord(RUN_A),
			request: { ...completionRequestFromSeal(seal(RUN_A, 1_000)), hintsUsed: -1 }
		});
	});

	it('removes records with an invalid accountId', () => {
		expectRejected(RUN_A, { ...validRecord(RUN_A), accountId: 42 });
		expectRejected(RUN_B, { ...validRecord(RUN_B), accountId: '' });
	});

	it('removes records with an unknown syncStatus', () => {
		expectRejected(RUN_A, { ...validRecord(RUN_A), syncStatus: 'queued' });
	});

	it('removes files that are not valid JSON', () => {
		const { fileOps, store } = createStore();
		fileOps.writeText(`${ROOT}/${RUN_A}.json`, '{not json');
		expect(store.listPendingForAccount('account-a')).toEqual([]);
		expect(fileOps.readText(`${ROOT}/${RUN_A}.json`)).toBeNull();
	});
});

describe('listPendingForAccount', () => {
	it('sorts by completedAt, filters by account and status, and applies status updates', () => {
		const { fileOps, store } = createStore();
		const late = store.recordCompletion({
			puzzleId: PUZZLE_ID,
			seal: seal(RUN_B, 2_000),
			accountId: 'account-a'
		});
		const early = store.recordCompletion({
			puzzleId: PUZZLE_ID,
			seal: seal(RUN_A, 1_000),
			accountId: 'account-a'
		});
		store.recordCompletion({
			puzzleId: PUZZLE_ID,
			seal: seal(RUN_C, 3_000),
			accountId: 'account-b'
		});
		store.recordCompletion({ puzzleId: PUZZLE_ID, seal: seal(RUN_D, 4_000), accountId: null });

		expect(store.listPendingForAccount('account-a')).toEqual([early, late]);
		// Valid records owned by other accounts survive the listing.
		expect(readRecord(fileOps, RUN_C)?.accountId).toBe('account-b');

		store.markSynced(RUN_A);
		expect(readRecord(fileOps, RUN_A)?.syncStatus).toBe('synced');
		store.markTerminal(RUN_B);
		expect(readRecord(fileOps, RUN_B)?.syncStatus).toBe('terminal');
		expect(store.listPendingForAccount('account-a')).toEqual([]);
	});

	it('breaks completedAt ties by runId', () => {
		const { store } = createStore();
		store.recordCompletion({
			puzzleId: PUZZLE_ID,
			seal: seal(RUN_B, 1_000),
			accountId: 'account-a'
		});
		store.recordCompletion({
			puzzleId: PUZZLE_ID,
			seal: seal(RUN_A, 1_000),
			accountId: 'account-a'
		});

		const listed = store.listPendingForAccount('account-a');
		expect(listed.map((record) => record.runId)).toEqual([RUN_A, RUN_B]);
	});
});
