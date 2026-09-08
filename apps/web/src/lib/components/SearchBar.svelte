<script lang="ts">
	interface Props {
		value: string;
		onInput: (value: string) => void;
	}

	let { value, onInput }: Props = $props();
</script>

<div class="relative w-full">
	<div class="pointer-events-none absolute inset-y-0 left-4 flex items-center" aria-hidden="true">
		<svg class="h-4 w-4 text-(--text-2)" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width="2"
				d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
			/>
		</svg>
	</div>
	<input
		type="search"
		{value}
		oninput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
		placeholder="SEARCH MISSIONS..."
		aria-label="Search puzzles"
		data-testid="search-input"
		class="w-full rounded-[20px] border border-(--border-bright) bg-[rgba(28,20,64,0.85)] py-2.5 pr-4 pl-11
		text-[0.78rem] font-(--font-body) font-semibold tracking-[0.05em] text-(--text-1)
		transition-[border-color,box-shadow] duration-150
		placeholder:text-(--text-2) placeholder:opacity-80
		focus:border-(--accent) focus:[box-shadow:0_0_15px_var(--accent-glow)]
		focus:outline-none"
	/>
</div>
