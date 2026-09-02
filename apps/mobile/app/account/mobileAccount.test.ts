import { describe, expect, it } from 'vitest';
import type { MobilePlayerSessionResponse, PlayerUser } from '@perseus/types';
import type { PlayerApi } from '../api/playerApi';
import {
	applySessionProbe,
	restoreMobileAccount,
	signInMobileAccount,
	signOutMobileAccount,
	type GoogleIdTokenProvider,
	type MobileSessionStore,
	type PersistedMobileSession
} from './mobileAccount';

function playerUser(): PlayerUser {
	return {
		id: 'player-1',
		email: 'player@example.test',
		name: 'Player One',
		createdAt: 1720000000000,
		lastLoginAt: 1720000000000
	};
}

function savedSession(overrides: Partial<PersistedMobileSession> = {}): PersistedMobileSession {
	return {
		version: 1,
		token: 'player-token',
		expiresAt: 1_000_000,
		user: playerUser(),
		consecutiveUnauthenticated: 0,
		...overrides
	};
}

function memoryStore(): MobileSessionStore {
	let raw: string | null = null;
	return {
		read: () => raw,
		write: (next) => {
			raw = next;
		},
		clear: () => {
			raw = null;
		}
	};
}

function fakeApi(handlers: {
	exchangeGoogleIdToken?: (idToken: string) => Promise<MobilePlayerSessionResponse>;
	logout?: () => Promise<void>;
}): PlayerApi {
	return {
		exchangeGoogleIdToken:
			handlers.exchangeGoogleIdToken ??
			(async () => {
				throw new Error('unexpected exchangeGoogleIdToken');
			}),
		getSession: async () => {
			throw new Error('unexpected getSession');
		},
		logout:
			handlers.logout ??
			(async () => {
				throw new Error('unexpected logout');
			}),
		submitCompletion: async () => {
			throw new Error('unexpected submitCompletion');
		}
	};
}

function fakeProvider(
	handlers: {
		signIn?: () => Promise<string>;
		signOut?: () => Promise<void>;
	} = {}
): GoogleIdTokenProvider {
	return {
		signIn:
			handlers.signIn ??
			(async () => {
				throw new Error('unexpected signIn');
			}),
		signOut:
			handlers.signOut ??
			(async () => {
				throw new Error('unexpected signOut');
			})
	};
}

describe('restoreMobileAccount', () => {
	const now = 1_000_000;

	function validRaw(at: number): string {
		return JSON.stringify({
			version: 1,
			token: 'player-token',
			expiresAt: at + 60_000,
			user: playerUser(),
			consecutiveUnauthenticated: 0
		});
	}

	function rawWith(patch: Record<string, unknown>): string {
		const value = JSON.parse(validRaw(now)) as Record<string, unknown>;
		return JSON.stringify({ ...value, ...patch });
	}

	it('restores a fully valid v1 session', () => {
		expect(restoreMobileAccount(validRaw(now), now)?.user).toEqual(playerUser());
	});

	it('keeps a consecutiveUnauthenticated of 1', () => {
		const restored = restoreMobileAccount(rawWith({ consecutiveUnauthenticated: 1 }), now);
		expect(restored?.consecutiveUnauthenticated).toBe(1);
	});

	it.each([
		['malformed JSON', '{not-json'],
		['a non-object payload', '42'],
		['a wrong version', rawWith({ version: 2 })],
		['an empty token', rawWith({ token: '' })],
		['a null expiry', rawWith({ expiresAt: null })],
		['an expiry in the present', rawWith({ expiresAt: now })],
		['an expiry in the past', rawWith({ expiresAt: now - 1 })],
		['an invalid user', rawWith({ user: { id: 'partial' } })],
		['a counter of 2', rawWith({ consecutiveUnauthenticated: 2 })],
		['a stringy counter', rawWith({ consecutiveUnauthenticated: '0' })]
	])('rejects %s', (_label, raw) => {
		expect(restoreMobileAccount(raw, now)).toBeNull();
	});
});

