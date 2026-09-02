import { describe, expect, it } from 'vitest';
import type { MobilePlayerSessionResponse } from '@perseus/types';
import type { PlayerApi, PlayerHttpResponse } from '../api/playerApi';
import type { FileOps } from '../storage/fileStore';
import { createCompletionStore, type CompletionStore } from './completionStore';
import { drainPendingCompletions } from './completionSync';
import type { PersistedMobileSession } from '../account/mobileAccount';
import type { SealedCompletion } from '@perseus/game-core';

const ROOT = '/Documents/perseus/completions';
const PUZZLE_ID = '123e4567-e89b-42d3-a456-426614174000';
const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-9222-222222222222';

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

function session(userId: string): PersistedMobileSession {
	return {
		version: 1,
		token: `token-${userId}`,
		expiresAt: Date.now() + 60_000,
		user: {
			id: userId,
			email: `${userId}@example.test`,
			createdAt: 1_710_000_000_000,
			lastLoginAt: 1_710_000_000_000
		},
		consecutiveUnauthenticated: 0
	};
}

interface SubmittedCall {
	puzzleId: string;
	token: string;
}

/**
 * PlayerApi whose submitCompletion replays a scripted queue of responses or
 * thrown (transport) errors, recording every submission. `calls` records the
 * start of each submission and `log` additionally records an await boundary
 * per call so a concurrent (non-sequential) drain cannot pass unnoticed.
 */
function fakeApi(
	script: Array<PlayerHttpResponse | Error>,
	calls: SubmittedCall[],
	log: string[] = []
): PlayerApi {
	return {
		exchangeGoogleIdToken: async (): Promise<MobilePlayerSessionResponse> => {
			throw new Error('unexpected exchangeGoogleIdToken');
		},
		getSession: async () => {
			throw new Error('unexpected getSession');
		},
		logout: async () => {
			throw new Error('unexpected logout');
		},
		submitCompletion: async (puzzleId, _request, token) => {
			calls.push({ puzzleId, token });
			const index = calls.length - 1;
			log.push(`start:${index}`);
			await new Promise((resolve) => setTimeout(resolve, 0));
			log.push(`end:${index}`);
			const next = script.shift();
			if (next === undefined) throw new Error('unexpected extra submitCompletion');
			if (next instanceof Error) throw next;
			return next;
		}
	};
}

function storeWith(
	records: Array<{ runId: string; accountId: string | null; completedAt: number }>
): {
	fileOps: FileOps;
	store: CompletionStore;
} {
	const fileOps = fakeFileOps();
	const store = createCompletionStore({ rootPath: ROOT, fileOps });
	for (const record of records) {
		store.recordCompletion({
			puzzleId: PUZZLE_ID,
			seal: seal(record.runId, record.completedAt),
			accountId: record.accountId
		});
	}
	return { fileOps, store };
}

function syncStatus(fileOps: FileOps, runId: string): string {
	const raw = fileOps.readText(`${ROOT}/${runId}.json`);
	if (raw === null) return 'missing';
	return (JSON.parse(raw) as { syncStatus: string }).syncStatus;
}

