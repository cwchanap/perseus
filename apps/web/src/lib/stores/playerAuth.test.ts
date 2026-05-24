import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlayerAuthStore } from './playerAuth';
import { getPlayerSession, logoutPlayer } from '$lib/services/api';
import type { PlayerUser } from '$lib/types/puzzle';

vi.mock('$lib/services/api', () => ({
	getPlayerSession: vi.fn(),
	logoutPlayer: vi.fn()
}));

const user: PlayerUser = {
	id: 'player-1',
	email: 'player@example.com',
	name: 'Player One',
	picture: 'https://example.com/avatar.png',
	createdAt: 1779530400000,
	lastLoginAt: 1779530400000
};

function getState(store: ReturnType<typeof createPlayerAuthStore>) {
	let current;
	const unsubscribe = store.subscribe((state) => {
		current = state;
	});
	unsubscribe();
	return current;
}

beforeEach(() => {
	vi.mocked(getPlayerSession).mockReset();
	vi.mocked(logoutPlayer).mockReset();
});

describe('createPlayerAuthStore', () => {
	it('loads authenticated user state', async () => {
		vi.mocked(getPlayerSession).mockResolvedValue({ authenticated: true, user });
		const store = createPlayerAuthStore();

		await store.refresh();

		expect(getState(store)).toEqual({
			status: 'authenticated',
			user,
			error: null
		});
	});

	it('sets anonymous state for unauthenticated session responses', async () => {
		vi.mocked(getPlayerSession).mockResolvedValue({ authenticated: false });
		const store = createPlayerAuthStore();

		await store.refresh();

		expect(getState(store)).toEqual({
			status: 'anonymous',
			user: null,
			error: null
		});
	});

	it('sets anonymous state when refresh fails', async () => {
		vi.mocked(getPlayerSession).mockRejectedValue(new Error('network failed'));
		const store = createPlayerAuthStore();

		await store.refresh();

		expect(getState(store)).toEqual({
			status: 'anonymous',
			user: null,
			error: null
		});
	});

	it('logs out and clears state', async () => {
		vi.mocked(getPlayerSession).mockResolvedValue({ authenticated: true, user });
		vi.mocked(logoutPlayer).mockResolvedValue(undefined);
		const store = createPlayerAuthStore();
		await store.refresh();

		await store.logout();

		expect(logoutPlayer).toHaveBeenCalledOnce();
		expect(getState(store)).toEqual({
			status: 'anonymous',
			user: null,
			error: null
		});
	});

	it('clears state when logout fails', async () => {
		vi.mocked(getPlayerSession).mockResolvedValue({ authenticated: true, user });
		vi.mocked(logoutPlayer).mockRejectedValue(new Error('logout failed'));
		const store = createPlayerAuthStore();
		await store.refresh();

		await expect(store.logout()).rejects.toThrow('logout failed');

		expect(getState(store)).toEqual({
			status: 'anonymous',
			user: null,
			error: null
		});
	});
});
