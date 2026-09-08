<script lang="ts">
	import type { PuzzleCategory } from '$lib/constants/categories';

	interface Props {
		category: PuzzleCategory | undefined;
		showLabel?: boolean;
		compact?: boolean;
	}

	interface CategoryIcon {
		name: string;
		path: string;
		accent: string;
	}

	const categoryIcons: Record<PuzzleCategory, CategoryIcon> = {
		Animals: {
			name: 'paw',
			path: 'M6 8.5a2.5 2.5 0 115 0 2.5 2.5 0 01-5 0zm7-3a2 2 0 114 0 2 2 0 01-4 0zM4.5 15a2 2 0 114 0 2 2 0 01-4 0zm11.5-1.5a2.5 2.5 0 115 0 2.5 2.5 0 01-5 0zM9 19a3 3 0 106 0c0-1.7-1.3-2.5-3-2.5S9 17.3 9 19z',
			accent: '#ffcc00'
		},
		Nature: {
			name: 'leaf',
			path: 'M12 21s-1-8 3-12c2.7-2.7 6-2.4 6-2.4s.4 3.6-2.3 6.3C15.4 16 12 21 12 21zM7.5 21S4 17 4 13c0-2.6 1.6-4.3 1.6-4.3S8 10.2 8.6 13c.5 2.3-1.1 8-1.1 8z',
			accent: '#8be48b'
		},
		Art: {
			name: 'art',
			path: 'M12 2l1.6 4.4L18 8l-4.4 1.6L12 14l-1.6-4.4L6 8l4.4-1.6zM18 14l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z',
			accent: '#ff5cc0'
		},
		Architecture: {
			name: 'building',
			path: 'M4 20V9l8-5 8 5v11h-6v-6H10v6z',
			accent: '#a8c8ff'
		},
		Abstract: {
			name: 'abstract',
			path: 'M12 2l8 5-8 5-8-5 8-5zm0 7l8 5-8 5-8-5 8-5zm0 7l5 3-5 3-5-3 5-3z',
			accent: '#b6a6ff'
		},
		Food: {
			name: 'food',
			path: 'M4 4v7m3-7v7m-1.5-7v17M4 11h3M15 4v17m0-17c3 1.4 4 4.5 4 7h-4',
			accent: '#ffd28b'
		},
		Travel: {
			name: 'compass',
			path: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 3.5c1.9 0 3.5 1.6 3.5 3.5S13.9 13.5 12 13.5 8.5 11.9 8.5 10 10.1 6.5 12 6.5z',
			accent: '#8bd8ff'
		}
	};

	let { category, showLabel = true, compact = false }: Props = $props();
	const icon = $derived(category ? categoryIcons[category] : undefined);
</script>

{#if category && icon}
	<span
		class={compact
			? 'inline-flex items-center justify-center text-(--category-accent)'
			: 'inline-flex items-center gap-1.5 border border-(--category-accent) bg-[rgba(4,4,13,0.8)] px-2 py-[0.2rem] text-[0.58rem] font-(--font-mono) tracking-[0.18em] text-(--category-accent) uppercase backdrop-blur-[4px]'}
		aria-label={category}
		data-testid="category-badge"
		data-category-icon={icon.name}
		style={`--category-accent: ${icon.accent}`}
	>
		<svg
			class="h-4 w-4 shrink-0"
			viewBox="0 0 24 24"
			fill="currentColor"
			stroke={icon.name === 'food' ? 'currentColor' : undefined}
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width={icon.name === 'food' ? 1.6 : undefined}
			aria-hidden="true"
		>
			<path d={icon.path} />
		</svg>
		{#if showLabel && !compact}
			<span>{category}</span>
		{:else}
			<span class="sr-only">{category}</span>
		{/if}
	</span>
{/if}
