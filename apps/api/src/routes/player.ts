import { Hono } from 'hono';
import { mkdir, writeFile, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { getDb } from '../db';
import {
	getProfileOverride,
	updateProfileDisplayName,
	updateProfileAvatarUrl,
	clearProfileAvatarUrl,
	getPlayerSummary,
	listPlayerPuzzles,
	listPlayerStats,
	sniffImageType,
	parseImageDimensions
} from '@perseus/shared';
import type { PlayerProfile, PlayerPuzzleSummary, PlayerStatRow } from '@perseus/types';
import {
	coercePuzzleStatus,
	isPlayerProfile,
	isPlayerPuzzleSummary,
	isPlayerStatRow
} from '@perseus/types';
import { requirePlayerAuth } from '../middleware/player-auth';
import { avatarRateLimit, resetAvatarAttempts } from '../middleware/rate-limit';
import type { PlayerSessionRecord } from '../services/player-auth';

const player = new Hono<{ Variables: { playerSession: PlayerSessionRecord } }>();

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Matches the puzzle-name cap (admin routes). Bounds storage and prevents
// trivially large payloads from reaching D1.
const MAX_DISPLAY_NAME_LENGTH = 255;

player.get('/profile', requirePlayerAuth, async (c) => {
	const db = getDb();
	const session = c.get('playerSession');
	const playerId = session.user.id;
	// Independent reads — run concurrently to cut profile latency. Both hit
	// the DB; awaiting sequentially would serialize two round-trips.
	const [override, summary] = await Promise.all([
		getProfileOverride(db, playerId),
		getPlayerSummary(db, playerId)
	]);

	const profile: PlayerProfile = {
		id: session.user.id,
		email: session.user.email,
		name: override?.displayName ?? session.user.name ?? session.user.email,
		picture: override?.avatarUrl ?? session.user.picture ?? null,
		createdAt: session.user.createdAt,
		lastLoginAt: session.user.lastLoginAt,
		summary
	};
	// Defense-in-depth: the profile is assembled from typed sources (session +
	// repository), but validate the final shape so a schema/contract drift
	// surfaces as a 500 rather than silently serving malformed data.
	if (!isPlayerProfile(profile)) {
		console.error(`Profile response failed validation for player ${playerId}`);
		return c.json({ error: 'internal_error', message: 'Failed to build profile' }, 500);
	}
	return c.json(profile);
});

player.patch('/profile', requirePlayerAuth, async (c) => {
	const db = getDb();
	const session = c.get('playerSession');
	const playerId = session.user.id;
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
	}
	const raw =
		body && typeof body === 'object' && 'displayName' in body
			? (body as { displayName: unknown }).displayName
			: undefined;
	// displayName is required: a missing field is a client error, not a silent
	// reset to null. null explicitly clears the override back to the Google name.
	if (raw === undefined) {
		return c.json({ error: 'bad_request', message: 'displayName is required' }, 400);
	}
	if (raw !== null && typeof raw !== 'string') {
		return c.json({ error: 'bad_request', message: 'displayName must be a string or null' }, 400);
	}
	// Trim surrounding whitespace and reject empty/blank values so a profile
	// name can never be set to nothing (mirrors puzzle-name handling). null is
	// unaffected and still clears the override back to the Google name.
	let displayName = raw;
	if (typeof displayName === 'string') {
		displayName = displayName.trim();
		if (displayName === '') {
			return c.json({ error: 'bad_request', message: 'displayName must not be empty' }, 400);
		}
		if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
			return c.json(
				{ error: 'bad_request', message: 'displayName must be 255 characters or fewer' },
				400
			);
		}
	}
	// Field-specific update writes only displayName and preserves avatarUrl,
	// avoiding a read-modify-write race with concurrent POST /avatar requests.
	await updateProfileDisplayName(db, playerId, displayName);
	return c.json({ ok: true });
});

