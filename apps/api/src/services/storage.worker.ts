// Worker-compatible storage service using KV for metadata and R2 for assets

import type {
	EdgeType,
	EdgeConfig,
	PuzzlePiece,
	PuzzleMetadata,
	PuzzleStatus,
	PuzzleProgress,
	PuzzleSummary,
	PuzzleCategory,
	PuzzleAspectRatio,
	PuzzleFamilyMetadata,
	PuzzleDifficulty
} from '@perseus/types';
import {
	validatePuzzleMetadata,
	validatePuzzleMetadataLight,
	validatePuzzleFamilyMetadata,
	PUZZLE_CATEGORIES,
	PUZZLE_DIFFICULTIES,
	getDifficultyPieceCount,
	getGridDimensionsForAspectRatio
} from '@perseus/types';

// Re-export types so consumers don't need to import from @perseus/types directly
export type {
	EdgeType,
	EdgeConfig,
	PuzzlePiece,
	PuzzleMetadata,
	PuzzleStatus,
	PuzzleProgress,
	PuzzleSummary,
	PuzzleCategory,
	PuzzleAspectRatio,
	PuzzleFamilyMetadata,
	PuzzleDifficulty
};

export { PUZZLE_CATEGORIES };

// KV key helpers
function puzzleKey(id: string): string {
	return `puzzle:${id}`;
}

function familyKey(id: string): string {
	return `family:${id}`;
}

export async function getFamily(
	kv: KVNamespace,
	familyId: string
): Promise<PuzzleFamilyMetadata | null> {
	const data = await kv.get(familyKey(familyId), 'json');
	if (data === null) return null;
	if (!validatePuzzleFamilyMetadata(data)) {
		throw new Error(`Corrupt family metadata for ${familyId}: data exists but fails validation`);
	}
	return data as PuzzleFamilyMetadata;
}

export async function createFamilyMetadata(
	kv: KVNamespace,
	family: PuzzleFamilyMetadata
): Promise<void> {
	if (!family.id || typeof family.id !== 'string' || family.id.trim() === '') {
		throw new Error('Family ID is required and must be a non-empty string');
	}
	if (!family.name || typeof family.name !== 'string' || family.name.trim() === '') {
		throw new Error('Family name is required and must be a non-empty string');
	}
	const existing = await kv.get(familyKey(family.id));
	if (existing !== null) {
		throw new Error(`Family with ID "${family.id}" already exists`);
	}
	if (!validatePuzzleFamilyMetadata(family)) {
		throw new Error('Invalid family metadata structure');
	}
	await kv.put(familyKey(family.id), JSON.stringify(family));
}

export async function deleteFamilyMetadata(
	kv: KVNamespace,
	familyId: string
): Promise<{ success: boolean; error?: Error }> {
	try {
		await kv.delete(familyKey(familyId));
		await invalidateGalleryIndex(kv);
		return { success: true };
	} catch (error) {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		console.error(`Failed to delete family metadata for ${familyId}:`, normalizedError);
		return { success: false, error: normalizedError };
	}
}

export function buildVariantMetadata(params: {
	variantId: string;
	familyId: string;
	difficulty: PuzzleDifficulty;
	name: string;
	aspectRatio: PuzzleAspectRatio;
	category?: PuzzleCategory;
	createdAt: number;
	idempotencyKey?: string;
}): PuzzleMetadata {
	const pieceCount = getDifficultyPieceCount(params.aspectRatio, params.difficulty);
	const { rows, cols } = getGridDimensionsForAspectRatio(pieceCount, params.aspectRatio);
	return {
		id: params.variantId,
		familyId: params.familyId,
		difficulty: params.difficulty,
		name: params.name,
		...(params.category ? { category: params.category } : {}),
		aspectRatio: params.aspectRatio,
		pieceCount,
		gridCols: cols,
		gridRows: rows,
		imageWidth: 0,
		imageHeight: 0,
		createdAt: params.createdAt,
		status: 'processing',
		progress: {
			totalPieces: pieceCount,
			generatedPieces: 0,
			updatedAt: params.createdAt
		},
		pieces: [],
		version: 0,
		...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {})
	};
}

