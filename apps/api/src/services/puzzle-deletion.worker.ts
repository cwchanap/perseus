import { deletePuzzleFamilyOwnership } from '@perseus/shared';
import { getWorkerDbContext } from '../db.worker';
import type { Env } from '../worker';
import { deleteCleanupRecord, writeCleanupRecord, type CleanupRecord } from './storage.worker';

export async function ensureWorkerPuzzleDeletionFence(
	env: Env,
	record: CleanupRecord,
	deletedAt = Date.now()
): Promise<void> {
	await writeCleanupRecord(env.PUZZLE_METADATA, record);
	await getWorkerDbContext(env).completionWrites.beginPuzzleDeletion(record.puzzleId, deletedAt);
}

export async function finishWorkerPuzzleDeletion(
	env: Env,
	puzzleId: string,
	ownershipId?: string
): Promise<void> {
	const { db, completionWrites } = getWorkerDbContext(env);
	await completionWrites.finishPuzzleDeletion(puzzleId);
	await deletePuzzleFamilyOwnership(db, ownershipId ?? puzzleId);
	await deleteCleanupRecord(env.PUZZLE_METADATA, puzzleId);
}
