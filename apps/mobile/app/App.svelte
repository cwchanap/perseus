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
		signInMobileAccount,
		signOutMobileAccount,
		type PersistedMobileSession,
		type SessionProbeDecision
	} from './account/mobileAccount';
	import { createCompletionStore } from './completion/completionStore';
	import { drainPendingCompletions } from './completion/completionSync';
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
		accountSession = restored;
		accountStatus = 'reconnecting';
		try {
			const response = await playerApi.getSession(restored.token);
			const decision = applySessionProbe(restored, response);
			if (decision.kind === 'cleared') {
				nativeMobileSessionStore.clear();
				accountSession = null;
				accountStatus = 'idle';
			} else {
				accountSession = decision.session;
				nativeMobileSessionStore.write(JSON.stringify(decision.session));
				if (decision.kind === 'authenticated') accountStatus = 'idle';
			}
		} catch {
			// Probe failed (offline/server error): keep the session and stay reconnecting.
		}
	});

	// --- Completion syncing -------------------------------------------------------

	// One in-memory pass guard: overlapping triggers (sign-in, completion,
	// resume, connectivity) share a single in-flight validate+drain pass.
	let drainPass: Promise<void> | null = null;

	function validateAndDrainGuarded(): Promise<void> {
		if (drainPass !== null) return drainPass;
		drainPass = validateAndDrain()
			.catch((error) => {
				// A failed pass never crashes the app; records stay pending for
				// the next trigger.
				console.error('completion_drain_failed', error);
			})
			.finally(() => {
				drainPass = null;
			});
		return drainPass;
	}

	function clearAccountSession(): void {
		nativeMobileSessionStore.clear();
		accountSession = null;
		accountStatus = 'idle';
	}

	function persistAccountSession(session: PersistedMobileSession): void {
		accountSession = session;
		nativeMobileSessionStore.write(JSON.stringify(session));
	}

	// Apply a probe decision to secure storage + memory: persist the returned
	// session (strike-1 or refreshed), or clear on a cleared decision.
	function applyProbeDecision(decision: SessionProbeDecision): void {
		if (decision.kind === 'cleared') {
			clearAccountSession();
			return;
		}
		persistAccountSession(decision.session);
		accountStatus = decision.kind === 'uncertain' ? 'reconnecting' : 'idle';
	}

	// The single validated drain path: probe the session before every pass,
	// then drain this account's pending completions.
	async function validateAndDrain(): Promise<void> {
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

		const decision = applySessionProbe(session, response);
		applyProbeDecision(decision);
		if (decision.kind !== 'authenticated') return;

		const disposition = await drainPendingCompletions({
			activeSession: decision.session,
			api: playerApi,
			store: completionStore
		});
		if (disposition !== 'auth_required') return;

		// A 401 from the completion POST is only one strike: feed it through
		// the same two-strike probe policy once. The bearer is never deleted on
		// a single 401 — only a second consecutive unauthenticated result clears.
		applyProbeDecision(applySessionProbe(decision.session, { authenticated: false }));
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
			accountSession = await signInMobileAccount({
				provider: nativeGoogleIdTokenProvider,
				api: playerApi,
				store: nativeMobileSessionStore
			});
			// Freshly validated credential: drain anything signed in earlier.
			void validateAndDrainGuarded();
		} catch (error) {
			accountError = error instanceof Error ? error.message : 'google_sign_in_failed';
		} finally {
			accountBusy = false;
		}
	}

	// signOutMobileAccount never throws: remote failures still clear locally.
	async function handleSignOut(): Promise<void> {
		if (accountBusy || !accountSession) return;
		accountBusy = true;
		const token = accountSession.token;
		await signOutMobileAccount({
			provider: nativeGoogleIdTokenProvider,
			api: playerApi,
			store: nativeMobileSessionStore,
			token
		});
		accountSession = null;
		accountStatus = 'idle';
		accountBusy = false;
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
