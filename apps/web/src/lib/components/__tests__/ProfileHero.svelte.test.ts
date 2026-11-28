import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import type { PlayerProfile } from '$lib/types/puzzle';
import ProfileHero from '../profile/ProfileHero.svelte';

const profile: PlayerProfile = {
	id: 'p1',
	email: 'nova.player@example.com',
	name: 'Nova Starling',
	picture: null,
	createdAt: Date.UTC(2026, 6, 31),
	lastLoginAt: Date.now() - 2 * 3_600_000,
	summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
};

function props(overrides: Record<string, unknown> = {}) {
	return {
		profile,
		score: 2650,
		rank: 7,
		editing: false,
		displayName: profile.name,
		saving: false,
		saveError: null,
		onEdit: vi.fn(),
		onCancel: vi.fn(),
		onSave: vi.fn(),
		onReset: vi.fn(),
		onAvatarChosen: vi.fn(),
		...overrides
	};
}

describe('ProfileHero', () => {
	it('shows identity, score, rank and an edit button', async () => {
		const p = props();
		render(ProfileHero, p);

		await expect.element(page.getByTestId('profile-name')).toHaveTextContent('Nova Starling');
		await expect.element(page.getByText('nova.player@example.com')).toBeVisible();
		await expect.element(page.getByTestId('profile-progression-score')).toHaveTextContent('2,650');
		await expect.element(page.getByTestId('profile-progression-rank')).toHaveTextContent('7');
		await expect
			.element(page.getByTestId('profile-last-login'))
			.toHaveTextContent('Last seen 2 hours ago');

		await userEvent.click(page.getByRole('button', { name: 'Edit profile' }));
		expect(p.onEdit).toHaveBeenCalledTimes(1);
	});

	it('shows the avatar picture when there is one and a dash when unranked', async () => {
		render(ProfileHero, props({ profile: { ...profile, picture: '/avatar.png' }, rank: null }));

		await expect.element(page.getByRole('img', { name: 'Nova Starling' })).toBeVisible();
		await expect.element(page.getByTestId('profile-progression-rank')).toHaveTextContent('—');
	});

	it('edits the name with save, cancel and reset actions and shows save errors', async () => {
		const p = props({ editing: true, saveError: 'Could not save' });
		render(ProfileHero, p);

		await expect.element(page.getByTestId('display-name-input')).toBeVisible();
		await expect
			.element(page.getByTestId('profile-save-error'))
			.toHaveTextContent('Could not save');

		await userEvent.click(page.getByRole('button', { name: 'Save' }));
		expect(p.onSave).toHaveBeenCalledTimes(1);
		await userEvent.click(page.getByRole('button', { name: 'Cancel' }));
		expect(p.onCancel).toHaveBeenCalledTimes(1);
		await userEvent.click(page.getByTestId('reset-name'));
		expect(p.onReset).toHaveBeenCalledTimes(1);
	});

	it('reports a chosen avatar file', async () => {
		const p = props({ editing: true });
		render(ProfileHero, p);

		await userEvent.upload(
			page.getByTestId('avatar-input'),
			new File(['x'], 'avatar.png', { type: 'image/png' })
		);
		expect(p.onAvatarChosen).toHaveBeenCalledTimes(1);
	});
});
