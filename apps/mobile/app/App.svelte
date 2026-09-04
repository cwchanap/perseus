<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Application,
		Connectivity,
		ConnectionType,
		Folder,
		knownFolders,
		path
	} from '@nativescript/core';
	import {
		createSessionStorageAdapter,
		type SealedCompletion,
		type SessionStorageAdapter
	} from '@perseus/game-core';
	import type { PlayerSessionResponse } from '@perseus/types';
	import { createPlayerApi } from './api/playerApi';
	import { createPuzzleApi } from './api/puzzleApi';
	import { nativePuzzleJsonRequest, nativePlayerHttpTransport } from './api/nativeHttp';
	import AccountBar from './account/AccountBar.svelte';
	import {
		applySessionProbe,
		restoreMobileAccount,
		shouldDrainAfterRestore,
		signInMobileAccount,
		signOutMobileAccount,
		type PersistedMobileSession,
		type SessionProbeDecision
	} from './account/mobileAccount';
	import { createCompletionStore } from './completion/completionStore';
	import { drainPendingCompletions } from './completion/completionSync';
	import { createDrainScheduler } from './completion/drainScheduler';
	import { nativeGoogleIdTokenProvider } from './account/nativeGoogleAuth';
	import { nativeMobileSessionStore } from './account/nativeSessionStore';
	import Gameplay from './gameplay/Gameplay.svelte';
	import { createNativeFileOps } from './storage/nativeFileOps';
	import { createFileKeyValueStore } from './storage/fileStore';
	import Library from './library/Library.svelte';
	import {
		createDownloadStore,
		type DownloadCancellation,
		type DownloadStore
	} from './library/downloadStore';
	import { downloadNativeAsset, createNativeDownloadFileOps } from './library/nativeDownloadFiles';
	import type { GameplayLaunch } from './library/downloadedLibrary';

	type MobileScreen = { kind: 'library' } | { kind: 'gameplay'; launch: GameplayLaunch };

	interface ActiveDownloadJob {
		puzzleId: string;
		cancellation: DownloadCancellation;
		done: number;
		total: number;
	}

	const perseusRoot = path.join(knownFolders.documents().path, 'perseus');
	const sessionsRoot = path.join(perseusRoot, 'sessions');
	const completionsRoot = path.join(perseusRoot, 'completions');
	const downloadsRoot = path.join(perseusRoot, 'downloads');

	Folder.fromPath(sessionsRoot);
	if (!Folder.exists(sessionsRoot)) {
		knownFolders.documents().getFolder('perseus').getFolder('sessions');
	}
	Folder.fromPath(completionsRoot);

	const sessionStorage: SessionStorageAdapter = createSessionStorageAdapter({
		store: createFileKeyValueStore({
			rootPath: sessionsRoot,
			fileOps: createNativeFileOps()
		})
	});

	const puzzleApi = createPuzzleApi({
		baseUrl: __PERSEUS_API_BASE__,
		requestJson: nativePuzzleJsonRequest
	});

	const playerApi = createPlayerApi({
		baseUrl: __PERSEUS_API_BASE__,
		transport: nativePlayerHttpTransport
	});

	const completionStore = createCompletionStore({
		rootPath: completionsRoot,
		fileOps: createNativeFileOps()
	});

	const downloadStore: DownloadStore = createDownloadStore({
		rootPath: downloadsRoot,
		fileOps: createNativeDownloadFileOps(),
		downloadAsset: downloadNativeAsset,
		assetUrls: puzzleApi,
		now: () => Date.now()
	});

	let screen: MobileScreen = { kind: 'library' };
	let bootReady = false;
	let bootError: string | null = null;
	let downloadJob: ActiveDownloadJob | null = null;
	let downloadRevision = 0;
	let downloadError: string | null = null;

	let accountSession: PersistedMobileSession | null = null;
	let accountBusy = false;
	let accountStatus: 'idle' | 'reconnecting' = 'idle';
	let accountError: string | null = null;
	// Bumped whenever the active session identity changes (sign-in, sign-out,
	// clear). Async results captured under an older epoch are discarded instead
	// of applied, so a stale account can never rewrite state or secure storage
	// after a logout or account switch.
	let accountEpoch = 0;

	// Application + connectivity listeners run for the app's lifetime and are
	// removed on teardown; no timer is involved.
	onMount(() => {
		const onAppResume = (): void => {
			void validateAndDrainGuarded();
		};
		Application.on(Application.resumeEvent, onAppResume);

		let wasOffline = Connectivity.getConnectionType() === ConnectionType.none;
		Connectivity.startMonitoring((connectionType) => {
			const connected = connectionType !== ConnectionType.none;
			if (wasOffline && connected) void validateAndDrainGuarded();
			wasOffline = !connected;
		});

		return () => {
			Application.off(Application.resumeEvent, onAppResume);
			Connectivity.stopMonitoring();
		};
	});

	onMount(async () => {
		try {
			await downloadStore.cleanupStaleStaging();
		} catch (error) {
			bootError = error instanceof Error ? error.message : 'staging_cleanup_failed';
		} finally {
			bootReady = true;
		}
	});

	// Restore is independent of library boot: a slow or failed session probe
	// must not block the offline library.
	onMount(async () => {
		const raw = nativeMobileSessionStore.read();
		const restored = raw !== null ? restoreMobileAccount(raw, Date.now()) : null;
		if (!restored) {
			if (raw !== null) nativeMobileSessionStore.clear();
			return;
		}
		const epoch = accountEpoch;
		accountSession = restored;
		accountStatus = 'reconnecting';
		try {
			const response = await playerApi.getSession(restored.token);
			// A sign-in/out during the probe makes this restore stale: discard it.
			if (epoch !== accountEpoch) return;
			const decision = applySessionProbe(restored, response);
			if (decision.kind === 'cleared') {
				clearAccountSession();
			} else {
				accountSession = decision.session;
				nativeMobileSessionStore.write(JSON.stringify(decision.session));
				if (shouldDrainAfterRestore(decision)) {
					accountStatus = 'idle';
					// Cold launch while already online: resume/connectivity triggers
					// don't fire on a fresh launch, so drain here instead of leaving
					// pending records stranded until an unrelated later event.
					void validateAndDrainGuarded();
				}
			}
		} catch {
			// Probe failed (offline/server error): keep the session and stay reconnecting.
		}
	});

	// --- Completion syncing -------------------------------------------------------

	// Single-flight pass scheduling (sign-in, completion, resume, connectivity
	// triggers share one validate+drain pass) with a trailing-edge requeue: a
	// trigger arriving mid-pass queues exactly one follow-up pass, so records
	// that landed after the pass's pending snapshot still drain immediately.
	const drainScheduler = createDrainScheduler({
		startPass: (epoch) => validateAndDrain(epoch),
		currentEpoch: () => accountEpoch,
		onError: (error) => {
			console.error('completion_drain_failed', error);
		}
	});

	function validateAndDrainGuarded(): Promise<void> {
		return drainScheduler.trigger();
	}

	function clearAccountSession(): void {
		accountEpoch += 1;
		nativeMobileSessionStore.clear();
		accountSession = null;
		accountStatus = 'idle';
	}

	function persistAccountSession(session: PersistedMobileSession): void {
		accountSession = session;
		nativeMobileSessionStore.write(JSON.stringify(session));
	}

	// Apply a probe decision to secure storage + memory: persist the returned
	// session (strike-1 or refreshed), or clear on a cleared decision. Stale
	// results (epoch moved on mid-pass) are discarded.
	function applyProbeDecision(epoch: number, decision: SessionProbeDecision): void {
		if (epoch !== accountEpoch) return;
		if (decision.kind === 'cleared') {
			clearAccountSession();
			return;
		}
		persistAccountSession(decision.session);
		accountStatus = decision.kind === 'uncertain' ? 'reconnecting' : 'idle';
	}

	// The single validated drain path: probe the session before every pass,
	// then drain this account's pending completions. `epoch` is captured when
	// the pass starts; every application point re-checks it so a logout or
	// account switch mid-pass discards the stale result.
	async function validateAndDrain(epoch: number): Promise<void> {
		const session = accountSession;
		if (!session) return;

		// Locally expired: clear secure + memory without any request.
		if (session.expiresAt <= Date.now()) {
			clearAccountSession();
			return;
		}

		let response: PlayerSessionResponse;
		try {
			response = await playerApi.getSession(session.token);
		} catch {
			// Transport/5xx from the probe: keep account + counter, skip this pass.
			return;
		}
		if (epoch !== accountEpoch) return;

		const decision = applySessionProbe(session, response);
		applyProbeDecision(epoch, decision);
		if (decision.kind !== 'authenticated') return;

		const disposition = await drainPendingCompletions({
			activeSession: decision.session,
			api: playerApi,
			store: completionStore
		});
		if (epoch !== accountEpoch) return;
		if (disposition !== 'auth_required') return;

		// A 401 from the completion POST is only one strike: feed it through
		// the same two-strike probe policy once. The bearer is never deleted on
		// a single 401 — only a second consecutive unauthenticated result clears.
		applyProbeDecision(epoch, applySessionProbe(decision.session, { authenticated: false }));
	}

	function onGameplayCompletion(puzzleId: string, seal: SealedCompletion): void {
		const accountId = accountSession?.user.id ?? null;
		try {
			const record = completionStore.recordCompletion({ puzzleId, seal, accountId });
			if (record.syncStatus === 'pending') void validateAndDrainGuarded();
		} catch (error) {
			// The run stays unsynced: never POST without a durable local record.
			console.error('completion_record_write_failed', error);
		}
	}

	async function handleSignIn(): Promise<void> {
		if (accountBusy) return;
		accountBusy = true;
		accountError = null;
		try {
			const session = await signInMobileAccount({
				provider: nativeGoogleIdTokenProvider,
				api: playerApi,
				store: nativeMobileSessionStore
			});
			// Publish atomically: bumping with the assignment makes every
			// in-flight restore/pass for the previous session stale before any
			// of its results can overwrite the new account's state. The old
			// session stays active if the exchange fails.
			accountEpoch += 1;
			accountSession = session;
			accountStatus = 'idle';
			// Freshly validated credential: drain anything signed in earlier.
			void validateAndDrainGuarded();
		} catch (error) {
			accountError = error instanceof Error ? error.message : 'google_sign_in_failed';
		} finally {
			accountBusy = false;
		}
	}

	// signOutMobileAccount never throws on remote failures, but a secure-store
	// clear failure does propagate: surface it instead of pretending the
	// bearer is gone. The session is dropped from memory and the epoch is
	// bumped immediately, so in-flight account work goes inert right away.
	async function handleSignOut(): Promise<void> {
		if (accountBusy || !accountSession) return;
		accountBusy = true;
		const token = accountSession.token;
		accountEpoch += 1;
		accountSession = null;
		accountStatus = 'idle';
		try {
			await signOutMobileAccount({
				provider: nativeGoogleIdTokenProvider,
				api: playerApi,
				store: nativeMobileSessionStore,
				token
			});
		} catch (error) {
			accountError = error instanceof Error ? error.message : 'sign_out_failed';
		} finally {
			accountBusy = false;
		}
	}

	async function startDownload(puzzleId: string): Promise<void> {
		if (downloadJob !== null) return;
		const cancellation: DownloadCancellation = { cancelled: false };
		downloadJob = { puzzleId, cancellation, done: 0, total: 0 };
		downloadError = null;

		try {
			const puzzle = await puzzleApi.getPuzzle(puzzleId);
			await downloadStore.downloadPuzzle(puzzle, cancellation, (done, total) => {
				if (downloadJob?.puzzleId === puzzleId) {
					downloadJob = { ...downloadJob, done, total };
				}
			});
		} catch (error) {
			if (error instanceof Error && error.message === 'download_cancelled') return;
			downloadError = error instanceof Error ? error.message : 'download_failed';
		} finally {
			downloadJob = null;
			downloadRevision += 1;
		}
	}

	function cancelDownload(): void {
		if (downloadJob) downloadJob.cancellation.cancelled = true;
	}
