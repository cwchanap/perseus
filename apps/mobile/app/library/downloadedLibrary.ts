import {
	validationContextFrom,
	type SessionLoadResult,
	type SessionStorageAdapter
} from '@perseus/game-core';
import { sessionSpecFromManifest } from './downloadManifest';
import type { InstalledDownload } from './downloadStore';

export type ProgressState =
	| { kind: 'none' }
	| { kind: 'resumable' }
	| { kind: 'protected' }
	| { kind: 'invalid'; reason: string };

export type DownloadedAction = 'start' | 'resume' | 'discard_progress' | 'remove_download';

export interface DownloadedPuzzleRow {
	install: InstalledDownload;
	progress: ProgressState;
}

export interface GameplayLaunch {
	install: InstalledDownload;
	mode: 'start' | 'resume';
}

export function classifyProgress(
	result: SessionLoadResult,
	storage: Pick<SessionStorageAdapter, 'isResumable'>
): ProgressState {
	if (result.status === 'missing') return { kind: 'none' };
	if (result.status === 'invalid') return { kind: 'invalid', reason: result.reason };
	if (storage.isResumable(result.snapshot)) return { kind: 'resumable' };
	if (result.snapshot.hasUserActivity || result.snapshot.sealedCompletion !== null) {
		return { kind: 'protected' };
	}
	return { kind: 'none' };
}

export function actionsForProgress(progress: ProgressState): readonly DownloadedAction[] {
	switch (progress.kind) {
		case 'none':
			return ['start', 'remove_download'];
		case 'resumable':
			return ['resume', 'discard_progress', 'remove_download'];
		case 'protected':
		case 'invalid':
			return ['discard_progress', 'remove_download'];
	}
}

export function buildDownloadedRows(
	installed: readonly InstalledDownload[],
	storage: SessionStorageAdapter
): DownloadedPuzzleRow[] {
	return installed.map((install) => {
		const spec = sessionSpecFromManifest(install.manifest);
		const result = storage.peekSession(spec.puzzleId, validationContextFrom(spec));
		return { install, progress: classifyProgress(result, storage) };
	});
}
