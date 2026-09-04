<script lang="ts">
	import type { PersistedMobileSession } from './mobileAccount';

	export let session: PersistedMobileSession | null;
	export let busy: boolean;
	export let status: 'idle' | 'reconnecting';
	export let error: string | null;
	export let onSignIn: () => void;
	export let onSignOut: () => void;
	export let row: number | string;
</script>

<stackLayout class="account" {row}>
	<gridLayout class="account-row" columns="*,auto">
		{#if session}
			<stackLayout col={0}>
				<label text={session.user.name ?? session.user.email} class="account-name" />
				<label text={session.user.email} class="account-email" />
			</stackLayout>
			<button col={1} text="SIGN OUT" class="account-button" isEnabled={!busy} on:tap={onSignOut} />
		{:else}
			<label col={0} text="SIGNED OUT" class="account-email" verticalAlignment="center" />
			<button col={1} text="SIGN IN" class="account-button" isEnabled={!busy} on:tap={onSignIn} />
		{/if}
	</gridLayout>
	{#if status === 'reconnecting'}
		<label text="Reconnecting…" class="account-status" textWrap="true" />
	{/if}
	{#if error}
		<label text={error} class="account-error" textWrap="true" />
	{/if}
</stackLayout>
