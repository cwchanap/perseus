// Pure mobile account/session policy: no NativeScript, no I/O beyond the
// injected provider, api, and store. Task 3B supplies the native
// implementations of those dependencies.
import { isPlayerUser, type PlayerSessionResponse, type PlayerUser } from '@perseus/types';
import type { PlayerApi } from '../api/playerApi';

export interface PersistedMobileSession {
	version: 1;
	token: string;
	expiresAt: number;
	user: PlayerUser;
	consecutiveUnauthenticated: 0 | 1;
}

export interface GoogleIdTokenProvider {
	signIn(): Promise<string>;
	signOut(): Promise<void>;
}

export interface MobileSessionStore {
	read(): string | null;
	write(raw: string): void;
	clear(): void;
}

export type SessionProbeDecision =
	| { kind: 'authenticated'; session: PersistedMobileSession }
	| { kind: 'uncertain'; session: PersistedMobileSession }
	| { kind: 'cleared' };

/** Fully validates the current V1 payload; returns null for anything else. */
export function restoreMobileAccount(raw: string, now: number): PersistedMobileSession | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const value = parsed as Record<string, unknown>;
	if (value.version !== 1) return null;
	if (typeof value.token !== 'string' || value.token.length === 0) return null;
	if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return null;
	if (value.expiresAt <= now) return null;
	if (!isPlayerUser(value.user)) return null;
	if (value.consecutiveUnauthenticated !== 0 && value.consecutiveUnauthenticated !== 1) return null;
	return {
		version: 1,
		token: value.token,
		expiresAt: value.expiresAt,
		user: value.user,
		consecutiveUnauthenticated: value.consecutiveUnauthenticated
	};
}

/** Two-strike probe policy: one false probe is uncertain, two in a row clear. */
export function applySessionProbe(
	session: PersistedMobileSession,
	response: PlayerSessionResponse
): SessionProbeDecision {
	if (response.authenticated) {
		return {
			kind: 'authenticated',
			session: { ...session, user: response.user, consecutiveUnauthenticated: 0 }
		};
	}
	if (session.consecutiveUnauthenticated === 0) {
		return { kind: 'uncertain', session: { ...session, consecutiveUnauthenticated: 1 } };
	}
	return { kind: 'cleared' };
}

/**
 * Whether a cold-launch restore should schedule a completion drain after
 * applying `decision`. Only a confirmed-authenticated restore has a live
 * credential worth draining with this pass; `uncertain` re-probes on the
 * next trigger (resume/connectivity) and `cleared` has no session to drain.
 */
export function shouldDrainAfterRestore(decision: SessionProbeDecision): boolean {
	return decision.kind === 'authenticated';
}

export async function signInMobileAccount(options: {
	provider: GoogleIdTokenProvider;
	api: PlayerApi;
	store: MobileSessionStore;
}): Promise<PersistedMobileSession> {
	const idToken = await options.provider.signIn();
	const response = await options.api.exchangeGoogleIdToken(idToken);
	const session: PersistedMobileSession = {
		version: 1,
		token: response.token,
		expiresAt: response.expiresAt,
		user: response.user,
		consecutiveUnauthenticated: 0
	};
	options.store.write(JSON.stringify(session));
	return session;
}

/** Best-effort remote sign-out; the local store is always cleared. */
export async function signOutMobileAccount(options: {
	provider: GoogleIdTokenProvider;
	api: PlayerApi;
	store: MobileSessionStore;
	token: string;
}): Promise<void> {
	try {
		try {
			await options.api.logout(options.token);
		} finally {
			await options.provider.signOut();
		}
	} catch {
		// Remote failures must not block local sign-out.
	} finally {
		options.store.clear();
	}
}
