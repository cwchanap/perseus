import type { SessionMode } from '@perseus/game-core';

export const GAMEPLAY_PREFERENCES_KEY = 'perseus-gameplay-preferences-v1';

export interface GameplayPreferences {
	mode: SessionMode;
	rotationEnabled: boolean;
	startImmediately: boolean;
}

export const DEFAULT_GAMEPLAY_PREFERENCES: GameplayPreferences = {
	mode: 'timed',
	rotationEnabled: false,
	startImmediately: false
};

function browserStorage(): Storage | undefined {
	try {
		return typeof localStorage === 'undefined' ? undefined : localStorage;
	} catch {
		return undefined;
	}
}

function isGameplayPreferences(value: unknown): value is GameplayPreferences {
	if (!value || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;
	return (
		(record.mode === 'timed' || record.mode === 'relaxed') &&
		typeof record.rotationEnabled === 'boolean' &&
		typeof record.startImmediately === 'boolean'
	);
}

export function loadGameplayPreferences(
	storage: Storage | undefined = browserStorage()
): GameplayPreferences {
	if (!storage) return { ...DEFAULT_GAMEPLAY_PREFERENCES };
	try {
		const raw = storage.getItem(GAMEPLAY_PREFERENCES_KEY);
		if (raw === null) return { ...DEFAULT_GAMEPLAY_PREFERENCES };
		const parsed: unknown = JSON.parse(raw);
		return isGameplayPreferences(parsed) ? { ...parsed } : { ...DEFAULT_GAMEPLAY_PREFERENCES };
	} catch {
		return { ...DEFAULT_GAMEPLAY_PREFERENCES };
	}
}

export function saveGameplayPreferences(
	preferences: GameplayPreferences,
	storage: Storage | undefined = browserStorage()
): void {
	if (!storage) return;
	try {
		storage.setItem(GAMEPLAY_PREFERENCES_KEY, JSON.stringify(preferences));
	} catch {
		// Device preferences are best effort and never block play.
	}
}
