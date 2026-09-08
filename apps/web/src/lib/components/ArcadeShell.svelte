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
				<div class="score-card" aria-label={`Score ${score ?? 0}, rank ${rank ?? 'unranked'}`}>
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
				{#if authStatus === 'authenticated'}
					<div class="compact-score" aria-label={`Score ${score ?? 0}, rank ${rank ?? 'unranked'}`}>
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
					<button type="button" class="compact-logout" onclick={onLogout}>SIGN OUT</button>
				{:else if authStatus === 'anonymous'}
					<a href={resolve('/login')} class="compact-sign-in">SIGN IN</a>
				{/if}
			</header>

			<nav class="compact-nav" data-testid="arcade-mobile-nav" aria-label="Player navigation">
				{#each navItems as item (item.path)}
					<a
						href={resolve(item.href)}
						class={isActive(item.path) ? 'compact-nav-link nav-link-active' : 'compact-nav-link'}
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
		min-width: 0;
		min-height: 100vh;
	}

	.compact-header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 18px 18px 12px;
	}

	.compact-nav {
		display: flex;
		gap: 8px;
		overflow-x: auto;
		padding: 0 18px 16px;
		-webkit-overflow-scrolling: touch;
	}

	.compact-nav-link {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 7px;
		border: 1px solid var(--border);
		border-radius: 18px;
		padding: 9px 14px;
		color: var(--text-1);
		font-size: 0.85rem;
		font-weight: 600;
		text-decoration: none;
	}

	.compact-nav-link svg {
		width: 16px;
		height: 16px;
	}

	.compact-nav-link:hover,
	.compact-nav-link.nav-link-active {
		border-color: var(--accent);
		background: var(--accent);
		color: #03202a;
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
	.logout-button,
	.compact-logout {
		color: var(--text-1);
		font-family: var(--font-display);
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-decoration: none;
	}

	.compact-sign-in:hover,
	.sign-in-link:hover,
	.logout-button:hover,
	.compact-logout:hover {
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

	.compact-logout {
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
		font-size: 0.58rem;
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
		.compact-nav {
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
			padding-top: 20px;
		}

		.brand-name {
			font-size: 0.9rem;
		}

		.compact-nav {
			padding-bottom: 12px;
		}
	}
</style>
