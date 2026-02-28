// Statistics service for localStorage persistence of personal best times

export interface PuzzleStats {
	puzzleId: string;
	bestTime: number;
	completedAt: string;
	totalCompletions: number;
}

const STATS_KEY_PREFIX = 'puzzle-stats-';

function getStorageKey(puzzleId: string): string {
	return `${STATS_KEY_PREFIX}${puzzleId}`;
}

export function getStats(puzzleId: string): PuzzleStats | null {
	if (typeof window === 'undefined') return null;

	try {
		const data = localStorage.getItem(getStorageKey(puzzleId));
		if (!data) return null;
		const parsed = JSON.parse(data);
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			typeof parsed.puzzleId === 'string' &&
			typeof parsed.bestTime === 'number' &&
			typeof parsed.completedAt === 'string' &&
			typeof parsed.totalCompletions === 'number'
		) {
			return parsed as PuzzleStats;
		}
		localStorage.removeItem(getStorageKey(puzzleId));
		return null;
	} catch {
		return null;
	}
}

export function getBestTime(puzzleId: string): number | null {
	const stats = getStats(puzzleId);
	return stats?.bestTime ?? null;
}

export function saveCompletionTime(puzzleId: string, timeSeconds: number): boolean {
	if (typeof window === 'undefined') return false;

	try {
		const existing = getStats(puzzleId);
		const now = new Date().toISOString();
		const isNewBest = !existing || timeSeconds < existing.bestTime;

		const stats: PuzzleStats = {
			puzzleId,
			bestTime: isNewBest ? timeSeconds : existing!.bestTime,
			completedAt: isNewBest ? now : existing!.completedAt,
			totalCompletions: (existing?.totalCompletions ?? 0) + 1
		};

		localStorage.setItem(getStorageKey(puzzleId), JSON.stringify(stats));
		return isNewBest;
	} catch (e) {
		console.error('Failed to save puzzle stats:', e);
		return false;
	}
}

export function clearStats(puzzleId: string): void {
	if (typeof window === 'undefined') return;

	try {
		localStorage.removeItem(getStorageKey(puzzleId));
	} catch (e) {
		console.error('Failed to clear puzzle stats:', e);
	}
}
