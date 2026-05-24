import { writable } from 'svelte/store';
import { getPlayerSession, logoutPlayer } from '$lib/services/api';
import type { PlayerUser } from '$lib/types/puzzle';

export interface PlayerAuthState {
	status: 'loading' | 'authenticated' | 'anonymous';
	user: PlayerUser | null;
	error: string | null;
}

const anonymousState: PlayerAuthState = {
	status: 'anonymous',
	user: null,
	error: null
};

export function createPlayerAuthStore() {
	const { subscribe, set } = writable<PlayerAuthState>({
		status: 'loading',
		user: null,
		error: null
	});
	let operationId = 0;

	return {
		subscribe,
		async refresh(): Promise<void> {
			const currentOperationId = ++operationId;
			set({
				status: 'loading',
				user: null,
				error: null
			});

			try {
				const session = await getPlayerSession();
				if (currentOperationId !== operationId) {
					return;
				}

				if (session.authenticated) {
					set({
						status: 'authenticated',
						user: session.user,
						error: null
					});
					return;
				}
			} catch {
				// Auth state is best-effort; callers should see anonymous on failures.
			}

			if (currentOperationId !== operationId) {
				return;
			}

			set(anonymousState);
		},
		async logout(): Promise<void> {
			operationId++;
			try {
				await logoutPlayer();
			} finally {
				set(anonymousState);
			}
		}
	};
}

export const playerAuth = createPlayerAuthStore();
