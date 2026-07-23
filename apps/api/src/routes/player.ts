import { Hono } from 'hono';
import { mkdir, writeFile, readFile, unlink, lstat, rename, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getDb } from '../db';
import {
	getProfileOverride,
	updateProfileDisplayName,
	updateProfileAvatarUrl,
	getPlayerSummary,
	listPlayerPuzzles,
	listPlayerStats,
	sniffImageType,
	parseImageDimensions,
	validateImageEndMarker
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
// Cap avatar dimensions well above the 64x64 display size (retina-safe at 8x)
// but reject pathologically large images that would burn client render budget
// and disk storage. The puzzle path enforces MAX_IMAGE_DIMENSION (4096) in the
// workflow; avatars have no server-side processing step, so the cap lives here.
const MAX_AVATAR_DIMENSION = 512;
// Matches the puzzle-name cap (admin routes). Bounds storage and prevents
// trivially large payloads from reaching D1.
const MAX_DISPLAY_NAME_LENGTH = 255;

/**
 * Roll back a partially-applied legacy-avatar migration. Removes the
 * versioned file (and the now-empty versioned directory when this upload
 * created it via the legacy migration), then restores the legacy backup
 * file to its original path so the serve route's legacy fallback resolves
 * again. All filesystem operations are best-effort — this is a recovery
 * path, and a partial rollback still leaves D1 pointing at the legacy
 * path (the DB write did not succeed), which is correct as long as the
 * legacy file is restored.
 */
async function rollbackLegacyMigration(
	playerDir: string,
	versionedPath: string,
	legacyBackupPath: string,
	migratedLegacy: boolean
): Promise<void> {
	await unlink(versionedPath).catch(() => {});
	if (migratedLegacy) {
		// The versioned directory was created by this upload (the legacy
		// file previously occupied the path). Remove it so the backup can
		// be renamed back to the original path.
		await rmdir(playerDir).catch(() => {});
		await rename(legacyBackupPath, playerDir).catch((err) => {
			console.error('Failed to restore legacy avatar backup:', err);
		});
	}
}

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
	if (dimensions.width > MAX_AVATAR_DIMENSION || dimensions.height > MAX_AVATAR_DIMENSION) {
		return c.json(
			{
				error: 'bad_request',
				message: `Avatar dimensions must be ${MAX_AVATAR_DIMENSION}px or less in each axis`
			},
			400
		);
	}
	// Validate the image is structurally complete by checking for the format's
	// end marker (IEND for PNG, EOI for JPEG, RIFF size for WebP).
	// parseImageDimensions only validates the header; without this check a
	// file with a valid header but missing body/trailer would pass and be
	// stored as a corrupt avatar that renders broken for the player.
	const hasEndMarker = await validateImageEndMarker(file, detected);
	if (!hasEndMarker) {
		return c.json({ error: 'bad_request', message: 'Image is corrupted or truncated' }, 400);
	}
	const dataDir = process.env.DATA_DIR || './data';
	const playerDir = join(dataDir, 'avatars', playerId);
	// Migrate the legacy unversioned avatar (a FILE at avatars/{playerId})
	// to the versioned directory layout transactionally. Renaming the legacy
	// file to a backup path BEFORE creating the versioned directory and
	// committing the token to D1 means a failure anywhere in the migration
	// (mkdir, writeFile, or the D1 update) can roll back to the previous
	// serving state: D1 still points at the legacy path, and the restored
	// legacy file makes the serve route's legacy fallback resolve again.
	// Deleting the legacy file up-front (the previous approach) left a
	// window where D1 pointed at a path whose file was gone, producing a
	// 404 until a successful retry. This only affects local dev (Bun
	// runtime); production uses R2 where object and directory keys don't
	// conflict.
	const legacyBackupPath = join(dataDir, 'avatars', `${playerId}.legacy-backup`);
	let migratedLegacy = false;
	try {
		const stat = await lstat(playerDir);
		if (stat.isFile()) {
			await rename(playerDir, legacyBackupPath);
			migratedLegacy = true;
		}
	} catch {
		// Path doesn't exist — no legacy file to back up. Any other error
		// surfaces on the mkdir call below.
	}
	// Write to a versioned file path (avatars/{playerId}/{token}) instead of
	// a fixed path (avatars/{playerId}). This eliminates the concurrent-upload
	// race where two uploads both rename to the same fixed path and the last
	// rename wins regardless of which D1 row is authoritative. With versioned
	// paths, each upload writes to a unique file, and D1's avatarUpdateToken
	// selects which version the serve route reads. Mirrors the Worker route's
	// versioned R2 key design (player.worker.ts). Superseded files
	// (avatars/{playerId}/{oldToken}) linger as storage waste but are not
	// reachable by the serve route — they can be cleaned asynchronously.
	const avatarUpdateToken = crypto.randomUUID();
	const versionedPath = join(playerDir, avatarUpdateToken);
	try {
		await mkdir(playerDir, { recursive: true });
		await writeFile(versionedPath, Buffer.from(bytes));
	} catch (writeErr) {
		console.error('Avatar file write failed; rolling back legacy migration:', writeErr);
		await rollbackLegacyMigration(playerDir, versionedPath, legacyBackupPath, migratedLegacy);
		return c.json({ error: 'internal_error', message: 'Failed to store avatar' }, 500);
	}

	const db = getDb();
	// Field-specific update writes only avatarUrl and preserves displayName,
	// avoiding a read-modify-write race with concurrent PATCH /profile requests.
	// The avatarUpdateToken stored here is what the serve route reads to
	// determine which versioned file to serve — D1 is the source of truth
	// for which upload's avatar is currently live.
	const avatarUpdatedAt = Date.now();
	try {
		await updateProfileAvatarUrl(
			db,
			playerId,
			`/api/player/${playerId}/avatar`,
			avatarUpdatedAt,
			avatarUpdateToken
		);
	} catch (err) {
		console.error('Avatar DB write failed; rolling back avatar file:', err);
		await rollbackLegacyMigration(playerDir, versionedPath, legacyBackupPath, migratedLegacy);
		return c.json({ error: 'internal_error', message: 'Failed to update avatar' }, 500);
	}
	// D1 committed — the versioned file is now authoritative. Remove the
	// legacy backup (best-effort; a lingering backup is storage waste, not
	// a correctness issue — D1 points at the versioned path).
	if (migratedLegacy) {
		await unlink(legacyBackupPath).catch(() => {});
	}
	// Reset the rate-limit counter on success so repeated successful uploads
	// don't accumulate toward an unnecessary lockout. The middleware increments
	// before the handler runs; this deletes that increment.
	resetAvatarAttempts(c);
	return c.json({ avatarUrl: `/api/player/${playerId}/avatar` });
});

