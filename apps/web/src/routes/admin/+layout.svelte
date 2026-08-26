<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import {
		forceAdminDocumentNavigation,
		isClientRoutedAdminPath
	} from '$lib/services/adminNavigation';

	let { children } = $props();
	let redirecting = $state(true);

	onMount(() => {
		const shouldRedirect = isClientRoutedAdminPath($page.url.pathname);
		redirecting = shouldRedirect;

		if (shouldRedirect) {
			forceAdminDocumentNavigation($page.url);
		}
	});
</script>

{#if !redirecting}
	{@render children()}
{/if}
