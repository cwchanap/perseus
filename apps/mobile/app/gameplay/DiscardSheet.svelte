<script lang="ts">
	export let error = '';
	export let onConfirm: () => void;
	export let onCancel: () => void;
</script>

<stackLayout class="sheet">
	<label text="DISCARD PROGRESS" class="sheet-title" />
	<label
		text="This permanently removes saved progress for this puzzle."
		class="sheet-text"
		textWrap="true"
	/>
	{#if error}
		<label text={error} class="sheet-error" textWrap="true" />
	{/if}
	<button text="DISCARD" class="sheet-danger" on:tap={onConfirm} />
	<button text="CANCEL" class="library-button" on:tap={onCancel} />
</stackLayout>
