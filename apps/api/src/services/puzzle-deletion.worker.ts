import { deletePuzzleFamilyOwnership } from '@perseus/shared';
import { PUZZLE_DIFFICULTIES } from '@perseus/types';
import { getWorkerDbContext } from '../db.worker';
import type { Env } from '../worker';
import {
	deleteCleanupRecord,
	writeCleanupRecord,
	type CleanupRecord,
	deleteMetadataDO,
	deleteFamilyMetadata,
	deletePuzzleMetadata,
	deleteFamilyCleanupAssets
} from './storage.worker';

export async function ensureWorkerPuzzleDeletionFence(
	env: Env,
	record: CleanupRecord,
	deletedAt = Date.now()
): Promise<void> {
	await writeCleanupRecord(env.PUZZLE_METADATA, record);
	const { completionWrites } = getWorkerDbContext(env);
	for (const difficulty of PUZZLE_DIFFICULTIES) {
		await completionWrites.beginPuzzleDeletion(record.variantIds[difficulty], deletedAt);
	}
}

export async function completeWorkerPuzzleDeletion(env: Env, record: CleanupRecord): Promise<void> {
	const { db, completionWrites } = getWorkerDbContext(env);
	await deletePuzzleFamilyOwnership(db, record.familyId);
	for (const difficulty of PUZZLE_DIFFICULTIES) {
		await completionWrites.finishPuzzleDeletion(record.variantIds[difficulty]);
	}
	await completionWrites.finishFamilyFirstClears(record.familyId);
}

export async function finishWorkerPuzzleDeletion(env: Env, record: CleanupRecord): Promise<void> {
	await completeWorkerPuzzleDeletion(env, record);
	await deleteCleanupRecord(env.PUZZLE_METADATA, record.familyId);
}

export type FamilySourceDeletionStepFailure = {
	ok: false;
	step: 'do-tombstone' | 'r2' | 'kv-family' | 'kv-variant' | 'finish' | 'release';
	error?: unknown;
	failedKeys?: string[];
};

export async function executeFamilySourceDeletion(
	env: Env,
	record: CleanupRecord,
	beforeRecordDelete?: () => Promise<void>
): Promise<{ ok: true } | FamilySourceDeletionStepFailure> {
	// Derive variant IDs from the shared difficulty list (same source as the
	// KV cleanup loop) so every configured variant is tombstoned — no
	// difficulty names hardcoded here.
	const doIds = [record.familyId, ...PUZZLE_DIFFICULTIES.map((d) => record.variantIds[d])];
	for (const doId of doIds) {
		try {
			await deleteMetadataDO(env.PUZZLE_METADATA_DO, doId);
		} catch (doErr) {
			return { ok: false, step: 'do-tombstone', error: doErr };
		}
	}

	const r2Result = await deleteFamilyCleanupAssets(
		env.PUZZLES_BUCKET,
		record.familyId,
		record.variantIds,
		record.pieceCounts
	);
	if (!r2Result.success) {
		return { ok: false, step: 'r2', failedKeys: r2Result.failedKeys };
	}

	const familyKv = await deleteFamilyMetadata(env.PUZZLE_METADATA, record.familyId);
	if (!familyKv.success) {
		return { ok: false, step: 'kv-family', error: familyKv.error };
	}

	for (const difficulty of PUZZLE_DIFFICULTIES) {
		const variantKv = await deletePuzzleMetadata(
			env.PUZZLE_METADATA,
			record.variantIds[difficulty]
		);
		if (!variantKv.success) {
			return { ok: false, step: 'kv-variant', error: variantKv.error };
		}
	}

	try {
		await completeWorkerPuzzleDeletion(env, record);
	} catch (finishErr) {
		return { ok: false, step: 'finish', error: finishErr };
	}

	if (beforeRecordDelete) {
		try {
			await beforeRecordDelete();
		} catch (releaseErr) {
			return { ok: false, step: 'release', error: releaseErr };
		}
	}

	try {
		await deleteCleanupRecord(env.PUZZLE_METADATA, record.familyId);
	} catch (recordErr) {
		return { ok: false, step: 'finish', error: recordErr };
	}

	return { ok: true };
}

export async function executeFencedFamilySourceDeletion(
	env: Env,
	record: CleanupRecord,
	beforeRecordDelete?: () => Promise<void>
): Promise<
	{ ok: true } | FamilySourceDeletionStepFailure | { ok: false; step: 'fence'; error?: unknown }
> {
	try {
		await ensureWorkerPuzzleDeletionFence(env, record);
	} catch (fenceErr) {
		return { ok: false, step: 'fence', error: fenceErr };
	}
	return executeFamilySourceDeletion(env, record, beforeRecordDelete);
}
