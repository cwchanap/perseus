<script lang="ts">
	import { goto } from '$app/navigation';
	import { login, ApiError } from '$lib/services/api';
	import { resolve } from '$app/paths';

	let passkey = $state('');
	let error: string | null = $state(null);
	let loading = $state(false);

	async function handleSubmit(event: Event) {
		event.preventDefault();
		error = null;
		loading = true;

		try {
			const result = await login(passkey);
			if (result.success) {
				passkey = '';
				goto(resolve('/admin'));
			} else {
				error = result.error || 'Login failed';
			}
		} catch (e) {
			if (e instanceof ApiError) {
				error = e.message;
			} else {
				error = 'Failed to connect to server';
			}
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>Admin Access | Perseus</title>
</svelte:head>

<main
	class="flex min-h-screen items-center justify-center bg-(--bg-0) [background-image:linear-gradient(rgba(0,240,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(0,240,255,0.025)_1px,transparent_1px)]
[background-size:48px_48px]
p-6"
>
	<div class="w-full max-w-[22rem] border border-(--border) bg-(--bg-1) px-7 py-8">
		<div class="mb-6 text-center">
			<div
				class="mb-2 text-[0.6rem] font-(--font-mono) tracking-[0.2em] text-(--accent) opacity-60"
			>
				// PERSEUS SYSTEM
			</div>
			<h1 class="text-[1.5rem] font-(--font-display) font-black tracking-[0.15em] text-(--text-0)">
				ADMIN ACCESS
			</h1>
			<p class="mt-1.5 text-[0.65rem] font-(--font-mono) tracking-[0.1em] text-(--text-2)">
				Enter your passkey to authenticate
			</p>
		</div>

		<div
			class="mb-6 h-px bg-[linear-gradient(90deg,transparent,var(--border-bright),transparent)]"
		></div>

		<form onsubmit={handleSubmit} class="flex flex-col gap-5">
			{#if error}
				<div
					class="flex items-center gap-2 border border-(--hot-dim) bg-[rgba(255,0,102,0.08)]
px-3.5 py-2.5 text-[0.7rem] font-(--font-mono) tracking-[0.05em]
text-(--hot)"
					role="alert"
				>
					<span class="shrink-0 text-[0.85rem] font-black">!</span>
					{error}
				</div>
			{/if}

			<div class="flex flex-col gap-1.5">
				<label
					for="passkey"
					class="text-[0.58rem] font-(--font-display) font-semibold tracking-[0.2em]
text-(--text-2)"
				>
					PASSKEY
				</label>
				<input
					id="passkey"
					type="password"
					bind:value={passkey}
					required
					class="w-full border border-(--border) bg-(--bg-0) px-4 py-3 text-[0.9rem]
font-(--font-mono) tracking-[0.1em] text-(--text-0)
transition-[border-color,box-shadow] duration-150 placeholder:text-(--text-2)
focus:border-(--accent) focus:[box-shadow:0_0_15px_var(--accent-glow)]
focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
					placeholder="••••••••"
					disabled={loading}
				/>
			</div>

			<button
				type="submit"
				disabled={loading || !passkey}
				class="w-full border border-(--accent) px-4 py-3 text-[0.65rem] font-(--font-display)
font-bold tracking-[0.25em] text-(--accent) transition-all duration-200
hover:bg-(--accent-glow)
hover:[box-shadow:0_0_25px_var(--accent-glow-strong)]
hover:[text-shadow:0_0_10px_var(--accent)] disabled:cursor-not-allowed
disabled:opacity-40"
			>
				{#if loading}
					<span class="flex items-center justify-center gap-2">
						<span
							class="h-3.5 w-3.5 rounded-full border-2 border-(--accent-dim) border-t-(--accent)
motion-safe:animate-[spin-cw_0.75s_linear_infinite]
motion-reduce:animate-none"
						></span>
						AUTHENTICATING...
					</span>
				{:else}
					AUTHENTICATE
				{/if}
			</button>
		</form>

		<div class="mt-6 text-center">
			<a
				href={resolve('/')}
				class="text-[0.62rem] font-(--font-mono) tracking-[0.15em] text-(--text-2)
transition-colors duration-150 hover:text-(--accent)"
			>
				← BACK TO ARCADE
			</a>
		</div>
	</div>
</main>
