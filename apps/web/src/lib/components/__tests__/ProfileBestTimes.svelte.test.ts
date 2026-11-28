import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import type { PlayerStatRow } from '$lib/types/puzzle';
import { formatTime } from '$lib/stores/timer';
import ProfileBestTimes from '../profile/ProfileBestTimes.svelte';

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$lib/services/api', () => ({
	getFamilyThumbnailUrl: (id: string) => `/api/puzzle-families/${id}/thumbnail`
}));

function row(overrides: Partial<PlayerStatRow> = {}): PlayerStatRow {
	return {
		familyId: 'fam-1',
		familyName: 'Neon Koi Pond',
		difficulty: 'hard',
		standardBestTimeSeconds: 412,
		rotationBestTimeSeconds: 530,
		totalCompletions: 3,
		firstCompletedAt: 1,
		lastCompletedAt: 2,
		...overrides
	};
}

const base = { hasMore: false, loadingMore: false, onLoadMore: () => {} };

describe('ProfileBestTimes', () => {
	it('shows an empty state with a link to play when there are no solves', async () => {
		render(ProfileBestTimes, { ...base, stats: [] });

		await expect.element(page.getByTestId('best-times-empty')).toBeVisible();
		await expect.element(page.getByRole('link', { name: 'Play a puzzle' })).toBeVisible();
	});

	it('labels each best time for screen readers and shows the play count', async () => {
		render(ProfileBestTimes, { ...base, stats: [row()] });

		await expect.element(page.getByText('Neon Koi Pond')).toBeVisible();
		await expect.element(page.getByText('×3')).toBeVisible();
		await expect.element(page.getByText('Standard best')).toBeInTheDocument();
		await expect.element(page.getByText(formatTime(412))).toBeInTheDocument();
		await expect.element(page.getByText('Rotation best')).toBeInTheDocument();
		await expect.element(page.getByText(formatTime(530))).toBeInTheDocument();
	});

	it('falls back to the family id, and handles missing standard or rotation times', async () => {
		render(ProfileBestTimes, {
			...base,
			stats: [
				row({ familyId: 'fam-raw', familyName: null, standardBestTimeSeconds: null }),
				row({ familyId: 'fam-2', familyName: 'Kyoto Alley', rotationBestTimeSeconds: null }),
				row({
					familyId: 'fam-3',
					familyName: 'Desert Bloom',
					standardBestTimeSeconds: null,
					rotationBestTimeSeconds: null
				})
			]
		});

		await expect.element(page.getByText('fam-raw')).toBeVisible();
		await expect.element(page.getByText('Kyoto Alley')).toBeVisible();
		await expect.element(page.getByText('No timed bests')).toBeInTheDocument();
	});

	it('requests more rows and disables the button while loading', async () => {
		const onLoadMore = vi.fn();
		const view = await render(ProfileBestTimes, {
			stats: [row()],
			hasMore: true,
			loadingMore: false,
			onLoadMore
		});

		await userEvent.click(page.getByTestId('load-more-stats'));
		expect(onLoadMore).toHaveBeenCalledTimes(1);

		await view.rerender({ stats: [row()], hasMore: true, loadingMore: true, onLoadMore });
		await expect.element(page.getByTestId('load-more-stats')).toBeDisabled();
		await expect.element(page.getByTestId('load-more-stats')).toHaveTextContent('Loading…');
	});

	it('hides a thumbnail that fails to load', async () => {
		const { container } = await render(ProfileBestTimes, { ...base, stats: [row()] });

		const img = container.querySelector('img') as HTMLImageElement;
		img.dispatchEvent(new Event('error'));

		expect(img.style.visibility).toBe('hidden');
	});
});
