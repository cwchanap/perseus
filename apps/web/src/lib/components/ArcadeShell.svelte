<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';

	interface ArcadeShellProps {
		children?: Snippet;
		showChrome?: boolean;
		currentPath: string;
		authStatus: 'loading' | 'authenticated' | 'anonymous';
		playerDisplayName: string;
		score: number | null;
		rank: number | null;
		onLogout: () => void;
	}

	type ArcadeRoute = '/' | '/leaderboard' | '/upload' | '/quick' | '/profile';

	interface NavItem {
		label: string;
		href: ArcadeRoute;
		path: ArcadeRoute;
		icon: string;
		testId: string;
	}

	let {
		children,
		showChrome = true,
		currentPath,
		authStatus,
		playerDisplayName,
		score,
		rank,
		onLogout
	}: ArcadeShellProps = $props();

	const navItems: NavItem[] = [
		{
			label: 'Arcade',
			href: '/',
			path: '/',
			icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
			testId: 'arcade-link'
		},
		{
			label: 'Ranks',
			href: '/leaderboard',
			path: '/leaderboard',
			icon: 'M4 20V9h4v11zM10 20V4h4v16zM16 20v-7h4v7z',
			testId: 'leaderboard-link'
		},
		{
			label: 'Upload',
			href: '/upload',
			path: '/upload',
			icon: 'M13 2L4 14h6l-1 8 9-12h-6z',
			testId: 'upload-puzzle-link'
		},
		{
			label: 'Quick',
			href: '/quick',
			path: '/quick',
			icon: 'M8 3l8 9h-5l1 9-8-11h5z',
			testId: 'quick-puzzle-link'
		},
		{
			label: 'Profile',
			href: '/profile',
			path: '/profile',
			icon: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 4a3 3 0 110 6 3 3 0 010-6zm0 14a7 7 0 01-5.6-2.8c.3-2 2.8-3.2 5.6-3.2s5.3 1.2 5.6 3.2A7 7 0 0112 21z',
			testId: 'profile-link'
		}
	];

	const initials = $derived(
		(playerDisplayName || '?')
			.split(' ')
			.filter(Boolean)
			.map((part) => part[0])
			.slice(0, 2)
			.join('')
			.toUpperCase()
	);

	function isActive(path: string): boolean {
		return currentPath === path;
	}

	function openGallerySearch(): void {
		const disclosure = document.querySelector<HTMLDetailsElement>(
			'[data-testid="gallery-search-disclosure"]'
		);
		if (!disclosure) return;

		disclosure.open = true;
		requestAnimationFrame(() => document.getElementById('search-input')?.focus());
	}
</script>

<div
	class={showChrome ? 'arcade-shell' : 'arcade-shell-bypass'}
	data-testid={showChrome ? 'arcade-shell' : undefined}