// Upload the authenticated player's avatar to the filesystem and record its
// serving path in the profile override (writes only avatarUrl; displayName is
// preserved by the field-specific repository update).
player.post('/avatar', requirePlayerAuth, avatarRateLimit, async (c) => {
	const session = c.get('playerSession');
	const playerId = session.user.id;
	let formData: FormData;
	try {
		formData = await c.req.formData();
	} catch {
		return c.json({ error: 'bad_request', message: 'Invalid form data' }, 400);
	}
	const file = formData.get('avatar');
	if (!(file instanceof File)) {
		return c.json({ error: 'bad_request', message: 'avatar file is required' }, 400);
	}
	if (file.size > AVATAR_MAX_BYTES) {
		return c.json({ error: 'bad_request', message: 'Avatar must be 5MB or less' }, 400);
	}
	// Validate via magic bytes instead of trusting file.type, matching the
	// puzzle upload path. The sniffed type is also what we store so the
	// extension-less serve route returns the correct Content-Type without
	// re-sniffing (though it still sniffs defensively).
	const bytes = new Uint8Array(await file.arrayBuffer());
	const detected = sniffImageType(bytes);
	if (!detected || !AVATAR_MIME.has(detected)) {
		return c.json({ error: 'bad_request', message: 'Unsupported image type' }, 400);
	}
	// Validate the image is not truncated/corrupted by parsing its dimensions.
	// sniffImageType only checks magic bytes (4 for JPEG, 8 for PNG, 12 for
	// WebP), so a file with just a valid header prefix but no image data would
	// pass the type check. parseImageDimensions returns null for truncated or
	// malformed headers, rejecting incomplete uploads before they reach disk.
	const dimensions = await parseImageDimensions(file, detected);
	if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
		return c.json({ error: 'bad_request', message: 'Image is corrupted or truncated' }, 400);
	}
	const dataDir = process.env.DATA_DIR || './data';
	const dir = join(dataDir, 'avatars');
	const avatarPath = join(dir, playerId);
	await mkdir(dir, { recursive: true });
	// Write to a unique staging file first, then promote to the live path
	// via atomic rename only after the DB override write succeeds. This
	// avoids two problems:
	//  1. Orphaned bytes: writing directly to the live path before the DB
	//     write would leave a publicly-reachable file at a predictable URL
	//     even when the request returns 500 (the serve route is public and
	//     reads the path without checking the DB).
	//  2. TOCTOU on rollback: a blind rm of the live file after a DB failure
	//     could remove a concurrent upload's file. The staging file is unique
	//     to this upload, so deleting it on failure is always safe.
	const stagingPath = join(dir, `.staging-${playerId}-${crypto.randomUUID()}`);
	await writeFile(stagingPath, Buffer.from(bytes));

	const db = getDb();
	// Field-specific update writes only avatarUrl and preserves displayName,
	// avoiding a read-modify-write race with concurrent PATCH /profile requests.
	try {
		await updateProfileAvatarUrl(db, playerId, `/api/player/${playerId}/avatar`);
	} catch (err) {
		console.error('Avatar DB write failed; cleaning up staged avatar file:', err);
		// Safe to delete unconditionally: stagingPath is unique to this upload.
		// No concurrent upload can write to or claim this file.
		await unlink(stagingPath).catch(() => {});
		return c.json({ error: 'internal_error', message: 'Failed to update avatar' }, 500);
	}
	// DB succeeded — promote the staged file to the live path. rename is
	// atomic on the same filesystem (staging file is in the same directory).
	// A concurrent upload may also rename its staging file here; last rename
	// wins (both are valid avatars). If the rename itself fails (e.g. cross-
	// filesystem, disk error), roll back the DB write so the profile doesn't
	// point at a missing file, and delete the orphaned staging file.
	try {
		await rename(stagingPath, avatarPath);
	} catch (err) {
		console.error('Avatar promotion rename failed; rolling back DB and staging file:', err);
		await unlink(stagingPath).catch(() => {});
		await clearProfileAvatarUrl(db, playerId).catch((rollbackErr) =>
			console.error('Failed to clear avatar URL after rename failure:', rollbackErr)
		);
		return c.json({ error: 'internal_error', message: 'Failed to store avatar' }, 500);
	}
	// Reset the rate-limit counter on success so repeated successful uploads
	// don't accumulate toward an unnecessary lockout. The middleware increments
	// before the handler runs; this deletes that increment.
	resetAvatarAttempts(c);
	return c.json({ avatarUrl: `/api/player/${playerId}/avatar` });
});