export function buildFamilyMetadata(params: {
	familyId: string;
	name: string;
	aspectRatio: PuzzleAspectRatio;
	createdAt: number;
	variantIds: Record<PuzzleDifficulty, string>;
	category?: PuzzleCategory;
	idempotencyKey?: string;
}): PuzzleFamilyMetadata {
	return {
		id: params.familyId,
		name: params.name,
		aspectRatio: params.aspectRatio,
		createdAt: params.createdAt,
		status: 'processing',
		variants: params.variantIds,
		...(params.category ? { category: params.category } : {}),
		...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {})
	};
}

export async function getPuzzle(kv: KVNamespace, puzzleId: string): Promise<PuzzleMetadata | null> {
	const data = await kv.get(puzzleKey(puzzleId), 'json');
	if (data === null) return null;
	if (!validatePuzzleMetadata(data)) {
		throw new Error(`Corrupt puzzle metadata for ${puzzleId}: data exists but fails validation`);
	}
	return data as PuzzleMetadata;
}

// Create initial puzzle metadata in KV (for processing state)
// NOTE: This function has a TOCTOU (Time-of-Check-Time-of-Use) race condition between the
// existence check (kv.get) and the write (kv.put). For concurrent callers, the same puzzle ID
// may pass the existence check simultaneously, resulting in only one write succeeding (the
// second kv.put will overwrite). To prevent this, callers MUST ensure puzzle IDs are unique
// (e.g., UUIDs generated via crypto.randomUUID()) and pair creation with an idempotency-key
// reservation in PuzzleMetadataDO (see reserveIdempotencyKey) so concurrent retries for the
// same logical upload are serialized.
export async function createPuzzleMetadata(kv: KVNamespace, puzzle: PuzzleMetadata): Promise<void> {
	// Validate required fields
	if (!puzzle.id || typeof puzzle.id !== 'string' || puzzle.id.trim() === '') {
		throw new Error('Puzzle ID is required and must be a non-empty string');
	}
	if (!puzzle.name || typeof puzzle.name !== 'string' || puzzle.name.trim() === '') {
		throw new Error('Puzzle name is required and must be a non-empty string');
	}
	if (typeof puzzle.pieceCount !== 'number' || puzzle.pieceCount <= 0) {
		throw new Error('Puzzle pieceCount is required and must be a positive number');
	}
	if (puzzle.version !== undefined && typeof puzzle.version !== 'number') {
		throw new Error('Puzzle version must be a number if provided');
	}

	// Check if puzzle already exists to prevent accidental overwrites
	// WARNING: This check is non-atomic. See TOCTOU note in function documentation above.
	const existing = await kv.get(puzzleKey(puzzle.id));
	if (existing !== null) {
		throw new Error(`Puzzle with ID "${puzzle.id}" already exists`);
	}

	// Initialize version if not set
	const puzzleWithVersion = { ...puzzle, version: puzzle.version ?? 0 };
	if (!validatePuzzleMetadata(puzzleWithVersion)) {
		throw new Error('Invalid puzzle metadata structure');
	}
	await kv.put(puzzleKey(puzzleWithVersion.id), JSON.stringify(puzzleWithVersion));
}

// Update puzzle metadata via Durable Object for strong consistency
export async function updatePuzzleMetadata(
	metadataDO: DurableObjectNamespace,
	puzzleId: string,
	updates: Partial<PuzzleMetadata>
): Promise<void> {
	const id = metadataDO.idFromName(puzzleId);
	const stub = metadataDO.get(id);
	const response = await stub.fetch('https://puzzle-metadata/update', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ puzzleId, updates })
	});

	if (!response.ok) {
		const payload = (await response.json().catch(() => null)) as { message?: string } | null;
		throw new Error(
			payload?.message ?? `Failed to update puzzle ${puzzleId} (HTTP ${response.status})`
		);
	}
}

