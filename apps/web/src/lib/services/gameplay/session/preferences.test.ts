import { afterEach, describe, expect, it } from 'vitest';
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

	it('returns defaults when no storage is provided to load', () => {
		expect(loadGameplayPreferences(undefined)).toEqual(DEFAULT_GAMEPLAY_PREFERENCES);
	});

	it('is a no-op when no storage is provided to save', () => {
		expect(() => saveGameplayPreferences(DEFAULT_GAMEPLAY_PREFERENCES, undefined)).not.toThrow();
	});

	it('falls back for non-object corrupt values', () => {
		const storage = memoryStorage({
			[GAMEPLAY_PREFERENCES_KEY]: JSON.stringify('not-an-object')
		});
		expect(loadGameplayPreferences(storage)).toEqual(DEFAULT_GAMEPLAY_PREFERENCES);
	});

	it('round-trips through the default browser storage', () => {
		// Exercises the browserStorage() default-argument path: load/save
		// without an explicit storage argument fall back to the real
		// localStorage available in the browser test environment.
		localStorage.removeItem(GAMEPLAY_PREFERENCES_KEY);
		try {
			expect(loadGameplayPreferences()).toEqual(DEFAULT_GAMEPLAY_PREFERENCES);
			const preferences = {
				mode: 'relaxed' as const,
				rotationEnabled: true,
				startImmediately: true
			};
			saveGameplayPreferences(preferences);
			expect(loadGameplayPreferences()).toEqual(preferences);
		} finally {
			localStorage.removeItem(GAMEPLAY_PREFERENCES_KEY);
		}
	});

	it('returns defaults when localStorage access throws', () => {
		// Safari private mode and some sandboxed contexts throw on
		// localStorage access. The browserStorage() try/catch must absorb
		// that and fall back to defaults.
		const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
		try {
			Object.defineProperty(window, 'localStorage', {
				configurable: true,
				get() {
					throw new Error('localStorage blocked');
				}
			});
			expect(loadGameplayPreferences()).toEqual(DEFAULT_GAMEPLAY_PREFERENCES);
			expect(() => saveGameplayPreferences(DEFAULT_GAMEPLAY_PREFERENCES)).not.toThrow();
		} finally {
			if (original) {
				Object.defineProperty(window, 'localStorage', original);
			}
		}
	});

	it('returns defaults when localStorage is undefined (non-browser context)', () => {
		// Covers the `typeof localStorage === 'undefined'` true branch in
		// browserStorage(): a non-browser context where localStorage does
		// not exist at all.
		const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
		try {
			Object.defineProperty(window, 'localStorage', {
				configurable: true,
				get() {
					return undefined;
				}
			});
			expect(loadGameplayPreferences()).toEqual(DEFAULT_GAMEPLAY_PREFERENCES);
			expect(() => saveGameplayPreferences(DEFAULT_GAMEPLAY_PREFERENCES)).not.toThrow();
		} finally {
			if (original) {
				Object.defineProperty(window, 'localStorage', original);
			}
		}
	});

	afterEach(() => {
		localStorage.removeItem(GAMEPLAY_PREFERENCES_KEY);
	});
});