// Serve a player's avatar. Public (no auth) so avatars render anywhere.
player.get('/:playerId/avatar', async (c) => {
	const playerId = c.req.param('playerId');
	const dataDir = process.env.DATA_DIR || './data';
	const dir = join(dataDir, 'avatars');
	const filePath = join(dir, playerId);
	// Guard against path traversal: the resolved path must stay inside the
	// avatars directory (playerId comes from an untrusted URL segment).
	if (!filePath.startsWith(dir + '/') && filePath !== dir) {
		return c.json({ error: 'bad_request', message: 'Invalid player id' }, 400);
	}
	let buf: Buffer;
	try {
		buf = await readFile(filePath);
	} catch {
		return c.json({ error: 'not_found', message: 'Avatar not found' }, 404);
	}
	const mime = sniffImageType(new Uint8Array(buf)) ?? 'application/octet-stream';
	return new Response(buf, {
		headers: {
			'Content-Type': mime,
			// Defense-in-depth: the bytes are sniffed and typed, but nosniff
			// prevents a browser from second-guessing and executing a disguised
			// payload as a different content type.
			'X-Content-Type-Options': 'nosniff'
		}
	});
});

player.get('/puzzles', requirePlayerAuth, async (c) => {
	const db = getDb();
	const session = c.get('playerSession');
	const limit = Number(c.req.query('limit') ?? '20');
	const cursor = c.req.query('cursor') || undefined;
	const { rows, nextCursor } = await listPlayerPuzzles(db, session.user.id, {
		limit: Number.isFinite(limit) ? limit : 20,
		cursor
	});
	// Project DB rows to the public PlayerPuzzleSummary contract, stripping
	// internal columns (e.g. ownerId) that the client doesn't need.
	const puzzles: PlayerPuzzleSummary[] = rows.map((r) => ({
		id: r.id,
		name: r.name,
		pieceCount: r.pieceCount,
		status: coercePuzzleStatus(r.status),
		createdAt: r.createdAt,
		...(r.category ? { category: r.category } : {})
	}));
	// Validate each projected row so a schema/contract drift surfaces as a 500
	// rather than silently serving malformed data to the client.
	if (!puzzles.every(isPlayerPuzzleSummary)) {
		console.error(`Player puzzles response failed validation for player ${session.user.id}`);
		return c.json({ error: 'internal_error', message: 'Failed to list puzzles' }, 500);
	}
	return c.json({ puzzles, nextCursor });
});

player.get('/stats', requirePlayerAuth, async (c) => {
	const db = getDb();
	const session = c.get('playerSession');
	const limit = Number(c.req.query('limit') ?? '20');
	const cursor = c.req.query('cursor') || undefined;
	const { rows, nextCursor } = await listPlayerStats(db, session.user.id, {
		limit: Number.isFinite(limit) ? limit : 20,
		...(cursor !== undefined ? { cursor } : {})
	});
	// Project DB rows to the public PlayerStatRow contract, stripping playerId
	// (the client already knows its own ID from the auth session).
	const stats: PlayerStatRow[] = rows.map((r) => ({
		puzzleId: r.puzzleId,
		puzzleName: r.puzzleName,
		bestTimeSeconds: r.bestTimeSeconds,
		totalCompletions: r.totalCompletions,
		firstCompletedAt: r.firstCompletedAt,
		lastCompletedAt: r.lastCompletedAt
	}));
	// Validate each projected row so a schema/contract drift surfaces as a 500
	// rather than silently serving malformed data to the client.
	if (!stats.every(isPlayerStatRow)) {
		console.error(`Player stats response failed validation for player ${session.user.id}`);
		return c.json({ error: 'internal_error', message: 'Failed to list stats' }, 500);
	}
	return c.json({ stats, nextCursor });
});

export default player;
