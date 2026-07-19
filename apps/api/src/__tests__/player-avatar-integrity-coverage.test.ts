/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
	getDb: vi.fn(() => ({}))
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	return {
		...actual,
		getProfileOverride: vi.fn(() => null),
		updateProfileDisplayName: vi.fn(),
		updateProfileAvatarUrl: vi.fn(),
		getPlayerSummary: vi.fn(() => ({
			puzzlesUploaded: 0,
			puzzlesSolved: 0,
			totalCompletions: 0
		})),
		listPlayerPuzzles: vi.fn(async () => ({ rows: [], nextCursor: undefined })),
		listPlayerStats: vi.fn(async () => ({ rows: [], nextCursor: undefined })),
		parseImageDimensions: vi.fn(),
		validateImageEndMarker: vi.fn()
	};
});

vi.mock('../services/player-auth', () => ({
	getPlayerSession: vi.fn()
}));

import player from '../routes/player';
import * as playerAuth from '../services/player-auth';
import type { PlayerSessionRecord } from '../services/player-auth';
import { parseImageDimensions, validateImageEndMarker } from '@perseus/shared';

const TEST_PLAYER: PlayerSessionRecord = {
	user: {
		id: 'p1',
		email: 'p@example.com',
		name: 'Player',
		picture: null,
		createdAt: 1,
		lastLoginAt: 2
	},
	sessionHash: 'hash',
	createdAt: 1,
	expiresAt: 9999999999999
};

const AUTH_COOKIE = { Cookie: 'perseus_player_session=player-token' };
const PNG_PREFIX = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function buildApp() {
	const app = new Hono();
	app.route('/api/player', player);
	return app;
}

function avatarRequest(): Promise<Response> {
	const form = new FormData();
	form.append('avatar', new Blob([PNG_PREFIX], { type: 'image/png' }), 'avatar.png');
	return buildApp().request('/api/player/avatar', {
		method: 'POST',
		headers: AUTH_COOKIE,
		body: form
	});
}

describe('player avatar integrity validation (Bun)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	it('rejects an image whose parsed dimensions are invalid', async () => {
		vi.mocked(parseImageDimensions).mockResolvedValue({ width: 0, height: 48 });

		const response = await avatarRequest();

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: 'bad_request',
			message: 'Image is corrupted or truncated'
		});
		expect(validateImageEndMarker).not.toHaveBeenCalled();
	});

	it('rejects an image whose end marker is missing', async () => {
		vi.mocked(parseImageDimensions).mockResolvedValue({ width: 48, height: 48 });
		vi.mocked(validateImageEndMarker).mockResolvedValue(false);

		const response = await avatarRequest();

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: 'bad_request',
			message: 'Image is corrupted or truncated'
		});
		expect(validateImageEndMarker).toHaveBeenCalledOnce();
	});
});
