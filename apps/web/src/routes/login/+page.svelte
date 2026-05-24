<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/stores';
	import { getGoogleLoginUrl } from '$lib/services/api';

	const errorMessages: Record<string, string> = {
		google_error: 'Google sign in failed. Try again.',
		session_expired: 'The sign in session expired. Start again.',
		not_allowed: 'This Google account is not on the player access list.',
		server_error: 'The sign in service is unavailable right now.'
	};

	const googleLoginUrl = getGoogleLoginUrl('/');
	const errorMessage = $derived(errorMessages[$page.url.searchParams.get('error') ?? ''] ?? null);
</script>

<svelte:head>
	<title>Player Sign In | Perseus</title>
</svelte:head>

<main
	class="flex min-h-screen items-center justify-center bg-(--bg-0) p-6"
	style="background-image:
		linear-gradient(rgba(0,240,255,0.025) 1px, transparent 1px),
		linear-gradient(90deg, rgba(0,240,255,0.025) 1px, transparent 1px);
		background-size: 48px 48px;"
>
	<section class="w-full max-w-[22rem] border border-(--border) bg-(--bg-1) px-7 py-8">
		<div class="mb-6 text-center">
			<div
				class="mb-2 text-[0.6rem] font-(--font-mono) tracking-[0.2em] text-(--accent) opacity-60"
			>
				// PERSEUS PLAYER
			</div>
			<h1 class="text-[1.45rem] font-(--font-display) font-black tracking-[0.14em] text-(--text-0)">
				PLAYER SIGN IN
			</h1>
		</div>

		<div
			class="mb-6 h-px bg-[linear-gradient(90deg,transparent,var(--border-bright),transparent)]"
		></div>

		<div class="flex flex-col gap-5">
			{#if errorMessage}
				<div
					class="flex items-center gap-2 border border-(--hot-dim) bg-[rgba(255,0,102,0.08)]
						px-3.5 py-2.5 text-[0.7rem] font-(--font-mono) tracking-[0.05em]
						text-(--hot)"
					role="alert"
				>
					<span class="shrink-0 text-[0.85rem] font-black">!</span>
					<span>{errorMessage}</span>
				</div>
			{/if}

			<a
				href={googleLoginUrl}
				class="w-full border border-(--accent) px-4 py-3 text-center text-[0.65rem]
					font-(--font-display) font-bold tracking-[0.2em] text-(--accent)
					transition-all duration-200 hover:bg-(--accent-glow)
					hover:[box-shadow:0_0_25px_var(--accent-glow-strong)]
					hover:[text-shadow:0_0_10px_var(--accent)]"
			>
				SIGN IN WITH GOOGLE
			</a>
		</div>

		<div class="mt-6 text-center">
			<a
				href={resolve('/')}
				class="text-[0.62rem] font-(--font-mono) tracking-[0.15em] text-(--text-2)
					transition-colors duration-150 hover:text-(--accent)"
			>
				← BACK TO ARCADE
			</a>
		</div>
	</section>
</main>
