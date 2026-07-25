/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Concurrent-upload regression test for player.ts (Bun runtime):
 *
 * The versioned avatar path (avatars/{playerId}/{token}) eliminates the
 * last-rename-wins race that existed when both uploads wrote to a fixed
 * path. With versioned paths, each upload writes to a unique file, and
 * D1's avatarUpdateToken selects which version the serve route reads.
 * This test verifies that invariant: two concurrent uploads produce two
 * distinct files, and the serve route returns the bytes matching the
 * D1-selected token — not whichever file happened to be written last.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdtempSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../db', () => ({
	getDb: vi.fn(() => ({}))
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	const store = new Map<
		string,
		{
			displayName: string | null;
			avatarUrl: string | null;
			avatarUpdateToken: string | null;
		}
	>();
	return {
		...actual,
		// Mock validateImageEndMarker so synthetic test images (valid
		// headers but not decodable) pass validation. The real function
		// has dedicated unit tests in packages/shared.
		validateImageEndMarker: vi.fn().mockResolvedValue(true),
		__store: store,
		getProfileOverride: vi.fn((db: unknown, playerId: string) => store.get(playerId) ?? null),
		updateProfileDisplayName: vi.fn((db: unknown, playerId: string, displayName: string | null) => {
			const existing = store.get(playerId) ?? {
				displayName: null,
				avatarUrl: null,
				avatarUpdateToken: null
			};
			store.set(playerId, { ...existing, displayName });
		}),
		updateProfileAvatarUrl: vi.fn(
			(db: unknown, playerId: string, avatarUrl: string, _ts: number, token?: string) => {
				const existing = store.get(playerId) ?? {
					displayName: null,
					avatarUrl: null,
					avatarUpdateToken: null
				};
				store.set(playerId, { ...existing, avatarUrl, avatarUpdateToken: token ?? null });
			}
		),
		getPlayerSummary: vi.fn(() => ({
			puzzlesUploaded: 0,
			puzzlesSolved: 0,
			totalCompletions: 0
		})),
		listPlayerPuzzles: vi.fn(async () => ({ rows: [], nextCursor: undefined })),
		listPlayerStats: vi.fn(async () => ({ rows: [], nextCursor: undefined }))
	};
});

vi.mock('../services/player-auth', () => ({
	getPlayerSession: vi.fn()
}));

import player from '../routes/player';
import * as playerAuth from '../services/player-auth';
import { Hono } from 'hono';
import type { PlayerSessionRecord } from '../services/player-auth';

const TEST_PLAYER: PlayerSessionRecord = {
	user: {
		id: 'p1',
		email: 'p@example.com',
		name: 'Google Name',
		picture: 'g.jpg',
		createdAt: 1,
		lastLoginAt: 2
	},
	sessionHash: 'h',
	createdAt: 1,
	expiresAt: 9999999999999
};

const AUTH_COOKIE = { Cookie: 'perseus_player_session=player-token' };

function buildApp() {
	const app = new Hono();
	app.route('/api/player', player);
	return app;
}

// Minimal valid PNG: 1x1 pixel. Each upload uses a distinct payload so we
// can verify which upload's bytes the serve route returns. We embed a
// distinguishing marker byte at a fixed offset in the IDAT chunk data so
// readFileSync can tell the two apart without parsing PNG structure.
function pngWithMarker(marker: number): number[] {
	return [
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a, // PNG signature
		0x00,
		0x00,
		0x00,
		0x0d, // IHDR length
		0x49,
		0x48,
		0x44,
		0x52, // "IHDR"
		0x00,
		0x00,
		0x00,
		0x01, // width = 1
		0x00,
		0x00,
		0x00,
		0x01, // height = 1
		0x08,
		0x02,
		0x00,
		0x00,
		0x00, // bit depth 8, color type 2, compression 0, filter 0
		0x90,
		0x77,
		0x53,
		0xde, // IHDR CRC
		// IDAT chunk: a minimal 1x1 RGB PNG. The marker byte is embedded
		// in the raw pixel data so two uploads produce different files.
		// Structurally valid: the length matches the 11-byte payload, a
		// 4-byte CRC field follows the data, and IEND is preceded by its
		// zero-length field so chunk-walking validation reaches IEND at
		// the correct offset.
		0x00,
		0x00,
		0x00,
		0x0b, // IDAT length = 11 (matches the 11 payload bytes below)
		0x49,
		0x44,
		0x41,
		0x54, // "IDAT"
		0x08,
		0xd7,
		marker, // distinguishing marker byte
		0x00,
		0xff,
		0x00,
		0x2c,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00, // IDAT CRC (present so chunk-walking advances past IDAT; not verified)
		0x00,
		0x00,
		0x00,
		0x00, // IEND length = 0
		0x49,
		0x45,
		0x4e,
		0x44, // "IEND"
		0xae,
		0x42,
		0x60,
		0x82 // IEND CRC
	];
}

