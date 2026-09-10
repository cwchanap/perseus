<script lang="ts">
	interface Props {
		value: string;
		onInput: (value: string) => void;
	}

	let { value, onInput }: Props = $props();
</script>

<div class="search-control">
	<div class="search-icon" aria-hidden="true">
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
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
		class="search-input"
	/>
</div>

<style>
	.search-control {
		position: relative;
		width: 100%;
	}

	.search-icon {
		pointer-events: none;
		position: absolute;
		inset: 0 auto 0 1rem;
		display: flex;
		width: 1.2rem;
		align-items: center;
		color: var(--text-2);
	}

	.search-icon svg {
		width: 1.2rem;
		height: 1.2rem;
		stroke-width: 2.2;
	}

	.search-input {
		width: 100%;
		height: 2.75rem;
		box-sizing: border-box;
		border: 1px solid var(--border-bright);
		border-radius: 1.25rem;
		background: rgba(28, 20, 64, 0.85);
		padding: 0.625rem 1rem 0.625rem 3rem;
		color: var(--text-1);
		font-family: var(--font-body);
		font-size: 0.95rem;
		font-weight: 600;
		letter-spacing: 0.03em;
		outline: none;
		transition:
			border-color 0.15s ease,
			box-shadow 0.15s ease;
	}

	.search-input::placeholder {
		color: var(--text-1);
		opacity: 0.8;
	}

	.search-input:focus {
		border-color: var(--accent);
		box-shadow: 0 0 15px var(--accent-glow);
	}

	@media (min-width: 64.01rem) and (max-width: 75rem) {
		.search-input {
			width: 2.625rem;
			height: 2.625rem;
			padding: 0;
			border-radius: 0.875rem;
			color: transparent;
			font-size: 0;
		}

		.search-input::placeholder {
			color: transparent;
		}

		.search-icon {
			inset: 0;
			width: 100%;
			justify-content: center;
		}

		.search-input:focus {
			width: 100%;
			padding: 0.625rem 1rem 0.625rem 3rem;
			color: var(--text-1);
			font-size: 0.95rem;
		}

		.search-input:focus::placeholder {
			color: var(--text-1);
			opacity: 0.8;
		}

		.search-control:has(.search-input:focus) .search-icon {
			inset: 0 auto 0 1rem;
			width: 1.2rem;
			justify-content: flex-start;
		}
	}

	@media (max-width: 39.999rem) {
		.search-input {
			height: 2.625rem;
		}
	}
</style>
