import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecureSessionStore, SESSION_KEY } from './sessionStore';

function fakeStorage() {
	return {
		getSync: vi.fn<() => unknown>(() => null),
		setSync: vi.fn<() => boolean>(() => true),
		removeSync: vi.fn<() => boolean>(() => true)
	};
}

describe('createSecureSessionStore', () => {
	let storage: ReturnType<typeof fakeStorage>;

	beforeEach(() => {
		storage = fakeStorage();
	});

	describe('read', () => {
		it('returns the raw stored string', () => {
			storage.getSync.mockReturnValue('{"version":1}');
			const store = createSecureSessionStore(storage);

			expect(store.read()).toBe('{"version":1}');
			expect(storage.getSync).toHaveBeenCalledWith({ key: SESSION_KEY });
		});

		it('returns null for a missing or non-string payload', () => {
			storage.getSync.mockReturnValueOnce(null).mockReturnValueOnce(42);
			const store = createSecureSessionStore(storage);

			expect(store.read()).toBeNull();
			expect(store.read()).toBeNull();
		});
	});

	describe('write', () => {
		it('passes the session key and raw value to setSync', () => {
			createSecureSessionStore(storage).write('{"version":1}');

			expect(storage.setSync).toHaveBeenCalledWith({ key: SESSION_KEY, value: '{"version":1}' });
		});

		it('throws instead of silently succeeding when setSync fails', () => {
			storage.setSync.mockReturnValue(false);

			expect(() => createSecureSessionStore(storage).write('{"version":1}')).toThrow(
				'secure_storage_write_failed'
			);
		});
	});

	describe('clear', () => {
		it('passes the session key to removeSync', () => {
			createSecureSessionStore(storage).clear();

			expect(storage.removeSync).toHaveBeenCalledWith({ key: SESSION_KEY });
		});

		it('tolerates a false removeSync when the key is already gone', () => {
			// iOS reports removing an absent item as false; the read-back
			// confirms nothing is left behind.
			storage.removeSync.mockReturnValue(false);
			storage.getSync.mockReturnValue(null);

			expect(() => createSecureSessionStore(storage).clear()).not.toThrow();
		});

		it('throws when removeSync fails and the bearer is still readable', () => {
			storage.removeSync.mockReturnValue(false);
			storage.getSync.mockReturnValue('{"version":1}');

			expect(() => createSecureSessionStore(storage).clear()).toThrow(
				'secure_storage_remove_failed'
			);
		});
	});
});
