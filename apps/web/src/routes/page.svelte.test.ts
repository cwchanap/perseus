import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import GalleryPage from './+page.svelte';
import type { PuzzleFamilySummary } from '@perseus/types';
import { fetchPuzzles, ApiError } from '$lib/services/api';
import { listQuick } from '$lib/services/quickPuzzle';
import type { StoredQuickPuzzle } from '$lib/services/quickPuzzle/types';
import {
	discoverGalleryProgress,
	discoverAllSavedProgress
} from '$lib/services/gameplay/galleryProgress';
import type {
	GalleryProgress,
	GalleryProgressDiscoveryResult
} from '$lib/services/gameplay/galleryProgress';

const sessionStorageSpies = vi.hoisted(() => ({
	clearSession: vi.fn(),
	listCandidates: vi.fn<() => string[]>()
}));

vi.mock('$lib/services/gameplay/session/persistence', () => ({
	createSessionStorageAdapter: () => ({ clearSession: sessionStorageSpies.clearSession }),
	listResumableSessionCandidateIds: sessionStorageSpies.listCandidates
}));

vi.mock('$lib/services/api', () => {
	class MockApiError extends Error {
		status: number;
		error: string;
		constructor(status: number, error: string, message: string) {
			super(message);
			this.name = 'ApiError';
			this.status = status;
			this.error = error;
		}
	}
	return {
		fetchPuzzles: vi.fn().mockResolvedValue({ families: [], total: 0, offset: 0, limit: 20 }),
		fetchPuzzle: vi.fn(),
		getFamilyThumbnailUrl: vi.fn((id: string) => `/api/puzzle-families/${id}/thumbnail`),
		ApiError: MockApiError
	};
});

vi.mock('$lib/services/stats', () => ({
	getBestTime: vi.fn().mockReturnValue(null)
}));

vi.mock('$lib/services/quickPuzzle', () => ({
	listQuick: vi.fn().mockReturnValue([])
}));

vi.mock('$lib/services/gameplay/galleryProgress', () => ({
	discoverGalleryProgress: vi.fn().mockReturnValue({
		byVariantId: new Map(),
		newest: null
	}),
	discoverAllSavedProgress: vi.fn().mockResolvedValue({ rows: [], complete: true })
}));

vi.mock('$app/paths', () => ({
	resolve: (p: string) => p
}));

const makeFamily = (
	id: string,
	overrides: Partial<PuzzleFamilySummary> = {}
): PuzzleFamilySummary => ({
	id,
	name: `Puzzle ${id}`,
	aspectRatio: '1:1',
	status: 'ready',
	createdAt: 1000,
	variants: {
		easy: { id: `${id}-e`, difficulty: 'easy', pieceCount: 16, status: 'ready' },
		normal: { id: `${id}-n`, difficulty: 'normal', pieceCount: 169, status: 'ready' },
		hard: { id: `${id}-h`, difficulty: 'hard', pieceCount: 100, status: 'ready' }
	},
	...overrides
});

const storedQuickPuzzleFixture: StoredQuickPuzzle = {
	id: 'q-local',
	name: 'Local Mission',
	aspectRatio: '1:1',
	pieceCount: 16,
	gridRows: 2,
	gridCols: 2,
	imageWidth: 100,
	imageHeight: 100,
	imageDataUrl: 'data:image/jpeg;base64,',
	pieces: [
		{
			id: 0,
			correctX: 0,
			correctY: 0,
			edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' }
		},
		{
			id: 1,
			correctX: 1,
			correctY: 0,
			edges: { top: 'flat', right: 'flat', bottom: 'tab', left: 'blank' }
		},
		{
			id: 2,
			correctX: 0,
			correctY: 1,
			edges: { top: 'tab', right: 'blank', bottom: 'flat', left: 'flat' }
		},
		{
			id: 3,
			correctX: 1,
			correctY: 1,
			edges: { top: 'blank', right: 'flat', bottom: 'flat', left: 'tab' }
		}
	],
	createdAt: 1_000,
	schemaVersion: 1
};

type FetchPuzzlesResult = Awaited<ReturnType<typeof fetchPuzzles>>;
const mockedFetchPuzzles = vi.mocked(fetchPuzzles);
const mockedListQuick = vi.mocked(listQuick);
const mockedDiscoverGalleryProgress = vi.mocked(discoverGalleryProgress);
const mockedDiscoverAllSavedProgress = vi.mocked(discoverAllSavedProgress);

const observe = vi.fn();
const disconnect = vi.fn();
let intersectionCallback: IntersectionObserverCallback | null = null;
class MockIntersectionObserver {
	constructor(callback: IntersectionObserverCallback) {
		intersectionCallback = callback;
	}
	observe = observe;
	disconnect = disconnect;
	unobserve = vi.fn();
	takeRecords = vi.fn();
}