describe('applySessionProbe', () => {
	it('marks the first unauthenticated probe as uncertain and keeps the credential', () => {
		const saved0 = savedSession({ consecutiveUnauthenticated: 0 });

		expect(applySessionProbe(saved0, { authenticated: false })).toEqual({
			kind: 'uncertain',
			session: { ...saved0, consecutiveUnauthenticated: 1 }
		});
	});

	it('clears the session on the second consecutive unauthenticated probe', () => {
		const saved1 = savedSession({ consecutiveUnauthenticated: 1 });

		expect(applySessionProbe(saved1, { authenticated: false })).toEqual({ kind: 'cleared' });
	});

	it('resets the counter and refreshes the user on an authenticated probe', () => {
		const saved1 = savedSession({ consecutiveUnauthenticated: 1 });
		const refreshed = { ...playerUser(), name: 'Refreshed' };

		expect(applySessionProbe(saved1, { authenticated: true, user: refreshed })).toEqual({
			kind: 'authenticated',
			session: { ...saved1, user: refreshed, consecutiveUnauthenticated: 0 }
		});
	});

	it('resets the counter from zero on an authenticated probe', () => {
		const saved0 = savedSession({ consecutiveUnauthenticated: 0 });

		expect(applySessionProbe(saved0, { authenticated: true, user: playerUser() })).toEqual({
			kind: 'authenticated',
			session: { ...saved0, consecutiveUnauthenticated: 0 }
		});
	});
});

describe('signInMobileAccount', () => {
	it('exchanges the google id token and writes a counter-0 session', async () => {
		const store = memoryStore();
		const calls: string[] = [];
		const exchanged: MobilePlayerSessionResponse = {
			token: 'session-token',
			expiresAt: 1_000_060,
			user: playerUser()
		};

		const session = await signInMobileAccount({
			provider: fakeProvider({
				signIn: async () => {
					calls.push('signIn');
					return 'google-id-token';
				}
			}),
			api: fakeApi({
				exchangeGoogleIdToken: async (idToken) => {
					calls.push(`exchange:${idToken}`);
					return exchanged;
				}
			}),
			store
		});

		expect(session).toEqual({
			version: 1,
			token: 'session-token',
			expiresAt: 1_000_060,
			user: playerUser(),
			consecutiveUnauthenticated: 0
		});
		expect(calls).toEqual(['signIn', 'exchange:google-id-token']);
		expect(store.read()).toBe(JSON.stringify(session));
	});
});

describe('signOutMobileAccount', () => {
	it('attempts remote logout and google sign-out, then clears the store', async () => {
		const store = memoryStore();
		store.write('{"version":1}');
		const calls: string[] = [];

		await signOutMobileAccount({
			provider: fakeProvider({
				signOut: async () => {
					calls.push('google');
				}
			}),
			api: fakeApi({
				logout: async () => {
					calls.push('logout');
				}
			}),
			store,
			token: 'player-token'
		});

		expect(calls).toEqual(['logout', 'google']);
		expect(store.read()).toBeNull();
	});

	it('clears the store even when remote logout fails', async () => {
		const store = memoryStore();
		store.write('{"version":1}');

		await signOutMobileAccount({
			provider: fakeProvider(),
			api: fakeApi({
				logout: async () => {
					throw new Error('offline');
				}
			}),
			store,
			token: 'player-token'
		});

		expect(store.read()).toBeNull();
	});

	it('clears the store even when google sign-out fails', async () => {
		const store = memoryStore();
		store.write('{"version":1}');

		await signOutMobileAccount({
			provider: fakeProvider({
				signOut: async () => {
					throw new Error('google_down');
				}
			}),
			api: fakeApi({ logout: async () => undefined }),
			store,
			token: 'player-token'
		});

		expect(store.read()).toBeNull();
	});
});
