import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PlayerAccessPanel from './PlayerAccessPanel.svelte';
import type { PlayerAllowlistEntry } from '$lib/types/puzzle';
import {
	ApiError,
	addPlayerAllowlistEntry,
	fetchPlayerAllowlist,
	removePlayerAllowlistEntry
} from '$lib/services/api';

vi.mock('$lib/services/api', () => {
	class MockApiError extends Error {
		constructor(
			public status: number,
			public error: string,
			message: string
		) {
			super(message);
			this.name = 'ApiError';
		}
	}
	return {
		fetchPlayerAllowlist: vi.fn().mockResolvedValue([]),
		addPlayerAllowlistEntry: vi.fn(),
		removePlayerAllowlistEntry: vi.fn(),
		ApiError: MockApiError
	};
});

const mockAllowlist: PlayerAllowlistEntry[] = [
	{
		email: 'linked@example.com',
		createdAt: 1,
		addedBy: 'admin',
		player: {
			id: 'player-1',
			email: 'linked@example.com',
			name: 'Linked Player',
			createdAt: 1,
			lastLoginAt: 2
		}
	},
	{
		email: 'pending@example.com',
		createdAt: 2,
		addedBy: 'admin'
	}
];

describe('PlayerAccessPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchPlayerAllowlist).mockResolvedValue([]);
	});

	it('lists player allowlist entries with linked player metadata', async () => {
		vi.mocked(fetchPlayerAllowlist).mockResolvedValue(mockAllowlist);

		render(PlayerAccessPanel);

		await expect.element(page.getByText('linked@example.com')).toBeVisible();
		await expect.element(page.getByText('Linked Player')).toBeVisible();
		await expect.element(page.getByText('pending@example.com')).toBeVisible();
		await expect.element(page.getByText('No account created')).toBeVisible();
	});

	it('shows an API error when loading player access fails', async () => {
		vi.mocked(fetchPlayerAllowlist).mockRejectedValue(
			new ApiError(500, 'internal_error', 'Player access unavailable')
		);

		render(PlayerAccessPanel);

		await expect.element(page.getByText('Player access unavailable')).toBeVisible();
		await expect.element(page.getByText('No players allowlisted.')).toBeVisible();
	});

	it('adds a player allowlist email through the form', async () => {
		vi.mocked(addPlayerAllowlistEntry).mockResolvedValue({
			email: 'new@example.com',
			createdAt: 3,
			addedBy: 'admin'
		});

		render(PlayerAccessPanel);

		await page.getByLabelText('Player email').fill('new@example.com');
		await page.getByRole('button', { name: /add player/i }).click();

		await vi.waitFor(() => {
			expect(addPlayerAllowlistEntry).toHaveBeenCalledWith('new@example.com');
		});
	});

	it('shows an API error when adding a player fails', async () => {
		vi.mocked(addPlayerAllowlistEntry).mockRejectedValue(
			new ApiError(409, 'already_allowed', 'Player already allowed')
		);

		render(PlayerAccessPanel);

		await page.getByLabelText('Player email').fill('new@example.com');
		await page.getByRole('button', { name: /add player/i }).click();

		await expect.element(page.getByText('Player already allowed')).toBeVisible();
	});

	it('removes a player allowlist email', async () => {
		vi.mocked(fetchPlayerAllowlist).mockResolvedValue(mockAllowlist);
		vi.mocked(removePlayerAllowlistEntry).mockResolvedValue(undefined);

		render(PlayerAccessPanel);

		await expect.element(page.getByText('linked@example.com')).toBeVisible();
		await page.getByRole('button', { name: 'REMOVE' }).first().click();

		await vi.waitFor(() => {
			expect(removePlayerAllowlistEntry).toHaveBeenCalledWith('linked@example.com');
		});
	});

	it('shows an API error when removing a player fails', async () => {
		vi.mocked(fetchPlayerAllowlist).mockResolvedValue(mockAllowlist);
		vi.mocked(removePlayerAllowlistEntry).mockRejectedValue(
			new ApiError(500, 'internal_error', 'Could not remove player')
		);

		render(PlayerAccessPanel);

		await expect.element(page.getByText('linked@example.com')).toBeVisible();
		await page.getByRole('button', { name: 'REMOVE' }).first().click();

		await expect.element(page.getByText('Could not remove player')).toBeVisible();
	});

	it('ignores stale allowlist responses after a newer request is made', async () => {
		let resolveFirst: (value: PlayerAllowlistEntry[]) => void;
		const firstPromise = new Promise<PlayerAllowlistEntry[]>((resolve) => {
			resolveFirst = resolve;
		});
		const secondResponse: PlayerAllowlistEntry[] = [
			{ email: 'fresh@example.com', createdAt: 3, addedBy: 'admin' }
		];

		vi.mocked(fetchPlayerAllowlist)
			.mockImplementationOnce(() => firstPromise)
			.mockResolvedValueOnce(secondResponse);

		render(PlayerAccessPanel);

		// Wait for the first loadAllowlist to start.
		await vi.waitFor(() => {
			expect(fetchPlayerAllowlist).toHaveBeenCalledTimes(1);
		});

		// Trigger a second loadAllowlist via form submission before first resolves.
		vi.mocked(addPlayerAllowlistEntry).mockResolvedValue({
			email: 'triggered@example.com',
			createdAt: 4,
			addedBy: 'admin'
		});
		await page.getByLabelText('Player email').fill('triggered@example.com');
		await page.getByRole('button', { name: /add player/i }).click();

		await vi.waitFor(() => {
			expect(fetchPlayerAllowlist).toHaveBeenCalledTimes(2);
		});

		// Resolve the first response after the newer response has updated the UI.
		resolveFirst!([{ email: 'stale@example.com', createdAt: 1, addedBy: 'admin' }]);

		await expect.element(page.getByText('fresh@example.com')).toBeVisible();
		await expect.poll(() => page.getByText('stale@example.com').query()).toBeNull();
	});
});