describe('player avatar – concurrent upload regression (Bun)', () => {
	let dataDir: string;
	let originalDataDir: string | undefined;

	beforeEach(() => {
		originalDataDir = process.env.DATA_DIR;
		dataDir = mkdtempSync(join(tmpdir(), 'perseus-player-concurrent-'));
		process.env.DATA_DIR = dataDir;
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(TEST_PLAYER);
	});

	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
		if (originalDataDir === undefined) {
			delete process.env.DATA_DIR;
		} else {
			process.env.DATA_DIR = originalDataDir;
		}
	});

	it('two concurrent uploads write distinct versioned files; serve returns the D1-selected upload', async () => {
		const markerA = 0xaa;
		const markerB = 0xbb;
		const bytesA = pngWithMarker(markerA);
		const bytesB = pngWithMarker(markerB);

		const formA = new FormData();
		formA.append('avatar', new Blob([new Uint8Array(bytesA)], { type: 'image/png' }), 'a.png');
		const formB = new FormData();
		formB.append('avatar', new Blob([new Uint8Array(bytesB)], { type: 'image/png' }), 'b.png');

		// Fire both uploads concurrently — no await between them.
		const app = buildApp();
		const [resA, resB] = await Promise.all([
			app.request('/api/player/avatar', { method: 'POST', headers: AUTH_COOKIE, body: formA }),
			app.request('/api/player/avatar', { method: 'POST', headers: AUTH_COOKIE, body: formB })
		]);

		expect(resA.status).toBe(200);
		expect(resB.status).toBe(200);

		// Both versioned files must exist under avatars/p1/{token}.
		const playerDir = join(dataDir, 'avatars', 'p1');
		expect(existsSync(playerDir)).toBe(true);
		const files = readdirSync(playerDir);
		expect(files).toHaveLength(2);

		// The serve route must return the D1-selected upload's bytes.
		// D1's avatarUpdateToken is set by whichever updateProfileAvatarUrl
		// call landed last — the mock store reflects that. The serve route
		// reads the token from D1 and serves the matching file.
		const serveRes = await app.request('/api/player/p1/avatar');
		expect(serveRes.status).toBe(200);
		const servedBuf = new Uint8Array(await serveRes.arrayBuffer());

		// Determine which upload D1 selected (the mock store's last write).
		const { getProfileOverride } = await import('@perseus/shared');
		const override = await (getProfileOverride as any)({}, 'p1');
		const selectedToken = override.avatarUpdateToken;
		expect(selectedToken).toBeTruthy();

		// Read the D1-selected file directly and verify the serve route
		// returned its bytes. This is the core invariant: D1 is the source
		// of truth, not the filesystem write order.
		const selectedFilePath = join(playerDir, selectedToken);
		const selectedFileBytes = readFileSync(selectedFilePath);
		expect(servedBuf).toEqual(new Uint8Array(selectedFileBytes));

		// The served bytes must contain one of the two markers (proving
		// it's one of the two uploaded avatars, not stale data).
		const hasMarkerA = servedBuf.includes(markerA);
		const hasMarkerB = servedBuf.includes(markerB);
		expect(hasMarkerA || hasMarkerB).toBe(true);
		expect(hasMarkerA && hasMarkerB).toBe(false);
	});
});
