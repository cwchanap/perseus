import {
	completionRequestFromSeal,
	type RecordPuzzleCompletionV2,
	type SealedCompletion
} from '@perseus/game-core';
import {
	MAX_COMPLETION_TIME_SECONDS,
	isPuzzleId,
	isRecordPuzzleCompletionV2
} from '@perseus/types';
import { createFileKeyValueStore, type FileOps } from '../storage/fileStore';

export type CompletionSyncStatus = 'local_only' | 'pending' | 'synced' | 'terminal';

export interface MobileCompletionRecordV1 {
	version: 1;
	runId: string;
	puzzleId: string;
	completedAt: number;
	accountId: string | null;
	request: RecordPuzzleCompletionV2;
	syncStatus: CompletionSyncStatus;
}

export interface CompletionStore {
	recordCompletion(input: {
		puzzleId: string;
		seal: SealedCompletion;
		accountId: string | null;
	}): MobileCompletionRecordV1;
	listPendingForAccount(accountId: string): MobileCompletionRecordV1[];
	markSynced(runId: string): void;
	markTerminal(runId: string): void;
}

const SYNC_STATUSES: readonly string[] = ['local_only', 'pending', 'synced', 'terminal'];

function parseRecord(runId: string, raw: string): MobileCompletionRecordV1 | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;
	const record = value as MobileCompletionRecordV1;
	if (record.version !== 1) return null;
	if (record.runId !== runId) return null;
	if (!isPuzzleId(record.puzzleId)) return null;
	if (!isRecordPuzzleCompletionV2(record.request, MAX_COMPLETION_TIME_SECONDS)) return null;
	if (
		record.accountId !== null &&
		(typeof record.accountId !== 'string' || record.accountId === '')
	) {
		return null;
	}
	if (!SYNC_STATUSES.includes(record.syncStatus)) return null;
	return record;
}

export function createCompletionStore(options: {
	rootPath: string;
	fileOps: FileOps;
}): CompletionStore {
	const store = createFileKeyValueStore(options);

	const updateStatus = (runId: string, syncStatus: CompletionSyncStatus): void => {
		const raw = store.getItem(runId);
		if (raw === null) return;
		const record = parseRecord(runId, raw);
		if (record === null) return;
		store.setItem(runId, JSON.stringify({ ...record, syncStatus }));
	};

	return {
		recordCompletion(input) {
			const record: MobileCompletionRecordV1 = {
				version: 1,
				runId: input.seal.runId,
				puzzleId: input.puzzleId,
				completedAt: input.seal.completedAt,
				accountId: input.accountId,
				request: completionRequestFromSeal(input.seal),
				syncStatus: input.accountId === null ? 'local_only' : 'pending'
			};
			store.setItem(record.runId, JSON.stringify(record));
			return record;
		},
		listPendingForAccount(accountId) {
			const pending: MobileCompletionRecordV1[] = [];
			for (const fileName of options.fileOps.list(options.rootPath)) {
				if (!fileName.endsWith('.json')) continue;
				const runId = fileName.slice(0, -'.json'.length);
				const raw = store.getItem(runId);
				if (raw === null) continue;
				const record = parseRecord(runId, raw);
				if (record === null) {
					store.removeItem(runId);
					continue;
				}
				if (record.accountId === accountId && record.syncStatus === 'pending') {
					pending.push(record);
				}
			}
			return pending.sort((a, b) => a.completedAt - b.completedAt || (a.runId < b.runId ? -1 : 1));
		},
		markSynced: (runId) => updateStatus(runId, 'synced'),
		markTerminal: (runId) => updateStatus(runId, 'terminal')
	};
}