/**
 * Read the authoritative puzzle status from the metadata DO's storage.
 * Used by the reaper to verify the DO's status before reaping — a stale KV
 * read showing 'processing' can mask a DO that already committed 'ready'
 * (finalize succeeded but the workflow later errored). Returns the status
 * string on success, null when the DO has no metadata (404 — truly
 * orphaned, safe to reap). Throws on DO errors (500, network) so the
 * caller can distinguish "no metadata" from "DO unreachable" and fail
 * closed (skip reaping) on the latter.
 */
export async function getAuthoritativeStatus(
	metadataDO: DurableObjectNamespace,
	puzzleId: string
): Promise<string | null> {
	const id = metadataDO.idFromName(puzzleId);
	const stub = metadataDO.get(id);
	const response = await stub.fetch('https://puzzle-metadata/status', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ puzzleId })
	});
	if (response.status === 404) {
		return null;
	}
	if (!response.ok) {
		const payload = (await response.json().catch(() => null)) as { message?: string } | null;
		throw new Error(
			payload?.message ??
				`Failed to read authoritative status for ${puzzleId} (HTTP ${response.status})`
		);
	}
	const result = (await response.json()) as { status?: string };
	if (typeof result.status !== 'string') {
		throw new Error(`Authoritative status response missing status field for ${puzzleId}`);
	}
	return result.status;
}

/**
 * Tombstone the metadata DO for a puzzle. Called by the reaper after
 * deleting KV and R2 assets to prevent in-flight workflow updates from
 * resurrecting the puzzle in KV via the DO's KV sync. After this call,
 * the DO's /update endpoint returns 404 (tombstoned).
 */
export async function deleteMetadataDO(
	metadataDO: DurableObjectNamespace,
	puzzleId: string
): Promise<void> {
	const id = metadataDO.idFromName(puzzleId);
	const stub = metadataDO.get(id);
	const response = await stub.fetch('https://puzzle-metadata/delete', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ puzzleId })
	});
	if (!response.ok) {
		const payload = (await response.json().catch(() => null)) as { message?: string } | null;
		throw new Error(
			payload?.message ?? `Failed to delete metadata DO for ${puzzleId} (HTTP ${response.status})`
		);
	}
}

export type IdempotencyReservationStatus = 'pending' | 'committed' | 'failed' | 'released';

/**
 * Reserve an idempotency key via a strongly-consistent Durable Object. The DO
 * instance is keyed by idFromName(idempotencyKey) — separate from the metadata
 * DO instance keyed by idFromName(puzzleId). Returns the existing puzzleId if
 * a prior request already reserved this key, or the proposed puzzleId if this
 * is the first caller.
 *
 * Pair with commitIdempotencyKey on success and failIdempotencyKey /
 * releaseIdempotencyKey on failure so the reservation lifecycle is recoverable.
 */
export async function reserveIdempotencyKey(
	metadataDO: DurableObjectNamespace,
	idempotencyKey: string,
	proposedFamilyId: string
): Promise<{
	existing: boolean;
	familyId: string;
	status?: IdempotencyReservationStatus;
	reservedAt?: number;
}> {
	const id = metadataDO.idFromName(idempotencyKey);
	const stub = metadataDO.get(id);
	const response = await stub.fetch('https://puzzle-metadata/reserve', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ idempotencyKey, familyId: proposedFamilyId })
	});
	if (!response.ok) {
		const payload = (await response.json().catch(() => null)) as { message?: string } | null;
		throw new Error(
			payload?.message ?? `Failed to reserve idempotency key (HTTP ${response.status})`
		);
	}
	const result = (await response.json()) as {
		existing?: boolean;
		familyId?: string;
		puzzleId?: string;
		status?: IdempotencyReservationStatus;
		reservedAt?: number;
	};
	const familyId = result.familyId ?? result.puzzleId;
	if (typeof familyId !== 'string') {
		throw new Error('Reserve response missing familyId');
	}
	return {
		existing: !!result.existing,
		familyId,
		...(result.status ? { status: result.status } : {}),
		...(typeof result.reservedAt === 'number' ? { reservedAt: result.reservedAt } : {})
	};
}