describe('Gallery Page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		intersectionCallback = null;
		vi.stubGlobal('IntersectionObserver', MockIntersectionObserver as never);
		mockedFetchPuzzles.mockResolvedValue({ families: [], total: 0, offset: 0, limit: 20 });
		mockedListQuick.mockReturnValue([]);
		mockedDiscoverGalleryProgress.mockReturnValue({ byVariantId: new Map(), newest: null });
		mockedDiscoverAllSavedProgress.mockResolvedValue({ rows: [], complete: true });
		sessionStorageSpies.listCandidates.mockReturnValue([]);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('shows puzzle cards when puzzles are returned', async () => {
		mockedFetchPuzzles.mockResolvedValue({
			families: [makeFamily('p1'), makeFamily('p2')],
			total: 2,
			offset: 0,
			limit: 20
		});

		render(GalleryPage);

		const grid = page.getByTestId('puzzle-grid');
		await expect.element(grid).toBeVisible();
		const cards = page.getByTestId('puzzle-card');
		await expect.element(cards.nth(0)).toBeVisible();
		await expect.element(cards.nth(1)).toBeVisible();
	});

	it('reads Quick puzzles once and reuses them when server results change', async () => {
		const serverFamilies = [makeFamily('p1', { aspectRatio: '1:1', status: 'ready' })];
		const filteredPuzzles = [makeFamily('p2', { aspectRatio: '1:1', status: 'ready' })];
		const quickPuzzles = [storedQuickPuzzleFixture];

		mockedFetchPuzzles
			.mockResolvedValueOnce({ families: serverFamilies, total: 1, offset: 0, limit: 20 })
			.mockResolvedValueOnce({ families: filteredPuzzles, total: 1, offset: 0, limit: 20 });
		mockedListQuick.mockReturnValue(quickPuzzles);

		render(GalleryPage);

		await vi.waitFor(() => {
			expect(mockedDiscoverGalleryProgress).toHaveBeenCalledWith({
				serverFamilies,
				quickPuzzles
			});
		});
		expect(mockedListQuick).toHaveBeenCalledTimes(1);

		await page.getByTestId('search-input').fill('filtered');
		await vi.waitFor(() => {
			expect(mockedFetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ q: 'filtered', offset: 0 })
			);
		});
		await expect.element(page.getByText('Puzzle p2')).toBeVisible();

		await vi.waitFor(() => {
			expect(mockedDiscoverGalleryProgress).toHaveBeenCalledWith({
				serverFamilies: filteredPuzzles,
				quickPuzzles
			});
		});
		expect(mockedListQuick).toHaveBeenCalledTimes(1);
	});

	it('shows panel and card progress when the newest server progress overlaps a card', async () => {
		const serverFamilies = [
			makeFamily('p1', {
				name: 'Server Mission',
				aspectRatio: '1:1',
				status: 'ready'
			})
		];
		const progress = {
			puzzleId: 'p1-e',
			name: 'Resume Me',
			source: 'api' as const,
			placedCount: 2,
			pieceCount: 16,
			lastUpdated: 2_000
		};

		mockedFetchPuzzles.mockResolvedValue({
			families: serverFamilies,
			total: 1,
			offset: 0,
			limit: 20
		});
		mockedDiscoverGalleryProgress.mockReturnValue({
			byVariantId: new Map([['p1-e', progress]]),
			newest: progress
		});

		render(GalleryPage);

		await expect.element(page.getByTestId('continue-on-device')).toBeVisible();
		await expect.element(page.getByTestId('continue-on-device')).toHaveTextContent('Resume Me');
		await expect.element(page.getByText('2/16 PLACED')).toBeVisible();
	});

	it('renders the continue panel without crashing when progress counts are nullish', async () => {
		// A malformed newest progress entry with nullish counts must not throw:
		// Svelte renders nullish text interpolations as empty, so the panel
		// still surfaces the mission name and Continue link.
		const progress = {
			puzzleId: 'p1-e',
			name: 'Corrupt Mission',
			source: 'api' as const,
			placedCount: undefined as unknown as number,
			pieceCount: undefined as unknown as number,
			lastUpdated: 2_000
		};
		mockedDiscoverGalleryProgress.mockReturnValue({
			byVariantId: new Map([['p1-e', progress]]),
			newest: progress
		});

		render(GalleryPage);

		await expect.element(page.getByTestId('continue-on-device')).toBeVisible();
		await expect
			.element(page.getByTestId('continue-on-device'))
			.toHaveTextContent('Corrupt Mission');
	});

	it('links to a Quick-only newest progress without adding a Quick card', async () => {
		const quickPuzzles = [storedQuickPuzzleFixture];
		const progress = {
			puzzleId: 'q-local',
			name: 'Local Mission',
			source: 'local' as const,
			placedCount: 1,
			pieceCount: 16,
			lastUpdated: 2_000
		};

		mockedFetchPuzzles.mockResolvedValue({ families: [], total: 0, offset: 0, limit: 20 });
		mockedListQuick.mockReturnValue(quickPuzzles);
		mockedDiscoverGalleryProgress.mockReturnValue({ byVariantId: new Map(), newest: progress });

		render(GalleryPage);

		const panel = page.getByTestId('continue-on-device');
		await expect.element(panel).toBeVisible();
		await expect
			.element(panel.getByRole('link', { name: 'CONTINUE' }))
			.toHaveAttribute('href', '/puzzle/q-local');
		expect(document.querySelectorAll('[data-testid="puzzle-card"]')).toHaveLength(0);
	});

	it('scans Quick metadata and resumable candidates once per mount', async () => {
		sessionStorageSpies.listCandidates.mockReturnValue(['off-page']);
		render(GalleryPage);
		await vi.waitFor(() => expect(mockedListQuick).toHaveBeenCalledTimes(1));
		expect(sessionStorageSpies.listCandidates).toHaveBeenCalledTimes(1);

		await page.getByTestId('search-input').fill('filtered');
		await vi.waitFor(() => expect(mockedFetchPuzzles).toHaveBeenCalledTimes(2));
		expect(mockedListQuick).toHaveBeenCalledTimes(1);
		expect(sessionStorageSpies.listCandidates).toHaveBeenCalledTimes(1);
	});

	it('keeps the latest Continue row when search projection no longer contains it', async () => {
		const latest = {
			puzzleId: 'p1-e',
			name: 'Latest Save',
			source: 'api' as const,
			placedCount: 2,
			pieceCount: 16,
			lastUpdated: 2_000
		};
		mockedDiscoverGalleryProgress
			.mockReturnValueOnce({ byVariantId: new Map([['p1', latest]]), newest: latest })
			.mockReturnValue({ byVariantId: new Map(), newest: null });

		render(GalleryPage);
		await expect.element(page.getByTestId('continue-on-device')).toHaveTextContent('Latest Save');
		await page.getByTestId('search-input').fill('other');
		await vi.waitFor(() => expect(mockedFetchPuzzles).toHaveBeenCalledTimes(2));
		await expect.element(page.getByTestId('continue-on-device')).toHaveTextContent('Latest Save');
	});

	it('shows picker entry for an off-page candidate with no known latest row', async () => {
		sessionStorageSpies.listCandidates.mockReturnValue(['off-page']);
		mockedDiscoverGalleryProgress.mockReturnValue({ byVariantId: new Map(), newest: null });
		render(GalleryPage);
		await expect
			.element(page.getByTestId('continue-on-device'))
			.toHaveTextContent('SAVED PROGRESS AVAILABLE');
		await expect.element(page.getByRole('button', { name: 'View saved progress' })).toBeVisible();
		expect(mockedDiscoverAllSavedProgress).not.toHaveBeenCalled();
	});

	it('clears the saved-progress affordance when authoritative discovery is empty', async () => {
		// The first listResumableSessionCandidateIds call (onMount) returns the
		// stale candidate. After discoverAllSavedProgress purges it via
		// clearSession on a 400 or invalid-session discovery, the post-discovery
		// refresh call returns [] — simulating the real storage state after the
		// purge.
		sessionStorageSpies.listCandidates.mockReturnValueOnce(['deleted-puzzle']).mockReturnValue([]);
		mockedDiscoverGalleryProgress.mockReturnValue({ byVariantId: new Map(), newest: null });
		mockedDiscoverAllSavedProgress.mockResolvedValue({ rows: [], complete: true });
		render(GalleryPage);
		await page.getByRole('button', { name: 'View saved progress' }).click();
		await expect.element(page.getByText('NO SAVED PROGRESS')).toBeVisible();
		await page.getByRole('button', { name: 'Close saved progress' }).click();
		await expect.poll(() => page.getByTestId('continue-on-device').query()).toBeNull();
	});

	it('clears the affordance when a shallow-passing save fails deep validation and stays gone on remount', async () => {
		// Regression: listResumableSessionCandidateIds is a shallow probe
		// (schema version, puzzle-id match, lifecycle active/paused,
		// unsealed, hasUserActivity). A current-schema active save can pass
		// the shallow probe but fail full peekSession() validation (malformed
		// tray order, counters, result-class state, etc.). In that case
		// discoverAllSavedProgress purges the structurally invalid session
		// from storage (local validation is authoritative, like the 400
		// malformed-id case) and returns { rows: [], complete: true }.
		//
		// Two things must happen for the dead affordance to stay gone:
		//   1. The in-memory refresh sets savedProgressCandidateIds from the
		//      authoritative result (items.map(item => item.puzzleId)), so
		//      the affordance disappears immediately on the current mount.
		//   2. The purge removes the session from storage, so onMount's
		//      shallow re-probe on remount does not re-add the dead id.
		//
		// Here listCandidates returns ['stale-id'] on the first call (mount)
		// and [] on the second call (remount), simulating the purge having
		// removed the session from storage during authoritative discovery.
		sessionStorageSpies.listCandidates.mockReturnValueOnce(['stale-id']).mockReturnValue([]);
		mockedDiscoverGalleryProgress.mockReturnValue({ byVariantId: new Map(), newest: null });
		mockedDiscoverAllSavedProgress.mockResolvedValue({ rows: [], complete: true });

		const { unmount } = render(GalleryPage);
		await page.getByRole('button', { name: 'View saved progress' }).click();
		await expect.element(page.getByText('NO SAVED PROGRESS')).toBeVisible();
		await page.getByRole('button', { name: 'Close saved progress' }).click();
		// The affordance must be gone: the authoritative result was empty,
		// so savedProgressCandidateIds is [] regardless of what the shallow
		// probe still returns from storage.
		await expect.poll(() => page.getByTestId('continue-on-device').query()).toBeNull();

		// Remount: onMount re-probes shallow storage. The session was purged
		// during authoritative discovery, so listResumableSessionCandidateIds
		// returns [] and the dead affordance does not reappear.
		unmount();
		render(GalleryPage);
		await expect.poll(() => page.getByTestId('continue-on-device').query()).toBeNull();
	});

	it('keeps the saved-progress affordance when discovery is incomplete', async () => {
		// Regression: when every off-page detail fetch fails transiently,
		// discoverAllSavedProgress resolves with { rows: [], complete: false }.
		// The caller must NOT clear savedProgressCandidateIds, so the VIEW
		// SAVED PROGRESS button remains available for retry. The dialog must
		// surface the retryable outage state, not "NO SAVED PROGRESS" — the
		// local save still exists and discovery was interrupted, not empty.
		sessionStorageSpies.listCandidates.mockReturnValue(['off-page-a', 'off-page-b']);
		mockedDiscoverGalleryProgress.mockReturnValue({ byVariantId: new Map(), newest: null });
		mockedDiscoverAllSavedProgress.mockResolvedValue({ rows: [], complete: false });
		render(GalleryPage);
		await page.getByRole('button', { name: 'View saved progress' }).click();
		await expect.element(page.getByText('UNABLE TO LOAD SAVED PROGRESS — TRY AGAIN')).toBeVisible();
		expect(document.body.textContent).not.toContain('NO SAVED PROGRESS');
		await page.getByRole('button', { name: 'Close saved progress' }).click();
		await expect.element(page.getByRole('button', { name: 'View saved progress' })).toBeVisible();
	});

	it('refreshes candidate ids after a complete mixed discovery and on remount', async () => {
		// Mixed discovery: 'valid' surfaces as a row, 'gone' is purged (404).
		// After a complete discovery, savedProgressCandidateIds is set from
		// the authoritative discovery result (items.map(item => item.puzzleId))
		// so the stale 'gone' id is removed in-memory without re-probing
		// shallow storage. On remount, onMount reads fresh from storage —
		// the purged id does not reappear.
		const validRow: GalleryProgress = {
			puzzleId: 'valid',
			name: 'Valid Save',
			source: 'api',
			placedCount: 1,
			pieceCount: 16,
			lastUpdated: 2_000
		};
		// First call: onMount returns both ids. The post-discovery refresh
		// no longer calls listResumableSessionCandidateIds — it uses the
		// authoritative result instead. Second call: remount onMount reads
		// the post-purge storage state.
		sessionStorageSpies.listCandidates
			.mockReturnValueOnce(['valid', 'gone'])
			.mockReturnValueOnce(['valid']);
		mockedDiscoverGalleryProgress.mockReturnValue({ byVariantId: new Map(), newest: null });
		mockedDiscoverAllSavedProgress.mockResolvedValue({ rows: [validRow], complete: true });

		const { unmount } = render(GalleryPage);
		await page.getByRole('button', { name: 'View saved progress' }).click();
		await expect.element(page.getByText('Valid Save')).toBeVisible();
		await page.getByRole('button', { name: 'Close saved progress' }).click();

		// After discovery, only 'valid' remains — the affordance survives
		// because a valid candidate is still in the list. The stale 'gone'
		// id was dropped by the authoritative result, not a shallow re-probe.
		await expect.element(page.getByRole('button', { name: 'View saved progress' })).toBeVisible();
		// listResumableSessionCandidateIds was called once: on mount only.
		// The post-discovery refresh uses the authoritative result instead.
		expect(sessionStorageSpies.listCandidates).toHaveBeenCalledTimes(1);

		// Remount: onMount reads the post-purge storage state, so 'gone' does
		// not resurface as a candidate.
		unmount();
		render(GalleryPage);
		await expect.element(page.getByRole('button', { name: 'View saved progress' })).toBeVisible();
		expect(sessionStorageSpies.listCandidates).toHaveBeenCalledTimes(2);
	});

	it('stops loading when saved-progress discovery rejects', async () => {
		sessionStorageSpies.listCandidates.mockReturnValue(['off-page']);
		mockedDiscoverGalleryProgress.mockReturnValue({ byVariantId: new Map(), newest: null });
		mockedDiscoverAllSavedProgress.mockRejectedValue(new Error('network down'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		render(GalleryPage);
		await page.getByRole('button', { name: 'View saved progress' }).click();

		// The rejection must not strand the dialog on LOADING forever: loading
		// resets and the retryable-outage state renders in its place. A
		// rejection means discovery never completed, so the dialog must NOT
		// claim progress is gone.
		await expect.element(page.getByText('UNABLE TO LOAD SAVED PROGRESS — TRY AGAIN')).toBeVisible();
		expect(document.body.textContent).not.toContain('LOADING SAVED PROGRESS');
		expect(document.body.textContent).not.toContain('NO SAVED PROGRESS');
		expect(consoleSpy).toHaveBeenCalled();

		// A transient discovery failure must not hide the picker affordance:
		// the candidate ids are left intact so the user can retry.
		await page.getByRole('button', { name: 'Close saved progress' }).click();
		await expect.element(page.getByRole('button', { name: 'View saved progress' })).toBeVisible();

		consoleSpy.mockRestore();
	});

	it('discards a stale rejection resolved after the picker is closed', async () => {
		sessionStorageSpies.listCandidates.mockReturnValue(['off-page']);
		mockedDiscoverGalleryProgress.mockReturnValue({ byVariantId: new Map(), newest: null });
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		let rejectDiscovery!: (error: Error) => void;
		const inFlight = new Promise<GalleryProgressDiscoveryResult>((_, reject) => {
			rejectDiscovery = reject;
		});
		mockedDiscoverAllSavedProgress.mockReturnValueOnce(inFlight);

		render(GalleryPage);
		await page.getByRole('button', { name: 'View saved progress' }).click();
		await expect.element(page.getByText('LOADING SAVED PROGRESS...')).toBeVisible();

		// Close the picker while discovery is still pending: the request id is
		// bumped and the in-flight controller is aborted.
		await page.getByRole('button', { name: 'Close saved progress' }).click();
		await expect
			.poll(() => page.getByRole('dialog', { name: 'Saved progress' }).query())
			.toBeNull();

		// The deferred rejection resolves after close: the catch branch must
		// hit its stale-request guard and early-return without stranding the
		// gallery on an error state or logging past the close.
		rejectDiscovery(new Error('aborted'));
		await expect(() => inFlight).rejects.toThrow('aborted');
		await Promise.resolve();

		expect(document.body.textContent).not.toContain('LOADING SAVED PROGRESS');
		await expect.element(page.getByRole('button', { name: 'View saved progress' })).toBeVisible();
		// The stale/aborted rejection must early-return before console.error,
		// so no error is logged for an intentionally aborted request.
		expect(consoleSpy).not.toHaveBeenCalled();

		consoleSpy.mockRestore();
	});

	it('discards a stale discovery response resolved after the picker is closed', async () => {
		sessionStorageSpies.listCandidates.mockReturnValue(['off-page']);
		mockedDiscoverGalleryProgress.mockReturnValue({ byVariantId: new Map(), newest: null });

		function deferredProgress(): {
			promise: Promise<GalleryProgressDiscoveryResult>;
			resolve: (value: GalleryProgressDiscoveryResult) => void;
		} {
			let resolve!: (value: GalleryProgressDiscoveryResult) => void;
			const promise = new Promise<GalleryProgressDiscoveryResult>((res) => {
				resolve = res;
			});
			return { promise, resolve };
		}

		const rows: GalleryProgress[] = [
			{
				puzzleId: 'off-page',
				name: 'Stale Mission',
				source: 'api',
				placedCount: 1,
				pieceCount: 16,
				lastUpdated: 2_000
			}
		];
		const first = deferredProgress();
		const second = deferredProgress();
		mockedDiscoverAllSavedProgress
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);

		render(GalleryPage);
		await page.getByRole('button', { name: 'View saved progress' }).click();
		await expect.element(page.getByText('LOADING SAVED PROGRESS...')).toBeVisible();

		// Close while the first discovery is still in flight: loading stops.
		await page.getByRole('button', { name: 'Close saved progress' }).click();
		await expect
			.poll(() => page.getByRole('dialog', { name: 'Saved progress' }).query())
			.toBeNull();
		expect(document.body.textContent).not.toContain('LOADING SAVED PROGRESS');

		// Reopen (second request in flight), then resolve the abandoned first
		// request with rows: the stale rows must not publish and must not stop
		// the fresh request's loading state.
		await page.getByRole('button', { name: 'View saved progress' }).click();
		await expect.element(page.getByText('LOADING SAVED PROGRESS...')).toBeVisible();
		first.resolve({ rows, complete: true });
		await first.promise;
		await Promise.resolve();
		expect(document.body.textContent).not.toContain('Stale Mission');
		await expect.element(page.getByText('LOADING SAVED PROGRESS...')).toBeVisible();

		// Close again, then resolve the now-stale second request as empty: the
		// resume candidates must survive (an unfenced empty result would hide
		// the picker entry).
		await page.getByRole('button', { name: 'Close saved progress' }).click();
		await expect
			.poll(() => page.getByRole('dialog', { name: 'Saved progress' }).query())
			.toBeNull();
		second.resolve({ rows: [], complete: true });
		await second.promise;
		await Promise.resolve();
		await expect.element(page.getByRole('button', { name: 'View saved progress' })).toBeVisible();

		// A fresh open still discovers and renders rows.
		mockedDiscoverAllSavedProgress.mockResolvedValue({ rows, complete: true });
		await page.getByRole('button', { name: 'View saved progress' }).click();
		await expect.element(page.getByText('Stale Mission')).toBeVisible();
	});

	it('marks main inert while the saved progress picker is open', async () => {
		sessionStorageSpies.listCandidates.mockReturnValue(['off-page']);
		mockedDiscoverGalleryProgress.mockReturnValue({ byVariantId: new Map(), newest: null });
		render(GalleryPage);
		await page.getByRole('button', { name: 'View saved progress' }).click();
		await expect.poll(() => document.querySelector('main')?.hasAttribute('inert')).toBe(true);
		await page.getByRole('button', { name: 'Close saved progress' }).click();
		await expect.poll(() => document.querySelector('main')?.hasAttribute('inert')).toBe(false);
	});

	it('makes main inert while home discard confirmation is open', async () => {
		const progress = {
			puzzleId: 'p1-e',
			name: 'Resume Me',
			source: 'api' as const,
			placedCount: 2,
			pieceCount: 16,
			lastUpdated: 2_000
		};
		mockedDiscoverGalleryProgress.mockReturnValue({
			byVariantId: new Map([['p1-e', progress]]),
			newest: progress
		});

		render(GalleryPage);
		await page.getByRole('button', { name: 'Discard saved progress' }).click();

		const main = document.querySelector('main')!;
		expect(main.hasAttribute('inert')).toBe(true);
		expect(main.getAttribute('aria-hidden')).toBe('true');
		await expect
			.element(page.getByRole('dialog', { name: 'Discard saved progress' }))
			.toBeVisible();
	});

	it('clears and rediscovers progress after confirmed home discard', async () => {
		const progress = {
			puzzleId: 'p1-e',
			name: 'Resume Me',
			source: 'api' as const,
			placedCount: 2,
			pieceCount: 16,
			lastUpdated: 2_000
		};
		mockedDiscoverGalleryProgress
			.mockReturnValueOnce({ byVariantId: new Map([['p1-e', progress]]), newest: progress })
			.mockReturnValue({ byVariantId: new Map([['p1-e', progress]]), newest: progress });

		render(GalleryPage);
		await expect
			.element(page.getByRole('button', { name: 'Discard saved progress' }))
			.toBeVisible();
		mockedDiscoverGalleryProgress.mockReturnValue({ byVariantId: new Map(), newest: null });
		await page.getByRole('button', { name: 'Discard saved progress' }).click();
		await page
			.getByRole('dialog', { name: 'Discard saved progress' })
			.getByRole('button', { name: 'Discard' })
			.click();

		expect(sessionStorageSpies.clearSession).toHaveBeenCalledWith('p1-e');
		await expect.poll(() => page.getByTestId('continue-on-device').query()).toBeNull();
	});

	it('cancels home discard without clearing and keeps Continue visible', async () => {
		const progress = {
			puzzleId: 'p1-e',
			name: 'Resume Me',
			source: 'api' as const,
			placedCount: 2,
			pieceCount: 16,
			lastUpdated: 2_000
		};
		mockedDiscoverGalleryProgress.mockReturnValue({
			byVariantId: new Map([['p1-e', progress]]),
			newest: progress
		});

		render(GalleryPage);
		await page.getByRole('button', { name: 'Discard saved progress' }).click();
		await page
			.getByRole('dialog', { name: 'Discard saved progress' })
			.getByRole('button', { name: 'Cancel' })
			.click();

		expect(sessionStorageSpies.clearSession).not.toHaveBeenCalled();
		const main = document.querySelector('main')!;
		expect(main.hasAttribute('inert')).toBe(false);
		expect(main.getAttribute('aria-hidden')).not.toBe('true');
		await expect.element(page.getByTestId('continue-on-device')).toBeVisible();
	});

	it('shows empty state when total is 0 and no query is active', async () => {
		render(GalleryPage);

		await expect.element(page.getByTestId('empty-state')).toBeVisible();
	});

	it('uses a document navigation for the admin portal link', async () => {
		render(GalleryPage);

		const adminLink = page.getByRole('link', { name: /admin portal/i });
		await expect.element(adminLink).toHaveAttribute('href', '/admin');
		await expect.element(adminLink).toHaveAttribute('data-sveltekit-reload');
	});

	it('shows no-results state when total is 0 and query is active', async () => {
		mockedFetchPuzzles.mockResolvedValue({ families: [], total: 0, offset: 0, limit: 20 });
		render(GalleryPage);

		const input = page.getByTestId('search-input');
		await input.fill('nonexistent');

		// After debounce fires (300ms) + fetch resolves
		await expect.element(page.getByTestId('no-results-state')).toBeVisible();
	});

	it('calls fetchPuzzles with q after debounce', async () => {
		render(GalleryPage);

		const input = page.getByTestId('search-input');
		await input.fill('forest');

		// Wait for debounce (300ms) and fetch
		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(expect.objectContaining({ q: 'forest' }));
		});
	});

	it('keeps the search input visible while a refetch is in flight after initial load', async () => {
		let resolveRefetch: ((value: FetchPuzzlesResult) => void) | undefined;

		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { q, offset = 0 } = params ?? {};

			if (!q && offset === 0) {
				return {
					families: [makeFamily('p1', { name: 'Initial Result' })],
					total: 1,
					offset: 0,
					limit: 20
				};
			}

			if (q === 'forest' && offset === 0) {
				return new Promise<FetchPuzzlesResult>((resolve) => {
					resolveRefetch = resolve;
				});
			}

			return { families: [], total: 0, offset, limit: 20 };
		});

		render(GalleryPage);

		await expect.element(page.getByText('Initial Result')).toBeVisible();

		const input = page.getByTestId('search-input');
		await expect.element(input).toBeVisible();
		await input.fill('forest');

		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ q: 'forest', category: undefined, offset: 0 })
			);
		});
		await expect.element(page.getByTestId('loading-state')).toBeVisible();
		await expect.element(page.getByTestId('search-input')).toBeVisible();

		resolveRefetch?.({
			families: [makeFamily('p2', { name: 'Filtered Result' })],
			total: 1,
			offset: 0,
			limit: 20
		});
	});

	it('attaches the observer after the sentinel renders', async () => {
		mockedFetchPuzzles.mockResolvedValue({
			families: [makeFamily('p1')],
			total: 1,
			offset: 0,
			limit: 20
		});

		render(GalleryPage);

		await expect.element(page.getByTestId('scroll-sentinel')).toBeInTheDocument();
		await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
		expect(observe).toHaveBeenCalledWith(expect.any(HTMLElement));
	});

	it('shows error state on initial fetch failure', async () => {
		mockedFetchPuzzles.mockRejectedValue(new ApiError(500, 'internal_error', 'Server error'));

		render(GalleryPage);

		await expect.element(page.getByTestId('error-state')).toBeVisible();
	});

	it('renders the search input', async () => {
		render(GalleryPage);

		await expect.element(page.getByTestId('search-input')).toBeVisible();
	});

	it('clears the search immediately when filters are reset', async () => {
		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { q, category, offset = 0 } = params ?? {};

			if (!q && !category && offset === 0) {
				return {
					families: [makeFamily('nature-1', { name: 'Forest Scene', category: 'Nature' })],
					total: 1,
					offset: 0,
					limit: 20
				};
			}

			if (q === 'forest' && !category && offset === 0) {
				return {
					families: [makeFamily('nature-1', { name: 'Forest Scene', category: 'Nature' })],
					total: 1,
					offset: 0,
					limit: 20
				};
			}

			if (q === 'forest' && category === 'Nature' && offset === 0) {
				return {
					families: [],
					total: 0,
					offset: 0,
					limit: 20
				};
			}

			return { families: [], total: 0, offset, limit: 20 };
		});

		render(GalleryPage);

		await expect.element(page.getByText('Forest Scene')).toBeVisible();

		const callsBeforeSearch = mockedFetchPuzzles.mock.calls.length;
		await page.getByTestId('search-input').fill('forest');

		await vi.waitFor(() => {
			expect(mockedFetchPuzzles.mock.calls.length).toBeGreaterThan(callsBeforeSearch);
		});
		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ q: 'forest', category: undefined, offset: 0 })
			);
		});

		const callsBeforeCategoryChange = mockedFetchPuzzles.mock.calls.length;
		await page.getByRole('radio', { name: 'Nature' }).click();

		await vi.waitFor(() => {
			expect(mockedFetchPuzzles.mock.calls.length).toBeGreaterThan(callsBeforeCategoryChange);
		});
		await expect.element(page.getByTestId('no-results-state')).toBeVisible();

		const callsBeforeClear = mockedFetchPuzzles.mock.calls.length;
		await page.getByTestId('clear-filters-btn').click();

		await vi.waitFor(() => {
			expect(mockedFetchPuzzles.mock.calls.length).toBeGreaterThan(callsBeforeClear);
		});

		expect(mockedFetchPuzzles.mock.calls[callsBeforeClear]?.[0]).toMatchObject({
			q: undefined,
			category: undefined,
			offset: 0
		});
	});

	it('does not append stale next-page results after the query changes', async () => {
		let resolveStalePage: ((value: FetchPuzzlesResult) => void) | undefined;
		const stalePagePromise = new Promise<FetchPuzzlesResult>((resolve) => {
			resolveStalePage = resolve;
		});

		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { q, cursor } = params ?? {};
			if (!q && !cursor) {
				return {
					families: [makeFamily('old-1', { name: 'Old Initial Result' })],
					total: 2,
					offset: 0,
					limit: 20,
					nextCursor: 'cursor-page2'
				};
			}

			if (!q && cursor === 'cursor-page2') {
				return stalePagePromise;
			}

			if (q === 'fresh' && !cursor) {
				return {
					families: [makeFamily('fresh-1', { name: 'Fresh Query Result' })],
					total: 1,
					offset: 0,
					limit: 20
				};
			}

			return { families: [], total: 0, offset: 0, limit: 20 };
		});

		render(GalleryPage);

		await expect.element(page.getByText('Old Initial Result')).toBeVisible();
		await expect.element(page.getByTestId('scroll-sentinel')).toBeInTheDocument();
		expect(intersectionCallback).not.toBeNull();

		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);

		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ q: undefined, category: undefined, cursor: 'cursor-page2' })
			);
		});

		await page.getByTestId('search-input').fill('fresh');

		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ q: 'fresh', category: undefined })
			);
		});
		await expect.element(page.getByText('Fresh Query Result')).toBeVisible();

		resolveStalePage?.({
			families: [makeFamily('old-2', { name: 'Stale Page Result' })],
			total: 2,
			offset: 1,
			limit: 20
		});
		await stalePagePromise;
		await Promise.resolve();

		expect(document.querySelectorAll('[data-testid="puzzle-card"]')).toHaveLength(1);
		expect(document.body.textContent).not.toContain('Stale Page Result');
	});

	it('aborts an in-flight next-page request when the query changes', async () => {
		let nextPageSignal: AbortSignal | undefined;

		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { q, cursor } = params ?? {};
			if (!q && !cursor) {
				return {
					families: [makeFamily('old-1', { name: 'Old Initial Result' })],
					total: 2,
					offset: 0,
					limit: 20,
					nextCursor: 'cursor-page2'
				};
			}

			if (!q && cursor === 'cursor-page2') {
				nextPageSignal = params?.signal;
				return new Promise<FetchPuzzlesResult>((_, reject) => {
					params?.signal?.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{ once: true }
					);
				});
			}

			if (q === 'fresh' && !cursor) {
				return {
					families: [makeFamily('fresh-1', { name: 'Fresh Query Result' })],
					total: 1,
					offset: 0,
					limit: 20
				};
			}

			return { families: [], total: 0, offset: 0, limit: 20 };
		});

		render(GalleryPage);

		await expect.element(page.getByText('Old Initial Result')).toBeVisible();
		expect(intersectionCallback).not.toBeNull();

		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);

		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ q: undefined, category: undefined, cursor: 'cursor-page2' })
			);
		});
		expect(nextPageSignal).toBeInstanceOf(AbortSignal);
		expect(nextPageSignal?.aborted).toBe(false);

		await page.getByTestId('search-input').fill('fresh');

		await vi.waitFor(() => {
			expect(nextPageSignal?.aborted).toBe(true);
		});
		await expect.element(page.getByText('Fresh Query Result')).toBeVisible();
	});

	it('clears total during refetch so stale availability badge is hidden', async () => {
		let searchResolve: ((value: FetchPuzzlesResult) => void) | undefined;
		const searchPromise = new Promise<FetchPuzzlesResult>((resolve) => {
			searchResolve = resolve;
		});

		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { q, offset = 0 } = params ?? {};

			if (!q && offset === 0) {
				return {
					families: [makeFamily('p1', { name: 'Initial' })],
					total: 100,
					offset: 0,
					limit: 20
				};
			}

			if (q === 'search' && offset === 0) {
				return searchPromise;
			}

			return { families: [], total: 0, offset, limit: 20 };
		});

		render(GalleryPage);

		await expect.element(page.getByText('Initial')).toBeVisible();
		const badgeInitial = page.getByTestId('availability-badge');
		await expect.element(badgeInitial).toBeVisible();

		const input = page.getByTestId('search-input');
		await input.fill('search');

		await vi.waitFor(() => {
			expect(mockedFetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ q: 'search', offset: 0 })
			);
		});

		// Badge should be hidden while refetch is pending (total is reset to 0)
		await vi.waitFor(() => {
			expect(document.querySelector('[data-testid="availability-badge"]')).toBeNull();
		});

		searchResolve?.({
			families: [makeFamily('p2', { name: 'Searched' })],
			total: 1,
			offset: 0,
			limit: 20
		});

		await expect.element(page.getByText('Searched')).toBeVisible();
		const badgeAfter = page.getByTestId('availability-badge');
		await expect.element(badgeAfter).toBeVisible();
	});

	it('shows load-more error element when next-page fetch fails', async () => {
		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { cursor } = params ?? {};
			if (!cursor) {
				return {
					families: [makeFamily('p1')],
					total: 2,
					offset: 0,
					limit: 20,
					nextCursor: 'cursor-page2'
				};
			}
			throw new ApiError(500, 'internal_error', 'Server error');
		});

		render(GalleryPage);
		await expect.element(page.getByTestId('scroll-sentinel')).toBeInTheDocument();
		expect(intersectionCallback).not.toBeNull();

		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);

		await expect.element(page.getByTestId('load-more-error')).toBeVisible();
	});

	it('clears load-more error and appends puzzles when retry button is clicked', async () => {
		let loadMoreCallCount = 0;
		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { cursor } = params ?? {};
			if (!cursor) {
				return {
					families: [makeFamily('p1')],
					total: 2,
					offset: 0,
					limit: 20,
					nextCursor: 'cursor-page2'
				};
			}
			loadMoreCallCount++;
			if (loadMoreCallCount === 1) throw new ApiError(500, 'internal_error', 'Server error');
			return { families: [makeFamily('p2')], total: 2, offset: 0, limit: 20 };
		});

		render(GalleryPage);
		await expect.element(page.getByTestId('scroll-sentinel')).toBeInTheDocument();

		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);
		await expect.element(page.getByTestId('load-more-error')).toBeVisible();

		await page.getByTestId('load-more-error').getByRole('button').click();

		await vi.waitFor(() => {
			expect(document.querySelector('[data-testid="load-more-error"]')).toBeNull();
		});
		const cards = page.getByTestId('puzzle-card');
		await expect.element(cards.nth(1)).toBeVisible();
	});

	it('does not auto-retry load-more on intersection when in error state', async () => {
		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { cursor } = params ?? {};
			if (!cursor) {
				return {
					families: [makeFamily('p1')],
					total: 2,
					offset: 0,
					limit: 20,
					nextCursor: 'cursor-page2'
				};
			}
			throw new ApiError(500, 'internal_error', 'Server error');
		});

		render(GalleryPage);
		await expect.element(page.getByTestId('scroll-sentinel')).toBeInTheDocument();

		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);
		await expect.element(page.getByTestId('load-more-error')).toBeVisible();

		const callsBeforeReIntersect = mockedFetchPuzzles.mock.calls.length;

		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);

		await Promise.resolve();
		expect(mockedFetchPuzzles.mock.calls.length).toBe(callsBeforeReIntersect);
	});

	it('does not trigger loadNextPage from observer when already loading more', async () => {
		let resolveLoadMore: ((value: FetchPuzzlesResult) => void) | undefined;
		const loadMorePromise = new Promise<FetchPuzzlesResult>((resolve) => {
			resolveLoadMore = resolve;
		});

		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { cursor } = params ?? {};
			if (!cursor) {
				return {
					families: [makeFamily('p1')],
					total: 5,
					offset: 0,
					limit: 20,
					nextCursor: 'cursor-page2'
				};
			}
			return loadMorePromise;
		});

		render(GalleryPage);
		await expect.element(page.getByTestId('scroll-sentinel')).toBeInTheDocument();
		expect(intersectionCallback).not.toBeNull();

		// First intersection triggers loadNextPage
		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);

		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ cursor: 'cursor-page2' })
			);
		});

		const callsWhileLoading = mockedFetchPuzzles.mock.calls.length;

		// Second intersection while loadingMore is true should NOT call loadNextPage
		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);
		await Promise.resolve();

		expect(mockedFetchPuzzles.mock.calls.length).toBe(callsWhileLoading);

		// Clean up the pending promise
		resolveLoadMore?.({ families: [makeFamily('p2')], total: 5, offset: 0, limit: 20 });
		await loadMorePromise;
	});

	it('does not trigger loadNextPage from observer when all items are loaded', async () => {
		mockedFetchPuzzles.mockResolvedValue({
			families: [makeFamily('p1')],
			total: 1,
			offset: 0,
			limit: 20
		});

		render(GalleryPage);
		await expect.element(page.getByTestId('scroll-sentinel')).toBeInTheDocument();
		expect(intersectionCallback).not.toBeNull();

		// Sentinel is visible but hasMore is false (nextCursor is undefined)
		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);

		// Only the initial fetch should have been called, no next-page call
		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledTimes(1);
		});
		expect(fetchPuzzles).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }));
	});

	it('does not fetch duplicates when total grows beyond loaded count but nextCursor is absent', async () => {
		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { cursor } = params ?? {};
			if (!cursor) {
				return {
					families: [makeFamily('p1')],
					total: 3,
					offset: 0,
					limit: 20,
					nextCursor: 'cursor-page2'
				};
			}
			if (cursor === 'cursor-page2') {
				// Simulates a new puzzle inserted: total=4 but this was the last page (no nextCursor)
				return {
					families: [makeFamily('p2')],
					total: 4,
					offset: 1,
					limit: 20
				};
			}
			return { families: [], total: 0, offset: 0, limit: 20 };
		});

		render(GalleryPage);
		await expect.element(page.getByTestId('scroll-sentinel')).toBeInTheDocument();
		expect(intersectionCallback).not.toBeNull();

		// Trigger load-next-page
		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);

		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ cursor: 'cursor-page2' })
			);
		});

		// Wait for the result to be processed
		await vi.waitFor(() => {
			expect(document.querySelectorAll('[data-testid="puzzle-card"]')).toHaveLength(2);
		});

		// Now hasMore should be false (nextCursor is undefined) even though puzzles.length(2) < total(4)
		const callsBeforeReIntersect = mockedFetchPuzzles.mock.calls.length;

		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);
		await Promise.resolve();

		// No additional fetch should have been triggered
		expect(mockedFetchPuzzles.mock.calls.length).toBe(callsBeforeReIntersect);
	});

	it('treats whitespace-only search as no filter after a real search term', async () => {
		mockedFetchPuzzles.mockResolvedValue({
			families: [makeFamily('p1')],
			total: 1,
			offset: 0,
			limit: 20
		});

		render(GalleryPage);
		await expect.element(page.getByTestId('search-input')).toBeVisible();

		const input = page.getByTestId('search-input');
		await input.fill('forest');

		// Wait for the debounced real-search call
		await vi.waitFor(() => {
			expect(mockedFetchPuzzles).toHaveBeenCalledWith(expect.objectContaining({ q: 'forest' }));
		});

		const callsAfterRealSearch = mockedFetchPuzzles.mock.calls.length;
		await input.fill('   ');

		// Wait for the debounced whitespace call (debouncedQuery changes from 'forest' to '')
		await vi.waitFor(() => {
			expect(mockedFetchPuzzles.mock.calls.length).toBeGreaterThan(callsAfterRealSearch);
		});

		// Whitespace was trimmed: call must use q: undefined, never q: '   '
		const newCalls = mockedFetchPuzzles.mock.calls.slice(callsAfterRealSearch);
		const hasWhitespaceQuery = newCalls.some(([params]) => params?.q === '   ');
		expect(hasWhitespaceQuery).toBe(false);
	});
});
