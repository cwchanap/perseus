// Account-side cleared difficulties, grouped by family id.
//
// Mirrors the bookmarks store's identity/version/load-dedupe skeleton, but
// pagination and abort/signal handling follow the Gallery/Profile route
// patterns (AbortController per load; AbortError and stale-version
// completions are expected control flow, not errors). The published value
// only ever changes once per completed load: partial pages are accumulated
// privately and never set().

import { writable } from 'svelte/store';
import type { Readable } from 'svelte/store';
import type { PuzzleDifficulty } from '@perseus/types';
import { getPlayerStats } from '$lib/services/api';
import { playerAuth, type PlayerAuthState } from './playerAuth';

export function createClearedDifficultiesStore(auth: Readable<PlayerAuthState> = playerAuth) {
	const { subscribe, set } = writable<ReadonlyMap<string, ReadonlySet<PuzzleDifficulty>>>(
		new Map()
	);
	let currentAccountId: string | null = null;
	let observedAccountId: string | null | undefined = undefined;
	let loadedAccountId: string | null = null;
	let loadPromise: Promise<void> | null = null;
	// Bumped on every identity change; async results captured against it are
	// dropped when it moves on, so old-account responses never land.
	let version = 0;
	let controller: AbortController | null = null;

	// Auth is only observed to detect login/logout/account switches and clear
	// stale clear state; fetching stays explicit via load().
	auth.subscribe((authState) => {
		// A refresh emits {status:'loading', user:null} mid-flight; that is not
		// a logout, so keep existing state while an account is still tracked.
		if (authState.status === 'loading' && observedAccountId) return;
		currentAccountId = authState.user?.id ?? null;
		if (observedAccountId !== undefined && observedAccountId === currentAccountId) return;
		observedAccountId = currentAccountId;
		version++;
		loadedAccountId = null;
		loadPromise = null;
		controller?.abort();
		controller = null;
		set(new Map());
	});

	return {
		subscribe,
		load(): Promise<void> {
			if (!currentAccountId) return Promise.resolve();
			if (loadedAccountId === currentAccountId) return Promise.resolve();
			if (loadPromise) return loadPromise;

			const at = version;
			const accountId = currentAccountId;
			const runLoad = async (): Promise<void> => {
				const active = new AbortController();
				controller = active;
				const cleared = new Map<string, Set<PuzzleDifficulty>>();
				try {
					let cursor: string | undefined;
					do {
						const response = await getPlayerStats({ limit: 100, cursor, signal: active.signal });
						if (at !== version) return;
						for (const row of response.stats) {
							if (row.totalCompletions <= 0) continue;
							let difficulties = cleared.get(row.familyId);
							if (!difficulties) {
								difficulties = new Set();
								cleared.set(row.familyId, difficulties);
							}
							difficulties.add(row.difficulty);
						}
						cursor = response.nextCursor;
					} while (cursor);
					if (at !== version) return;
					loadedAccountId = accountId;
					// Single publish: the map is complete only after pagination.
					set(cleared);
				} catch {
					// AbortError and stale-version completions are expected control
					// flow and leave the published map unchanged. A real failure
					// keeps the map empty and leaves loadedAccountId unset so a
					// later load() can retry.
					return;
				} finally {
					if (controller === active) controller = null;
				}
			};
			loadPromise = (async () => {
				try {
					await runLoad();
				} finally {
					if (at === version) loadPromise = null;
				}
			})();
			return loadPromise;
		}
	};
}

export const clearedDifficulties = createClearedDifficultiesStore();