async function transitionIdempotencyKey(
	metadataDO: DurableObjectNamespace,
	idempotencyKey: string,
	familyId: string,
	action: 'commit' | 'fail' | 'release'
): Promise<void> {
	const id = metadataDO.idFromName(idempotencyKey);
	const stub = metadataDO.get(id);
	const response = await stub.fetch(`https://puzzle-metadata/${action}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ familyId })
	});
	// release and fail are cleanup operations — a missing reservation (404) is
	// already in the desired state, so 404 is not an error. commit is not: a 404
	// means the durable key → puzzleId mapping is gone, so the handler would
	// return 201 without idempotency protection. Surface it so the client retries.
	const ignoreMissing = action !== 'commit';
	if (!response.ok && !(ignoreMissing && response.status === 404)) {
		const payload = (await response.json().catch(() => null)) as { message?: string } | null;
		const fallback = `Failed to ${action} idempotency key (HTTP ${response.status})`;
		throw new Error(payload?.message ?? fallback);
	}
}

/** Mark a pending reservation as committed after successful create. */
export async function commitIdempotencyKey(
	metadataDO: DurableObjectNamespace,
	idempotencyKey: string,
	familyId: string
): Promise<void> {
	await transitionIdempotencyKey(metadataDO, idempotencyKey, familyId, 'commit');
}

/** Mark a pending reservation as failed so a later reserve can reclaim the key. */
export async function failIdempotencyKey(
	metadataDO: DurableObjectNamespace,
	idempotencyKey: string,
	familyId: string
): Promise<void> {
	await transitionIdempotencyKey(metadataDO, idempotencyKey, familyId, 'fail');
}

/** Delete a pending reservation (owner-checked) so the key is free immediately. */
export async function releaseIdempotencyKey(
	metadataDO: DurableObjectNamespace,
	idempotencyKey: string,
	familyId: string
): Promise<void> {
	await transitionIdempotencyKey(metadataDO, idempotencyKey, familyId, 'release');
}

/**
 * Read-only lookup of the current reservation owner for an idempotency key.
 * The DO is addressed by idFromName(idempotencyKey), so this returns whatever
 * puzzleId the key currently maps to (pending/committed/failed), or null when
 * no reservation record exists (key was released or never reserved).
 *
 * Used by the reaper's ownership-mismatch reconciliation: a puzzle whose KV
 * metadata carries idempotencyKey K, but whose DO reservation for K now points
 * at a different puzzleId, is a durable orphan — the key was reclaimed by a
 * retry that minted a replacement. This is the signal that survives even when
 * writeCleanupRecord failed and the workflow later completed (the gap neither
 * the stuck-processing reaper nor the cleanup-record reaper can close alone).
 */
export async function getIdempotencyReservation(
	metadataDO: DurableObjectNamespace,
	idempotencyKey: string
): Promise<{ familyId: string; status: string; reservedAt?: number } | null> {
	const id = metadataDO.idFromName(idempotencyKey);
	const stub = metadataDO.get(id);
	const response = await stub.fetch('https://puzzle-metadata/reservation', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({})
	});
	if (!response.ok) {
		const payload = (await response.json().catch(() => null)) as { message?: string } | null;
		throw new Error(
			payload?.message ?? `Failed to read idempotency reservation (HTTP ${response.status})`
		);
	}
	const result = (await response.json().catch(() => null)) as {
		reservation?: { familyId?: string; puzzleId?: string; status?: string; reservedAt?: number };
	} | null;
	const familyId = result?.reservation?.familyId ?? result?.reservation?.puzzleId;
	if (!result?.reservation || typeof familyId !== 'string') {
		return null;
	}
	return {
		familyId,
		status: typeof result.reservation.status === 'string' ? result.reservation.status : 'unknown',
		...(typeof result.reservation.reservedAt === 'number'
			? { reservedAt: result.reservation.reservedAt }
			: {})
	};
}

// Delete puzzle metadata from KV and invalidate gallery index cache
export async function deletePuzzleMetadata(
	kv: KVNamespace,
	puzzleId: string
): Promise<{ success: boolean; error?: Error }> {
	try {
		await kv.delete(puzzleKey(puzzleId));
		await invalidateGalleryIndex(kv);
		return { success: true };
	} catch (error) {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		console.error(`Failed to delete puzzle metadata for ${puzzleId}:`, normalizedError);
		return { success: false, error: normalizedError };
	}
}

// List all puzzles from KV (sorted by createdAt desc)
export async function listPuzzles(
	kv: KVNamespace
): Promise<{ puzzles: PuzzleSummary[]; invalidCount: number }> {
	const keys: { name: string }[] = [];
	let cursor: string | undefined;

	while (true) {
		const list = await kv.list({ prefix: 'puzzle:', cursor });
		keys.push(...list.keys);
		if (list.list_complete) {
			break;
		}
		cursor = list.cursor;
	}

	const fetched = await Promise.all(keys.map((k) => kv.get(k.name, 'json')));
	const nullCount = fetched.filter((p) => p === null).length;
	if (nullCount > 0) {
		console.error(
			`listPuzzles: ${nullCount} keys returned null (data corruption or eventual consistency)`
		);
	}
	let invalidCount = nullCount;
	const puzzles: PuzzleMetadata[] = [];
	fetched.forEach((puzzle, index) => {
		if (puzzle === null) return;
		// Use lightweight validation for listing to avoid O(n*pieces) overhead
		if (!validatePuzzleMetadataLight(puzzle)) {
			invalidCount++;
			console.error(`Invalid puzzle metadata for ${keys[index].name}:`, puzzle);
			return;
		}
		puzzles.push(puzzle);
	});

	if (invalidCount > 0) {
		console.error(`listPuzzles: ${invalidCount} invalid entries out of ${keys.length} total keys`);
	}

	// Sort by createdAt descending, tiebreak on id for deterministic order
	puzzles.sort((a, b) => {
		const dateDiff = b.createdAt - a.createdAt;
		if (dateDiff !== 0) return dateDiff;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});

	// Map to summaries
	return {
		puzzles: puzzles.map((p) => ({
			id: p.id,
			name: p.name,
			pieceCount: p.pieceCount,
			aspectRatio: p.aspectRatio,
			status: p.status,
			progress: p.progress,
			category: p.category,
			createdAt: p.createdAt
		})),
		invalidCount
	};
}

// Cached sorted index for gallery listing — avoids a full KV scan + fan-out on every request.
// The index stores lightweight entries (no pieces array) sorted by createdAt desc and is
// rebuilt from scratch on cache miss. A short TTL means changes propagate within seconds.
const GALLERY_INDEX_KEY = 'gallery:sorted-index';
const GALLERY_INDEX_TTL_SECONDS = 60;

type GalleryIndexEntry = {
	id: string;
	name: string;
	pieceCount: number;
	aspectRatio?: PuzzleAspectRatio;
	status: PuzzleStatus;
	progress?: PuzzleProgress;
	category?: PuzzleCategory;
	createdAt: number;
};

async function buildGalleryIndex(kv: KVNamespace): Promise<GalleryIndexEntry[]> {
	const keys: { name: string }[] = [];
	let cursor: string | undefined;

	while (true) {
		const list = await kv.list({ prefix: 'family:', cursor });
		keys.push(...list.keys);
		if (list.list_complete) break;
		cursor = list.cursor;
	}

	const fetched = await Promise.all(keys.map((k) => kv.get(k.name, 'json')));
	const entries: GalleryIndexEntry[] = [];
	let nullCount = 0;
	let invalidCount = 0;

	fetched.forEach((family) => {
		if (family === null) {
			nullCount++;
			return;
		}
		if (!validatePuzzleFamilyMetadata(family)) {
			invalidCount++;
			return;
		}
		const f = family as PuzzleFamilyMetadata;
		entries.push({
			id: f.id,
			name: f.name,
			pieceCount: getDifficultyPieceCount(f.aspectRatio, 'easy'),
			aspectRatio: f.aspectRatio,
			status: f.status,
			category: f.category,
			createdAt: f.createdAt
		});
	});

	if (nullCount > 0) {
		console.error(
			`buildGalleryIndex: ${nullCount} keys returned null out of ${keys.length} total (data corruption or replication lag)`
		);
	}
	if (invalidCount > 0) {
		console.error(
			`buildGalleryIndex: ${invalidCount} invalid metadata entries out of ${keys.length} total`
		);
	}

	entries.sort((a, b) => {
		const dateDiff = b.createdAt - a.createdAt;
		if (dateDiff !== 0) return dateDiff;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});

	try {
		await kv.put(GALLERY_INDEX_KEY, JSON.stringify(entries), {
			expirationTtl: GALLERY_INDEX_TTL_SECONDS
		});
	} catch (error) {
		// Best-effort: cache write failure should not prevent gallery listing.
		// The next request will rebuild the index from KV data again.
		console.error('Failed to write gallery index cache:', error);
	}

	return entries;
}

async function getGalleryIndex(kv: KVNamespace): Promise<GalleryIndexEntry[]> {
	const cached = await kv.get(GALLERY_INDEX_KEY, 'json');
	if (Array.isArray(cached)) return cached as GalleryIndexEntry[];
	return buildGalleryIndex(kv);
}

// Invalidate the cached gallery index so the next list request rebuilds it from
// current KV data. Call this after any mutation that changes puzzle visibility
// (create, delete, status transition to ready/failed).
export async function invalidateGalleryIndex(kv: KVNamespace): Promise<void> {
	try {
		await kv.delete(GALLERY_INDEX_KEY);
	} catch (error) {
		// Best-effort: a failed delete just means the stale index lives until
		// TTL expiry (60 s). Log but don't propagate.
		console.error('Failed to invalidate gallery index cache:', error);
	}
}

// Cursor type for stable pagination — encodes the sort position of the last
// item in a page so the next page starts right after it, even if items are
// inserted/removed between requests.
type PageCursor = { createdAt: number; id: string };

function encodeCursor(entry: GalleryIndexEntry): string {
	const b64 = btoa(JSON.stringify({ createdAt: entry.createdAt, id: entry.id }));
	// Convert standard Base64 to Base64URL: replace +/ with -_ and strip padding
	return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string): PageCursor | null {
	try {
		// Convert Base64URL back to standard Base64 for atob
		let b64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
		// Restore padding
		const pad = b64.length % 4;
		if (pad === 2) b64 += '==';
		else if (pad === 3) b64 += '=';
		const parsed = JSON.parse(atob(b64)) as PageCursor;
		if (typeof parsed?.createdAt === 'number' && typeof parsed?.id === 'string') {
			return parsed;
		}
		return null;
	} catch {
		return null;
	}
}

// Returns true when `entry` comes strictly after `cursor` in the sorted order
// (createdAt DESC, id ASC).
function isAfterCursor(entry: GalleryIndexEntry, cursor: PageCursor): boolean {
	if (entry.createdAt !== cursor.createdAt) {
		return entry.createdAt < cursor.createdAt;
	}
	return entry.id > cursor.id;
}

export async function listPuzzlesPage(
	kv: KVNamespace,
	params: {
		q?: string;
		category?: PuzzleCategory;
		offset: number;
		limit: number;
		cursor?: string;
	}
): Promise<{
	puzzles: PuzzleSummary[];
	total: number;
	offset: number;
	limit: number;
	nextCursor?: string;
}> {
	const entries = await getGalleryIndex(kv);

	let filtered = entries.filter((p) => p.status === 'ready');

	if (params.category) {
		filtered = filtered.filter((p) => p.category === params.category);
	}

	if (params.q) {
		const q = params.q.toLowerCase();
		filtered = filtered.filter((p) => p.name.toLowerCase().includes(q));
	}

	const total = filtered.length;

	// When a cursor is provided, skip items up to and including the cursor
	// position. This is more stable than offset when items are inserted/removed
	// between pages.
	if (params.cursor) {
		const parsed = decodeCursor(params.cursor);
		if (parsed) {
			const cursorIndex = filtered.findIndex(
				(e) => e.createdAt === parsed.createdAt && e.id === parsed.id
			);
			if (cursorIndex >= 0) {
				filtered = filtered.slice(cursorIndex + 1);
			} else {
				// Cursor item no longer in filtered set (e.g. deleted or changed
				// status). Fall back to returning everything after the cursor's
				// sort position.
				filtered = filtered.filter((e) => isAfterCursor(e, parsed));
			}
		}
		// If cursor is invalid, treat as offset 0
	} else {
		filtered = filtered.slice(params.offset);
	}

	const page = filtered.slice(0, params.limit);

	const summaries = page.map((p) => ({
		id: p.id,
		name: p.name,
		pieceCount: p.pieceCount,
		aspectRatio: p.aspectRatio,
		status: p.status,
		progress: p.progress,
		category: p.category
	}));

	// Attach nextCursor only when more items remain beyond this page
	const nextCursor =
		filtered.length > params.limit ? encodeCursor(page[page.length - 1]) : undefined;

	return {
		puzzles: summaries,
		total,
		offset: params.cursor ? 0 : params.offset,
		limit: params.limit,
		...(nextCursor ? { nextCursor } : {})
	};
}

// Check if puzzle exists in KV
export async function puzzleExists(kv: KVNamespace, puzzleId: string): Promise<boolean> {
	const data = await kv.get(puzzleKey(puzzleId));
	return data !== null;
}

// R2 key helpers
export function getFamilyOriginalKey(familyId: string): string {
	return `families/${familyId}/original`;
}

export function getFamilyThumbnailKey(familyId: string): string {
	return `families/${familyId}/thumbnail.jpg`;
}

export function getOriginalKey(familyId: string): string {
	return getFamilyOriginalKey(familyId);
}

export function getThumbnailKey(puzzleId: string): string {
	return getFamilyThumbnailKey(puzzleId);
}

export function getPieceKey(puzzleId: string, pieceId: number): string {
	return `puzzles/${puzzleId}/pieces/${pieceId}.png`;
}

export async function uploadFamilyOriginalImage(
	bucket: R2Bucket,
	familyId: string,
	data: ArrayBuffer,
	contentType: string
): Promise<void> {
	await bucket.put(getFamilyOriginalKey(familyId), data, {
		httpMetadata: { contentType }
	});
}

// Upload original image to R2 (family-scoped)
export async function uploadOriginalImage(
	bucket: R2Bucket,
	familyId: string,
	data: ArrayBuffer,
	contentType: string
): Promise<void> {
	await uploadFamilyOriginalImage(bucket, familyId, data, contentType);
}

export async function resolveVariantReferenceKey(
	kv: KVNamespace,
	variantId: string
): Promise<string | null> {
	const variant = await getPuzzle(kv, variantId);
	if (!variant) return null;
	return getFamilyOriginalKey(variant.familyId);
}

/**
 * True when an original image object exists in R2 for this puzzle.
 *
 * Propagates R2 errors instead of swallowing them: callers use the result to
 * decide whether to release an idempotency reservation, and a transient
 * `head` failure must NOT be interpreted as "object gone" — that would mint a
 * duplicate of a live puzzle. Callers wrap in try/catch and return 409
 * (transient) on error so the client retries.
 */
export async function originalImageExists(bucket: R2Bucket, familyId: string): Promise<boolean> {
	const obj = await bucket.head(getFamilyOriginalKey(familyId));
	return obj !== null;
}

// Delete original image from R2
export async function deleteFamilyOriginalImage(
	bucket: R2Bucket,
	familyId: string
): Promise<{ success: boolean; error?: Error }> {
	try {
		await bucket.delete(getFamilyOriginalKey(familyId));
		return { success: true };
	} catch (error) {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		console.error(`Failed to delete original image for family ${familyId}:`, normalizedError);
		return { success: false, error: normalizedError };
	}
}

export async function deleteOriginalImage(
	bucket: R2Bucket,
	familyId: string
): Promise<{ success: boolean; error?: Error }> {
	return deleteFamilyOriginalImage(bucket, familyId);
}

// Get image from R2
export async function getImage(
	bucket: R2Bucket,
	key: string
): Promise<{ data: ArrayBuffer; contentType: string } | null> {
	try {
		const obj = await bucket.get(key);
		if (!obj) return null;

		return {
			data: await obj.arrayBuffer(),
			contentType: obj.httpMetadata?.contentType || 'application/octet-stream'
		};
	} catch (error) {
		console.error(`Failed to get image from R2 (key: ${key}):`, error);
		throw error;
	}
}

// Delete all puzzle assets from R2
export async function deletePuzzleAssets(
	bucket: R2Bucket,
	puzzleId: string,
	pieceCount: number
): Promise<{ success: boolean; failedKeys: string[] }> {
	const keysToDelete: string[] = [getOriginalKey(puzzleId), getThumbnailKey(puzzleId)];

	// Add all piece keys
	for (let i = 0; i < pieceCount; i++) {
		keysToDelete.push(getPieceKey(puzzleId, i));
	}

	const failedKeys: string[] = [];

	// Delete in batches (R2 supports up to 1000 keys per delete)
	const batchSize = 1000;
	for (let i = 0; i < keysToDelete.length; i += batchSize) {
		const batch = keysToDelete.slice(i, i + batchSize);
		try {
			await bucket.delete(batch);
		} catch (error) {
			console.error(`Failed to delete batch for puzzle ${puzzleId}:`, batch, error);
			failedKeys.push(...batch);
		}
	}

	return { success: failedKeys.length === 0, failedKeys };
}

// --- Cleanup records for deferred reaper processing ---
//
// Cleanup records are durable retry state once deletion is chosen. Eligibility
// and workflow-liveness gates are read-only with respect to the permanent fence
// and source state: unconfirmed liveness causes no D1 fence or DO/R2/KV
// mutation. Cleanup persists the record first, then establishes the permanent
// D1 fence, mutates DO/R2/KV, requires completion and ownership cleanup, and
// deletes the record only after every required step succeeds. Required failures
// retain the record for a later reaper pass.

export interface CleanupRecord {
	puzzleId: string;
	pieceCount: number;
	familyId?: string;
	idempotencyKey?: string;
	createdAt: number;
}

function cleanupKey(puzzleId: string): string {
	return `cleanup:${puzzleId}`;
}

export async function writeCleanupRecord(kv: KVNamespace, record: CleanupRecord): Promise<void> {
	await kv.put(cleanupKey(record.puzzleId), JSON.stringify(record));
}

export async function listCleanupRecords(kv: KVNamespace): Promise<CleanupRecord[]> {
	const keys: { name: string }[] = [];
	let cursor: string | undefined;
	while (true) {
		const list = await kv.list({ prefix: 'cleanup:', cursor });
		keys.push(...list.keys);
		if (list.list_complete) break;
		cursor = list.cursor;
	}
	const fetched = await Promise.all(keys.map((k) => kv.get(k.name, 'json')));
	const records: CleanupRecord[] = [];
	for (const data of fetched) {
		if (
			data &&
			typeof data === 'object' &&
			'puzzleId' in data &&
			'pieceCount' in data &&
			typeof data.puzzleId === 'string' &&
			data.puzzleId.length > 0 &&
			typeof data.pieceCount === 'number' &&
			Number.isFinite(data.pieceCount)
		) {
			records.push(data as CleanupRecord);
		}
	}
	return records;
}

export async function deleteCleanupRecord(kv: KVNamespace, puzzleId: string): Promise<void> {
	await kv.delete(cleanupKey(puzzleId));
}