>
	{#if showChrome}
		<aside class="arcade-sidebar" data-testid="arcade-sidebar" aria-label="Arcade sidebar">
			<a class="brand" href={resolve('/')} aria-label="Perseus Arcade">
				<span class="brand-mark" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="currentColor"
						><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" /></svg
					>
				</span>
				<span class="brand-name">PERSEUS</span>
			</a>

			<nav aria-label="Arcade navigation" class="sidebar-nav">
				{#each navItems as item (item.path)}
					<a
						href={resolve(item.href)}
						class={isActive(item.path) ? 'nav-link nav-link-active' : 'nav-link'}
						aria-current={isActive(item.path) ? 'page' : undefined}
						data-testid={`sidebar-${item.testId}`}
					>
						<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
							><path d={item.icon} /></svg
						>
						<span>{item.label}</span>
					</a>
				{/each}
			</nav>

			<div class="sidebar-spacer"></div>
			{#if authStatus === 'authenticated'}
				<div class="score-card">
					<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
						<path d="M12 2l2.9 6.3 6.9.8-5 4.7 1.3 6.8L12 17.4 5.9 20.6 7.2 13.8l-5-4.7 6.9-.8z" />
					</svg>
					<span data-testid="arcade-score">{score ?? '—'}</span>
					<span class="score-spacer"></span>
					<span data-testid="arcade-rank">#{rank ?? '—'}</span>
				</div>
				<div class="profile-card">
					<a
						href={resolve('/profile')}
						class="profile-avatar"
						aria-label={`Profile for ${playerDisplayName}`}
					>
						{initials}
					</a>
					<button type="button" class="logout-button" onclick={onLogout}>SIGN OUT</button>
				</div>
			{:else if authStatus === 'loading'}
				<span class="auth-pending" role="status">CHECKING PLAYER…</span>
			{:else}
				<a href={resolve('/login')} class="sign-in-link">SIGN IN</a>
			{/if}
		</aside>
	{/if}

	<div class="arcade-content">
		{#if showChrome}
			<header class="compact-header" data-testid="arcade-mobile-header">
				<a class="brand" href={resolve('/')} aria-label="Perseus Arcade">
					<span class="brand-mark" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="currentColor"
							><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" /></svg
						>
					</span>
					<span class="brand-name">PERSEUS</span>
				</a>
				<div class="compact-spacer"></div>
				{#if currentPath === '/'}
					<button
						type="button"
						class="compact-search"
						aria-label="Search puzzles"
						data-testid="arcade-compact-search"
						onclick={openGallerySearch}
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
							<path stroke-linecap="round" stroke-width="2.2" d="M21 21l-5.6-5.6" />
							<circle cx="10" cy="10" r="6.4" stroke-width="2.2" />
						</svg>
					</button>
				{/if}
				{#if authStatus === 'authenticated'}
					<div class="compact-score">
						<span aria-hidden="true">★</span>
						<span data-testid="arcade-compact-score">{score ?? '—'}</span>
					</div>
					<span class="compact-profile-name">{playerDisplayName || 'Player'}</span>
					<a
						href={resolve('/profile')}
						class="profile-avatar compact-avatar"
						aria-label={`Profile for ${playerDisplayName}`}
					>
						{initials}
					</a>
				{:else if authStatus === 'anonymous'}
					<a href={resolve('/login')} class="compact-sign-in">SIGN IN</a>
				{/if}

				<details class="compact-menu">
					<summary
						class="compact-menu-toggle"
						aria-label="Open arcade menu"
						data-testid="arcade-mobile-menu-toggle"
					>
						<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
							<path d="M4 5h16v2H4zm0 6h16v2H4zm0 6h16v2H4z" />
						</svg>
						<span class="sr-only">Open arcade menu</span>
					</summary>
					<div class="compact-menu-panel">
						<nav class="compact-nav" data-testid="arcade-mobile-nav" aria-label="Player navigation">
							{#each navItems as item (item.path)}
								<a
									href={resolve(item.href)}
									class={isActive(item.path)
										? 'compact-nav-link nav-link-active'
										: 'compact-nav-link'}
									aria-current={isActive(item.path) ? 'page' : undefined}
									data-testid={item.testId}
								>
									<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
										><path d={item.icon} /></svg
									>
									<span>{item.label}</span>
								</a>
							{/each}
						</nav>
						{#if authStatus === 'authenticated'}
							<button type="button" class="compact-menu-logout" onclick={onLogout}>SIGN OUT</button>
						{/if}
					</div>
				</details>
			</header>
		{/if}

		<div class="arcade-page">
			{#if children}{@render children()}{/if}
		</div>
	</div>
</div>

<style>
	.arcade-shell {
		min-height: 100vh;
		background-color: var(--bg-0);
		background-image:
			radial-gradient(circle at 22% 0%, rgba(255, 46, 166, 0.16), transparent 38%),
			radial-gradient(circle at 92% 12%, rgba(0, 240, 255, 0.16), transparent 36%),
			radial-gradient(circle at 60% 104%, rgba(255, 204, 0, 0.1), transparent 42%);
		color: var(--text-0);
	}

	.arcade-shell-bypass {
		display: contents;
	}

	.arcade-sidebar {
		display: none;
	}

	.arcade-content {
		flex: 1;
		min-width: 0;
		min-height: 100vh;
	}

	.compact-header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 18px 18px 12px;
		box-sizing: border-box;
		min-height: 66px;
		position: relative;
		z-index: 2;
	}

	.compact-menu {
		position: relative;
		flex: 0 0 auto;
	}

	.compact-menu-toggle {
		display: flex;
		width: 38px;
		height: 38px;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		border: 1px solid var(--border-bright);
		border-radius: 13px;
		background: var(--bg-2);
		color: var(--text-1);
		list-style: none;
		cursor: pointer;
	}

	.compact-menu-toggle::-webkit-details-marker {
		display: none;
	}

	.compact-menu-toggle svg {
		width: 18px;
		height: 18px;
	}

	.compact-menu-toggle:hover,
	.compact-menu[open] .compact-menu-toggle,
	.compact-menu-toggle:focus-visible {
		border-color: var(--accent);
		color: var(--accent);
	}

	.compact-menu-panel {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		z-index: 10;
		display: flex;
		min-width: 180px;
		flex-direction: column;
		gap: 4px;
		padding: 8px;
		border: 1px solid var(--border-bright);
		border-radius: 14px;
		background: var(--bg-2);
		box-shadow: 0 16px 30px rgba(0, 0, 0, 0.5);
	}

	.compact-nav {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0;
		padding: 0;
	}

	.compact-nav-link {
		display: flex;
		align-items: center;
		gap: 10px;
		border-radius: 11px;
		padding: 10px 11px;
		color: var(--text-1);
		font-size: 0.85rem;
		font-weight: 600;
		text-decoration: none;
	}

	.compact-nav-link svg {
		width: 17px;
		height: 17px;
	}

	.compact-nav-link:hover,
	.compact-nav-link.nav-link-active {
		background: var(--accent);
		color: #03202a;
	}

	.compact-menu-logout {
		margin-top: 4px;
		border: 0;
		border-top: 1px solid var(--border);
		background: transparent;
		padding: 11px;
		color: var(--text-1);
		font-family: var(--font-display);
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-align: left;
		cursor: pointer;
	}

	.compact-menu-logout:hover,
	.compact-menu-logout:focus-visible {
		color: var(--accent);
	}

	.compact-search {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 38px;
		height: 38px;
		flex: 0 0 auto;
		border: 1px solid var(--border-bright);
		border-radius: 13px;
		background: var(--bg-2);
		color: var(--text-0);
		cursor: pointer;
	}

	.compact-search:hover,
	.compact-search:focus-visible {
		border-color: var(--accent);
		color: var(--accent);
	}

	.compact-search svg {
		width: 18px;
		height: 18px;
	}

	.brand {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		color: #fff;
		font-family: var(--font-display);
		font-size: 1rem;
		font-weight: 900;
		letter-spacing: 0.05em;
		text-decoration: none;
	}

	.brand-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: 12px;
		background: linear-gradient(160deg, #3affff, #00b4d8);
		box-shadow:
			0 3px 0 #00707f,
			0 6px 16px rgba(0, 240, 255, 0.42);
		color: #052028;
	}

	.brand-mark svg {
		width: 20px;
		height: 20px;
	}

	.compact-spacer,
	.score-spacer {
		flex: 1;
	}

	.compact-score,
	.score-card {
		display: flex;
		align-items: center;
		gap: 7px;
		border: 1px solid rgba(255, 204, 0, 0.4);
		border-radius: 16px;
		background: rgba(255, 204, 0, 0.12);
		color: var(--gold);
		font-family: var(--font-display);
		font-weight: 900;
	}

	.compact-score {
		padding: 7px 11px;
		font-size: 0.8rem;
	}

	.compact-sign-in,
	.sign-in-link,
	.logout-button {
		color: var(--text-1);
		font-family: var(--font-display);
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-decoration: none;
	}

	.compact-sign-in:hover,
	.sign-in-link:hover,
	.logout-button:hover {
		color: var(--accent);
	}

	.compact-profile-name {
		max-width: 130px;
		overflow: hidden;
		color: var(--text-1);
		font-size: 0.95rem;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.profile-avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		flex: 0 0 auto;
		border-radius: 14px;
		background: linear-gradient(160deg, #ff5cc0, #e0148c);
		box-shadow: 0 3px 0 #8c0a55;
		color: #fff;
		font-family: var(--font-display);
		font-size: 0.75rem;
		font-weight: 700;
		text-decoration: none;
	}

	.compact-avatar {
		width: 38px;
		height: 38px;
		border-radius: 13px;
	}

	.arcade-page {
		min-width: 0;
	}

	@media (max-width: 1439px) {
		.compact-header {
			min-height: 80px;
			padding: 22px 28px 18px;
		}

		.compact-header .brand-mark {
			width: 40px;
			height: 40px;
			border-radius: 13px;
		}

		.compact-header .brand-mark svg {
			width: 22px;
			height: 22px;
		}

		.compact-header .brand-name,
		.compact-header .compact-profile-name,
		.arcade-page {
			position: relative;
			z-index: 1;
		}

		.compact-header .brand-name,
		.compact-header .compact-profile-name {
			display: none;
		}
	}

	@media (min-width: 1440px) {
		.arcade-shell {
			display: flex;
		}

		.arcade-sidebar {
			display: flex;
			width: 232px;
			flex-shrink: 0;
			flex-direction: column;
			gap: 6px;
			min-height: 100vh;
			box-sizing: border-box;
			padding: 26px 18px;
			border-right: 1px solid var(--border);
			background: rgba(21, 13, 51, 0.66);
		}

		.compact-header,
		.compact-menu {
			display: none;
		}

		.sidebar-nav {
			display: flex;
			flex-direction: column;
			gap: 2px;
			margin-top: 12px;
		}

		.nav-link {
			display: flex;
			align-items: center;
			gap: 12px;
			border-radius: 15px;
			padding: 12px 14px;
			color: #b6a6ff;
			font-size: 1rem;
			font-weight: 600;
			text-decoration: none;
		}

		.nav-link svg {
			width: 20px;
			height: 20px;
		}

		.nav-link:hover,
		.nav-link.nav-link-active {
			background: linear-gradient(160deg, #5affff, #00c2dc);
			box-shadow: 0 4px 0 #00707f;
			color: #03202a;
		}

		.sidebar-spacer {
			flex: 1;
		}

		.score-card {
			padding: 12px 14px;
			font-size: 1rem;
		}

		.score-card svg {
			width: 19px;
			height: 19px;
		}

		.profile-card {
			display: flex;
			align-items: center;
			gap: 10px;
			padding: 10px 4px 0;
		}

		.logout-button {
			padding: 0;
			border: 0;
			background: transparent;
			cursor: pointer;
			font-size: 0.58rem;
			text-align: left;
		}

		.auth-pending {
			padding: 12px 14px;
			color: var(--text-2);
			font-family: var(--font-mono);
			font-size: 0.65rem;
			letter-spacing: 0.1em;
		}
	}

	@media (max-width: 640px) {
		.compact-header {
			min-height: 66px;
			padding: 18px 18px 12px;
		}

		.compact-header .brand-mark {
			width: 34px;
			height: 34px;
			border-radius: 11px;
		}

		.compact-header .brand-mark svg {
			width: 19px;
			height: 19px;
		}

		.compact-score {
			gap: 5px;
			padding: 6px 9px;
			font-size: 0.72rem;
		}

		.compact-header .compact-search {
			width: 44px;
			height: 44px;
		}

		.compact-menu-toggle {
			width: 44px;
			height: 44px;
			border-radius: 11px;
		}

		.compact-header .compact-avatar {
			width: 44px;
			height: 44px;
		}
	}
</style>
