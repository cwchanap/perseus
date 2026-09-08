<script lang="ts">
	import { resolve } from '$app/paths';
	import AdminPuzzlesPanel from './AdminPuzzlesPanel.svelte';
	import PlayerAccessPanel from './PlayerAccessPanel.svelte';

	type AdminTab = 'puzzles' | 'players';

	let activeTab: AdminTab = $state('puzzles');
	let missionCount = $state(0);
	let playerCount = $state(0);

	function handleTabKeydown(event: KeyboardEvent, currentTab: AdminTab) {
		let nextTab: AdminTab;
		switch (event.key) {
			case 'ArrowRight':
			case 'ArrowLeft':
				nextTab = currentTab === 'puzzles' ? 'players' : 'puzzles';
				break;
			case 'Home':
				nextTab = 'puzzles';
				break;
			case 'End':
				nextTab = 'players';
				break;
			default:
				return;
		}

		event.preventDefault();
		activeTab = nextTab;
		document.getElementById(`admin-tab-${nextTab}`)?.focus();
	}
</script>

<svelte:head>
	<title>Admin Portal | Perseus</title>
</svelte:head>

<main
	class="min-h-screen bg-(--bg-0) [background-image:radial-gradient(circle_at_18%_0%,rgba(255,46,166,0.12),transparent_36%),radial-gradient(circle_at_94%_8%,rgba(0,240,255,0.13),transparent_34%)]
