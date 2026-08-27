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

export async function finishWorkerPuzzleDeletion(env: Env, record: CleanupRecord): Promise<void> {
	const { db, completionWrites } = getWorkerDbContext(env);
	await deletePuzzleFamilyOwnership(db, record.familyId);
	for (const difficulty of PUZZLE_DIFFICULTIES) {
		await completionWrites.finishPuzzleDeletion(record.variantIds[difficulty]);
	}
	await deleteCleanupRecord(env.PUZZLE_METADATA, record.familyId);
}

export type FamilySourceDeletionStepFailure = {
	ok: false;
	step: 'do-tombstone' | 'r2' | 'kv-family' | 'kv-variant' | 'finish';
	error?: unknown;
	failedKeys?: string[];
};

export async function executeFamilySourceDeletion(
	env: Env,
	record: CleanupRecord,
	beforeFinish?: () => Promise<void>
): Promise<{ ok: true } | FamilySourceDeletionStepFailure> {
	const doIds = [
		record.familyId,
		record.variantIds.easy,
		record.variantIds.normal,
		record.variantIds.hard
	];
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

	if (beforeFinish) {
		try {
			await beforeFinish();
		} catch (hookErr) {
			console.error(
				`Non-fatal beforeFinish hook failed for family ${record.familyId}; continuing to required finish:`,
				hookErr
			);
		}
	}

	try {
		await finishWorkerPuzzleDeletion(env, record);
	} catch (finishErr) {
		return { ok: false, step: 'finish', error: finishErr };
	}

	return { ok: true };
}

export async function executeFencedFamilySourceDeletion(
	env: Env,
	record: CleanupRecord,
	beforeFinish?: () => Promise<void>
): Promise<
	{ ok: true } | FamilySourceDeletionStepFailure | { ok: false; step: 'fence'; error?: unknown }
> {
	try {
		await ensureWorkerPuzzleDeletionFence(env, record);
	} catch (fenceErr) {
		return { ok: false, step: 'fence', error: fenceErr };
	}
	return executeFamilySourceDeletion(env, record, beforeFinish);
}