describe('drainPendingCompletions', () => {
	it('marks each 200 success synced and returns synced', async () => {
		const { fileOps, store } = storeWith([
			{ runId: RUN_A, accountId: 'player-1', completedAt: 1 },
			{ runId: RUN_B, accountId: 'player-1', completedAt: 2 }
		]);
		const calls: SubmittedCall[] = [];
		const log: string[] = [];
		const api = fakeApi(
			[
				{ status: 200, body: { ok: true } },
				{ status: 200, body: { replayed: true } }
			],
			calls,
			log
		);

		const disposition = await drainPendingCompletions({
			activeSession: session('player-1'),
			api,
			store
		});

		expect(disposition).toBe('synced');
		expect(syncStatus(fileOps, RUN_A)).toBe('synced');
		expect(syncStatus(fileOps, RUN_B)).toBe('synced');
		expect(store.listPendingForAccount('player-1')).toEqual([]);
		// Strictly sequential: each submission resolves before the next starts.
		expect(log).toEqual(['start:0', 'end:0', 'start:1', 'end:1']);
		expect(calls.every((call) => call.token === 'token-player-1')).toBe(true);
	});

	it.each([
		[
			'a 429 completion_quota_exceeded body',
			{ status: 429, body: { error: 'completion_quota_exceeded' } }
		] as const,
		['a 409 run_id_conflict', { status: 409, body: { error: 'run_id_conflict' } }] as const,
		['an unmapped 403', { status: 403, body: { error: 'forbidden' } }] as const
	])('treats %s as terminal, marks it terminal, and continues', async (_label, response) => {
		const { fileOps, store } = storeWith([
			{ runId: RUN_A, accountId: 'player-1', completedAt: 1 },
			{ runId: RUN_B, accountId: 'player-1', completedAt: 2 }
		]);
		const calls: SubmittedCall[] = [];
		const api = fakeApi([response, { status: 200, body: { ok: true } }], calls);

		const disposition = await drainPendingCompletions({
			activeSession: session('player-1'),
			api,
			store
		});

		// The terminal first record does not block the later pending record.
		expect(disposition).toBe('synced');
		expect(syncStatus(fileOps, RUN_A)).toBe('terminal');
		expect(syncStatus(fileOps, RUN_B)).toBe('synced');
		expect(calls).toHaveLength(2);
	});

	it.each([[500], [503]])(
		'treats a %d as retryable, keeps it pending, and stops',
		async (status) => {
			const { fileOps, store } = storeWith([
				{ runId: RUN_A, accountId: 'player-1', completedAt: 1 },
				{ runId: RUN_B, accountId: 'player-1', completedAt: 2 }
			]);
			const calls: SubmittedCall[] = [];
			const api = fakeApi([{ status, body: { error: 'internal_error' } }], calls);

			const disposition = await drainPendingCompletions({
				activeSession: session('player-1'),
				api,
				store
			});

			expect(disposition).toBe('retryable');
			expect(syncStatus(fileOps, RUN_A)).toBe('pending');
			expect(syncStatus(fileOps, RUN_B)).toBe('pending');
			expect(calls).toHaveLength(1);
		}
	);

	it('treats a transport rejection as retryable, keeps it pending, and stops', async () => {
		const { fileOps, store } = storeWith([
			{ runId: RUN_A, accountId: 'player-1', completedAt: 1 },
			{ runId: RUN_B, accountId: 'player-1', completedAt: 2 }
		]);
		const calls: SubmittedCall[] = [];
		const api = fakeApi([new Error('offline')], calls);

		const disposition = await drainPendingCompletions({
			activeSession: session('player-1'),
			api,
			store
		});

		expect(disposition).toBe('retryable');
		expect(syncStatus(fileOps, RUN_A)).toBe('pending');
		expect(syncStatus(fileOps, RUN_B)).toBe('pending');
		expect(calls).toHaveLength(1);
	});

	it('treats a 401 as auth_required, keeps it pending, and stops', async () => {
		const { fileOps, store } = storeWith([
			{ runId: RUN_A, accountId: 'player-1', completedAt: 1 },
			{ runId: RUN_B, accountId: 'player-1', completedAt: 2 }
		]);
		const calls: SubmittedCall[] = [];
		const api = fakeApi([{ status: 401, body: { error: 'unauthorized' } }], calls);

		const disposition = await drainPendingCompletions({
			activeSession: session('player-1'),
			api,
			store
		});

		expect(disposition).toBe('auth_required');
		expect(syncStatus(fileOps, RUN_A)).toBe('pending');
		expect(syncStatus(fileOps, RUN_B)).toBe('pending');
		expect(calls).toHaveLength(1);
	});

	it('never submits account A records with account B', async () => {
		const { fileOps, store } = storeWith([
			{ runId: RUN_A, accountId: 'player-1', completedAt: 1 },
			{ runId: RUN_B, accountId: 'player-2', completedAt: 2 }
		]);
		const calls: SubmittedCall[] = [];
		const api = fakeApi([{ status: 200, body: { ok: true } }], calls);

		const disposition = await drainPendingCompletions({
			activeSession: session('player-2'),
			api,
			store
		});

		expect(disposition).toBe('synced');
		expect(calls.map((call) => call.puzzleId)).toEqual([PUZZLE_ID]);
		expect(calls.every((call) => call.token === 'token-player-2')).toBe(true);
		// Account A's record is untouched.
		expect(syncStatus(fileOps, RUN_A)).toBe('pending');
		expect(syncStatus(fileOps, RUN_B)).toBe('synced');
	});

	it('returns empty without any submission when the account has nothing pending', async () => {
		const { store } = storeWith([{ runId: RUN_A, accountId: 'player-1', completedAt: 1 }]);
		const calls: SubmittedCall[] = [];
		const api = fakeApi([], calls);

		const disposition = await drainPendingCompletions({
			activeSession: session('player-2'),
			api,
			store
		});

		expect(disposition).toBe('empty');
		expect(calls).toHaveLength(0);
	});
});
