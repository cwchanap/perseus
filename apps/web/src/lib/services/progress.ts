// Progress service for localStorage persistence
import type { GameProgress, PlacedPiece } from '$lib/types/puzzle';
import type { Rotation } from '$lib/types/gameplay';

type StoredGameProgress = Omit<GameProgress, 'rotationEnabled' | 'pieceRotations'> &
	Partial<Pick<GameProgress, 'rotationEnabled' | 'pieceRotations'>>;

const PROGRESS_KEY_PREFIX = 'puzzle-progress-';

function getStorageKey(puzzleId: string): string {
	return `${PROGRESS_KEY_PREFIX}${puzzleId}`;
}

export function getProgress(puzzleId: string): GameProgress | null {
	if (typeof window === 'undefined') return null;

	try {
		const data = localStorage.getItem(getStorageKey(puzzleId));
		if (!data) return null;
		const progress = JSON.parse(data) as StoredGameProgress;

		return {
			...progress,
			rotationEnabled: progress.rotationEnabled ?? false,
			pieceRotations: progress.pieceRotations ?? {}
		} as GameProgress;
	} catch (error) {
		console.error(`Failed to load puzzle progress for ${puzzleId}:`, error);
		return null;
	}
}

export function saveProgress(
	puzzleId: string,
	placedPieces: PlacedPiece[],
	rotationEnabled = false,
	pieceRotations: Record<number, Rotation> = {}
): void {
	if (typeof window === 'undefined') return;

	const progress: GameProgress = {
		puzzleId,
		placedPieces,
		rotationEnabled,
		pieceRotations,
		lastUpdated: new Date().toISOString()
	};

	try {
		localStorage.setItem(getStorageKey(puzzleId), JSON.stringify(progress));
	} catch (e) {
		console.error('Failed to save puzzle progress:', e);
	}
}

export function clearProgress(puzzleId: string): void {
	if (typeof window === 'undefined') return;

	try {
		localStorage.removeItem(getStorageKey(puzzleId));
	} catch (e) {
		console.error('Failed to clear puzzle progress:', e);
	}
}

export function hasProgress(puzzleId: string): boolean {
	return getProgress(puzzleId) !== null;
}
