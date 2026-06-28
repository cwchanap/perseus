<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { playerAuth } from '$lib/stores/playerAuth';

	let { children } = $props();

	let checking = $state(true);
	let authenticated = $state(false);
	let redirecting = $state(false);

	function redirectToLogin() {
		if (redirecting) return;
		redirecting = true;
		goto(resolve('/login'));
	}

	onMount(() => {
		// The root layout already calls playerAuth.refresh() on mount.
		// Subscribe and wait for the store to settle (leave 'loading') before
		// deciding whether to redirect to login. Calling refresh() here would
		// race with the layout's call via the store's operationId guard.
		let settled = false;
		const unsubscribe = playerAuth.subscribe((state) => {
			if (settled || state.status === 'loading') return;
			settled = true;
			authenticated = state.status === 'authenticated';
			checking = false;
			if (!authenticated) {
				redirectToLogin();
			}
		});
		return unsubscribe;
	});
</script>

{#if checking}
	<div
		class="flex min-h-screen flex-col items-center justify-center gap-4"
		role="status"
		aria-live="polite"
	>
		<div
			class="h-9 w-9 rounded-full border-2 border-(--border) border-t-(--accent)
[box-shadow:0_0_20px_var(--accent-glow)] motion-safe:animate-[spin-cw_0.75s_linear_infinite] motion-reduce:animate-none"
		></div>
		<span class="text-xs font-(--font-mono) tracking-[0.25em] text-(--accent) uppercase">
			VERIFYING ACCESS…
		</span>
	</div>
{:else if authenticated}
	{@render children()}
{:else}
	<div
		class="flex min-h-screen flex-col items-center justify-center gap-4"
		role="status"
		aria-live="polite"
	>
		<span class="text-xs font-(--font-mono) tracking-[0.25em] text-(--accent) uppercase">
			REDIRECTING…
		</span>
	</div>
{/if}