// Serve a player's avatar from the filesystem. Public (no auth) so avatars
// render anywhere. Reads D1 to determine which versioned file to serve
// (avatars/{playerId}/{token}), so the D1-selected upload's avatar is always
// served regardless of concurrent upload ordering. Falls back to the legacy
// unversioned path (avatars/{playerId}) for avatars uploaded before the
// versioned-path migration. Mirrors the Worker serve route.
player.get('/:playerId/avatar', async (c) => {
	const playerId = c.req.param('playerId');
	const dataDir = process.env.DATA_DIR || './data';
	const avatarsDir = join(dataDir, 'avatars');
	const db = getDb();
	const override = await getProfileOverride(db, playerId);
	// If the override has an avatarUpdateToken, serve from the versioned path.
	// If not (null — pre-migration avatar or no avatar), fall back to the
	// legacy unversioned path for backward compatibility.
	const filePath = override?.avatarUpdateToken
		? join(avatarsDir, playerId, override.avatarUpdateToken)
		: join(avatarsDir, playerId);
	// Guard against path traversal: the resolved path must stay inside the
	// avatars directory (playerId and token come from untrusted sources —
	// playerId from the URL, token from D1 which was written by this route).
	if (!filePath.startsWith(avatarsDir + '/') && filePath !== avatarsDir) {
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
