import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlayerAuthStore } from './playerAuth';
import { getPlayerSession, logoutPlayer } from '$lib/services/api';
import type { PlayerSessionResponse, PlayerUser } from '$lib/types/puzzle';

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

function deferredSession() {
	let resolve!: (value: PlayerSessionResponse) => void;
	const promise = new Promise<PlayerSessionResponse>((promiseResolve) => {
		resolve = promiseResolve;
	});

	return { promise, resolve };
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

	it('keeps anonymous state when a pending refresh resolves after logout', async () => {
		const pendingRefresh = deferredSession();
		vi.mocked(getPlayerSession).mockReturnValue(pendingRefresh.promise);
		vi.mocked(logoutPlayer).mockResolvedValue(undefined);
		const store = createPlayerAuthStore();

		const refreshPromise = store.refresh();
		await store.logout();
		pendingRefresh.resolve({ authenticated: true, user });
		await refreshPromise;

		expect(getState(store)).toEqual({
			status: 'anonymous',
			user: null,
			error: null
		});
	});

	it('keeps newer refresh state when an older refresh resolves last', async () => {
		const firstRefresh = deferredSession();
		vi.mocked(getPlayerSession)
			.mockReturnValueOnce(firstRefresh.promise)
			.mockResolvedValueOnce({ authenticated: false });
		const store = createPlayerAuthStore();

		const firstRefreshPromise = store.refresh();
		await store.refresh();
		firstRefresh.resolve({ authenticated: true, user });
		await firstRefreshPromise;

		expect(getState(store)).toEqual({
			status: 'anonymous',
			user: null,
			error: null
		});
	});
});
