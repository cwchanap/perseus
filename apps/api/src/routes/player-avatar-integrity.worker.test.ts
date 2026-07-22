/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db.worker', () => ({
	getWorkerDb: vi.fn(() => ({}))
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

vi.mock('../services/player-auth.worker', () => ({
	getPlayerSession: vi.fn()
}));

import player from '../routes/player.worker';
import type { Env } from '../worker';
import * as playerAuth from '../services/player-auth.worker';
import { parseImageDimensions, validateImageEndMarker } from '@perseus/shared';

const TEST_PLAYER = {
	user: {
		id: 'p1',
		email: 'p@example.com',
		name: 'Player',
		picture: 'g.jpg',
		createdAt: 1,
		lastLoginAt: 2
	},
	sessionHash: 'hash',
	createdAt: 1,
	expiresAt: 9999999999999
} as any;

const AUTH_COOKIE = { Cookie: 'perseus_player_session=player-token' };
const PNG_PREFIX = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function buildApp() {
	const app = new Hono<{
		Bindings: Env;
		Variables: { playerSession: any };
	}>();
	app.route('/api/player', player);
	return app;
}

function avatarRequest() {
	const form = new FormData();
	form.append('avatar', new Blob([PNG_PREFIX], { type: 'image/png' }), 'avatar.png');
	const env = {
		PUZZLES_BUCKET: { put: vi.fn() }
	} as unknown as Env;
	return buildApp().request(
		'/api/player/avatar',
		{
			method: 'POST',
			headers: AUTH_COOKIE,
			body: form
		},
		env
	);
}

describe('player avatar integrity validation (Worker)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	it('rejects an image whose parsed dimensions are invalid', async () => {
		(parseImageDimensions as any).mockResolvedValue(null);

		const response = await avatarRequest();

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: 'bad_request',
			message: 'Image is corrupted or truncated'
		});
		expect(validateImageEndMarker).not.toHaveBeenCalled();
	});

	it('rejects an image whose end marker is missing', async () => {
		(parseImageDimensions as any).mockResolvedValue({ width: 48, height: 48 });
		(validateImageEndMarker as any).mockResolvedValue(false);

		const response = await avatarRequest();

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: 'bad_request',
			message: 'Image is corrupted or truncated'
		});
		expect(validateImageEndMarker).toHaveBeenCalledOnce();
	});
});
