// Progress service for localStorage persistence
import type { PuzzleProgress, PlacedPiece } from '$lib/types/puzzle';

const PROGRESS_KEY_PREFIX = 'puzzle-progress-';

function getStorageKey(puzzleId: string): string {
	return `${PROGRESS_KEY_PREFIX}${puzzleId}`;
}

export function getProgress(puzzleId: string): PuzzleProgress | null {
	if (typeof window === 'undefined') return null;

	try {
		const data = localStorage.getItem(getStorageKey(puzzleId));
		if (!data) return null;
		return JSON.parse(data) as PuzzleProgress;
	} catch {
		return null;
	}
}

export function saveProgress(puzzleId: string, placedPieces: PlacedPiece[]): void {
	if (typeof window === 'undefined') return;

	const progress: PuzzleProgress = {
		puzzleId,
		placedPieces,
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
