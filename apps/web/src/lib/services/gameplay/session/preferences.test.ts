import { describe, expect, it } from 'vitest';
import { memoryStorage } from './persistence.test-fixtures';
import {
	DEFAULT_GAMEPLAY_PREFERENCES,
	GAMEPLAY_PREFERENCES_KEY,
	loadGameplayPreferences,
	saveGameplayPreferences
} from './preferences';

describe('gameplay preferences', () => {
	it('returns defaults when missing', () => {
		expect(loadGameplayPreferences(memoryStorage({}))).toEqual(DEFAULT_GAMEPLAY_PREFERENCES);
	});

	it('round-trips mode, rotation, and Start Immediately', () => {
		const store: Record<string, string> = {};
		const storage = memoryStorage(store);
		const preferences = {
			mode: 'relaxed' as const,
			rotationEnabled: true,
			startImmediately: true
		};

		saveGameplayPreferences(preferences, storage);

		expect(JSON.parse(store[GAMEPLAY_PREFERENCES_KEY])).toEqual(preferences);
		expect(loadGameplayPreferences(storage)).toEqual(preferences);
	});

	it('falls back for corrupt values', () => {
		const storage = memoryStorage({
			[GAMEPLAY_PREFERENCES_KEY]: JSON.stringify({
				mode: 'fast',
				rotationEnabled: 'yes',
				startImmediately: 1
			})
		});
		expect(loadGameplayPreferences(storage)).toEqual(DEFAULT_GAMEPLAY_PREFERENCES);
	});

	it('does not throw when storage is unavailable', () => {
		const storage = memoryStorage({});
		storage.getItem = () => {
			throw new Error('read denied');
		};
		storage.setItem = () => {
			throw new Error('write denied');
		};
		expect(loadGameplayPreferences(storage)).toEqual(DEFAULT_GAMEPLAY_PREFERENCES);
		expect(() => saveGameplayPreferences(DEFAULT_GAMEPLAY_PREFERENCES, storage)).not.toThrow();
	});
});