</script>

<frame>
	<page actionBarHidden="true" backgroundColor="#111820">
		{#if !bootReady}
			<stackLayout>
				<activityIndicator busy={true} />
				<label text="Preparing offline library…" color="#f7fafc" textAlignment="center" />
			</stackLayout>
		{:else if bootError}
			<stackLayout>
				<label text="Unable to prepare offline library." color="#f7fafc" textWrap="true" />
				<label text={bootError} color="#f6e05e" textWrap="true" />
			</stackLayout>
		{:else if screen.kind === 'library'}
			<gridLayout rows="*,auto">
				<Library
					row={0}
					{puzzleApi}
					{downloadStore}
					{sessionStorage}
					{downloadJob}
					{downloadRevision}
					{downloadError}
					onDownload={startDownload}
					onCancelDownload={cancelDownload}
					onLaunch={(launch) => (screen = { kind: 'gameplay', launch })}
				/>
				<AccountBar
					row={1}
					session={accountSession}
					busy={accountBusy}
					status={accountStatus}
					error={accountError}
					onSignIn={handleSignIn}
					onSignOut={handleSignOut}
				/>
			</gridLayout>
		{:else}
			<Gameplay
				launch={screen.launch}
				storage={sessionStorage}
				onExit={() => (screen = { kind: 'library' })}
				onCompletion={onGameplayCompletion}
			/>
		{/if}
	</page>
</frame>