text-(--text-0)"
>
	<div class="flex min-h-screen flex-col min-[900px]:flex-row">
		<aside
			class="flex w-full shrink-0 flex-col gap-1 border-b border-(--border) bg-[rgba(21,13,51,0.66)]
			px-5 py-6 min-[900px]:w-[232px] min-[900px]:border-r min-[900px]:border-b-0"
			aria-label="Admin sidebar"
		>
			<div class="flex items-center gap-3 px-1 pb-3">
				<span
					class="flex h-10 w-10 items-center justify-center rounded-[13px] bg-[linear-gradient(160deg,#3affff,#00b4d8)]
					text-[#052028] shadow-[0_4px_0_#00707f,0_8px_18px_rgba(0,240,255,0.4)]"
					aria-hidden="true"
				>
					<svg viewBox="0 0 24 24" class="h-[22px] w-[22px]" fill="currentColor">
						<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
					</svg>
				</span>
				<div>
					<div class="text-[15px] font-(--font-display) font-black tracking-[0.05em]">PERSEUS</div>
					<div
						class="text-[12.5px] font-(--font-body) font-semibold tracking-[0.1em] text-(--text-2)"
					>
						ADMIN
					</div>
				</div>
			</div>

			<div class="mx-1 mb-3 h-px bg-(--border)"></div>

			<div class="flex flex-col gap-1" role="tablist" aria-label="Admin sections">
				<button
					id="admin-tab-puzzles"
					type="button"
					role="tab"
					aria-selected={activeTab === 'puzzles'}
					aria-controls="admin-panel-puzzles"
					aria-describedby="admin-missions-count"
					tabindex={activeTab === 'puzzles' ? 0 : -1}
					onclick={() => (activeTab = 'puzzles')}
					onkeydown={(event) => handleTabKeydown(event, 'puzzles')}
					class="flex items-center gap-3 rounded-[15px] px-3.5 py-3 text-left text-[15.5px]
					font-(--font-body) font-bold tracking-[0.03em] text-(--text-1) transition-colors
					hover:bg-(--bg-2) hover:text-(--text-0)
					{activeTab === 'puzzles' ? 'bg-(--accent-glow) text-(--accent)' : ''}"
				>
					<svg viewBox="0 0 24 24" class="h-5 w-5 shrink-0" fill="currentColor" aria-hidden="true">
						<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
					</svg>
					<span>Missions</span>
					<span
						class="ml-auto text-xs font-(--font-display)"
						id="admin-missions-count"
						data-testid="admin-missions-count"
					>
						{missionCount}
					</span>
				</button>
				<button
					id="admin-tab-players"
					type="button"
					role="tab"
					aria-selected={activeTab === 'players'}
					aria-controls="admin-panel-players"
					aria-describedby="admin-players-count"
					tabindex={activeTab === 'players' ? 0 : -1}
					onclick={() => (activeTab = 'players')}
					onkeydown={(event) => handleTabKeydown(event, 'players')}
					class="flex items-center gap-3 rounded-[15px] px-3.5 py-3 text-left text-[15.5px]
					font-(--font-body) font-bold tracking-[0.03em] text-(--text-1) transition-colors
					hover:bg-(--bg-2) hover:text-(--text-0)
					{activeTab === 'players' ? 'bg-(--accent-glow) text-(--accent)' : ''}"
				>
					<svg viewBox="0 0 24 24" class="h-5 w-5 shrink-0" fill="currentColor" aria-hidden="true">
						<path
							d="M9 11a4 4 0 100-8 4 4 0 000 8zm7 0a3 3 0 100-6 3 3 0 000 6zM2 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5zm15.5 0c0-2.3-1-4-2.6-5 3.1.2 5.1 2.2 5.1 5z"
						/>
					</svg>
					<span>Player access</span>
					<span
						class="ml-auto text-xs font-(--font-display)"
						id="admin-players-count"
						data-testid="admin-players-count"
					>
						{playerCount}
					</span>
				</button>
			</div>

			<div class="mx-1 my-3 h-px bg-(--border)"></div>
			<a
				href={resolve('/upload')}
				class="flex items-center gap-3 rounded-[15px] px-3.5 py-3 text-[15.5px] font-(--font-body)
				font-semibold tracking-[0.03em] text-(--text-1) transition-colors hover:bg-(--bg-2) hover:text-(--text-0)"
			>
				<svg viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor" aria-hidden="true">
					<path d="M12 3l4 4h-3v6h-2V7H8zM5 15h14v5H5z" />
				</svg>
				<span>Upload</span>
			</a>
			<a
				href={resolve('/')}
				class="flex items-center gap-3 rounded-[15px] px-3.5 py-3 text-[15.5px] font-(--font-body)
				font-semibold tracking-[0.03em] text-(--text-1) transition-colors hover:bg-(--bg-2) hover:text-(--text-0)"
			>
				<svg viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor" aria-hidden="true">
					<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
				</svg>
				<span>View arcade</span>
			</a>
			<div class="hidden flex-1 min-[900px]:block"></div>
			<div
				class="mt-3 rounded-2xl border border-(--border-bright) bg-(--bg-2) px-3.5 py-3 text-(--text-2)"
			>
				<div class="text-[11px] font-(--font-display) font-bold tracking-[0.12em] text-(--text-0)">
					ADMIN CONSOLE
				</div>
				<div class="mt-1 text-xs font-(--font-body) font-semibold">Manage missions and players</div>
			</div>
		</aside>

		<div class="flex min-w-0 flex-1 flex-col overflow-hidden">
			<header class="flex flex-wrap items-end justify-between gap-4 px-6 pt-7 pb-5 sm:px-8">
				<div>
					<div
						class="mb-1 text-[0.6rem] font-(--font-mono) tracking-[0.2em] text-(--accent) opacity-60"
					>
						// PERSEUS ADMIN
					</div>
					<h1
						class="text-[clamp(1.25rem,4vw,2rem)] font-(--font-display) font-black tracking-[0.1em] text-(--text-0)"
					>
						CONTROL PANEL
					</h1>
				</div>
			</header>
			<div
				class="mx-6 h-px bg-[linear-gradient(90deg,transparent,var(--accent),transparent)] opacity-30 sm:mx-8"
			></div>

			<div
				id="admin-panel-puzzles"
				role="tabpanel"
				aria-labelledby="admin-tab-puzzles"
				hidden={activeTab !== 'puzzles'}
				class="min-w-0 flex-1 px-6 pt-6 pb-10 sm:px-8"
			>
				<AdminPuzzlesPanel
					active={activeTab === 'puzzles'}
					onCountChange={(count) => (missionCount = count)}
				/>
			</div>
			<div
				id="admin-panel-players"
				role="tabpanel"
				aria-labelledby="admin-tab-players"
				hidden={activeTab !== 'players'}
				class="min-w-0 flex-1 px-6 pt-6 pb-10 sm:px-8"
			>
				<PlayerAccessPanel
					active={activeTab === 'players'}
					onCountChange={(count) => (playerCount = count)}
				/>
			</div>
		</div>
	</div>
</main>
