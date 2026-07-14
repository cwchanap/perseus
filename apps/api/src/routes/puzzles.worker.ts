// Worker-compatible puzzle routes for public access

import { Hono } from 'hono';
import {
	DEFAULT_PUZZLE_ASPECT_RATIO,
	MAX_PIECES,
	PUZZLE_CATEGORIES,
	aspectRatiosMatch,
	getGridDimensionsForAspectRatio,
	isPuzzleAspectRatio,
	isValidPieceCountForAspectRatio,
	type PuzzleCategory
} from '@perseus/types';
import type { Env } from '../worker';
import {
	createPuzzleMetadata,
	deleteOriginalImage,
	deletePuzzleMetadata,
	getPuzzle,
	listPuzzlesPage,
	getThumbnailKey,
	getPieceKey,
	getOriginalKey,
	getImage,
	uploadOriginalImage,
	type PuzzleMetadata
} from '../services/storage.worker';
import { requirePlayerAuth } from '../middleware/player-auth.worker';
import type { PlayerSessionRecord } from '../services/player-auth.worker';
import { getWorkerDb } from '../db.worker';
import { insertPuzzleOwnership, deletePuzzleOwnership } from '@perseus/shared';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PIECE_ID_REGEX = /^\d+$/; // Only non-negative base-10 integers
const MAX_PIECE_ID = 10000; // Validation ceiling, significantly above any expected piece count
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function validatePuzzleId(id: string): boolean {
	return UUID_REGEX.test(id);
}

function validatePieceId(id: string): number | null {
	if (!PIECE_ID_REGEX.test(id)) {
		return null;
	}
	const num = parseInt(id, 10);
	if (num > MAX_PIECE_ID) {
		return null;
	}
	return num;
}

const VALID_PUZZLE_CATEGORIES = new Set(PUZZLE_CATEGORIES as readonly PuzzleCategory[]);

function isPuzzleCategory(value: string): value is PuzzleCategory {
	return VALID_PUZZLE_CATEGORIES.has(value as PuzzleCategory);
}

const DECIMAL_INT_REGEX = /^\d+$/;

function parseOffset(value: string | null): number {
	if (value === null) return 0;
	if (!DECIMAL_INT_REGEX.test(value)) return 0;
	const rawOffset = Number(value);
	return rawOffset >= 0 ? rawOffset : 0;
}

function parseLimit(value: string | null): number {
	if (value === null) return 20;
	if (!DECIMAL_INT_REGEX.test(value)) return 20;
	const rawLimit = Number(value);
	return rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 20;
}

function parseCategory(value: string | null | undefined): PuzzleCategory | undefined {
	if (value == null) return undefined;
	return isPuzzleCategory(value) ? value : undefined;
}

const puzzles = new Hono<{
	Bindings: Env;
	Variables: { playerSession: PlayerSessionRecord };
}>();

/* v8 ignore start -- duplicated admin upload validation helpers; covered by admin tests */
// Detect image MIME type from magic bytes
async function detectImageType(file: File | Blob): Promise<string | null> {
	try {
		const header = await file.slice(0, 12).arrayBuffer();
		const bytes = new Uint8Array(header);
		if (bytes.length < 4) return null;

		if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
			return 'image/jpeg';
		}
		if (
			bytes[0] === 0x89 &&
			bytes[1] === 0x50 &&
			bytes[2] === 0x4e &&
			bytes[3] === 0x47 &&
			bytes.length >= 8 &&
			bytes[4] === 0x0d &&
			bytes[5] === 0x0a &&
			bytes[6] === 0x1a &&
			bytes[7] === 0x0a
		) {
			return 'image/png';
		}
		if (
			bytes.length >= 12 &&
			bytes[0] === 0x52 &&
			bytes[1] === 0x49 &&
			bytes[2] === 0x46 &&
			bytes[3] === 0x46 &&
			bytes[8] === 0x57 &&
			bytes[9] === 0x45 &&
			bytes[10] === 0x42 &&
			bytes[11] === 0x50
		) {
			return 'image/webp';
		}
		return null;
	} catch (error) {
		console.error('Failed to detect image type from file bytes:', error);
		return null;
	}
}

// Parse image width/height from binary headers without decoding the full image
async function parseImageDimensions(
	file: File | Blob,
	mimeType: string
): Promise<{ width: number; height: number } | null> {
	try {
		if (mimeType === 'image/png') {
			const header = await file.slice(16, 24).arrayBuffer();
			if (header.byteLength < 8) return null;
			const view = new DataView(header);
			return { width: view.getUint32(0), height: view.getUint32(4) };
		}

		if (mimeType === 'image/jpeg') {
			const buf = await file.slice(0, Math.min(file.size, 256 * 1024)).arrayBuffer();
			const bytes = new Uint8Array(buf);
			let offset = 2;
			while (offset < bytes.length - 8) {
				if (bytes[offset] !== 0xff) break;
				const marker = bytes[offset + 1];
				if (marker === 0xda || marker === 0xd9) break;
				if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
					offset += 2;
					continue;
				}
				if (
					(marker >= 0xc0 && marker <= 0xc3) ||
					(marker >= 0xc5 && marker <= 0xc7) ||
					(marker >= 0xc9 && marker <= 0xcb) ||
					(marker >= 0xcd && marker <= 0xcf)
				) {
					const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
					if (segLen < 9 || offset + 9 > bytes.length) return null;
					const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
					const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
					return { width, height };
				}
				if (offset + 4 > bytes.length) break;
				const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
				offset += 2 + segLen;
			}
			return null;
		}

		if (mimeType === 'image/webp') {
			const header = await file.slice(12, 34).arrayBuffer();
			if (header.byteLength < 8) return null;
			const decoder = new TextDecoder();
			const fourCC = decoder.decode(new Uint8Array(header, 0, 4));
			if (fourCC === 'VP8 ') {
				if (header.byteLength < 18) return null;
				const view = new DataView(header);
				const w = view.getUint16(14, true) & 0x3fff;
				const h = view.getUint16(16, true) & 0x3fff;
				return { width: w, height: h };
			}
			if (fourCC === 'VP8L') {
				if (header.byteLength < 13) return null;
				const b = new DataView(header).getUint32(9, true);
				const w = (b & 0x3fff) + 1;
				const h = ((b >> 14) & 0x3fff) + 1;
				return { width: w, height: h };
			}
			if (fourCC === 'VP8X') {
				if (header.byteLength < 18) return null;
				const bytes = new Uint8Array(header);
				const w = (bytes[12] | (bytes[13] << 8) | (bytes[14] << 16)) + 1;
				const h = (bytes[15] | (bytes[16] << 8) | (bytes[17] << 16)) + 1;
				return { width: w, height: h };
			}
			return null;
		}

		return null;
	} catch (error) {
		console.error('Failed to parse image dimensions:', error);
		return null;
	}
}

/* v8 ignore stop */

// GET /api/puzzles - List all ready puzzles
puzzles.get('/', async (c) => {
	try {
		const searchParams = new URL(c.req.url).searchParams;
		const q = searchParams.get('q') || undefined;
		const category = parseCategory(searchParams.get('category'));
		const offset = parseOffset(searchParams.get('offset'));
		const limit = parseLimit(searchParams.get('limit'));
		const cursor = searchParams.get('cursor') || undefined;
		const result = await listPuzzlesPage(c.env.PUZZLE_METADATA, {
			q,
			category,
			offset,
			limit,
			cursor
		});
		return c.json(result);
	} catch (error) {
		console.error('Failed to list puzzles', error);
		return c.json({ error: 'internal_error', message: 'Failed to list puzzles' }, 500);
	}
});

// POST /api/puzzles - Create a server puzzle for the signed-in player
puzzles.post('/', requirePlayerAuth, async (c) => {
	try {
		let formData: FormData;
		try {
			formData = await c.req.formData();
		} catch (error) {
			console.error('Failed to parse puzzle form data', error);
			return c.json({ error: 'bad_request', message: 'Invalid form data' }, 400);
		}
		const name = formData.get('name');
		const pieceCountStr = formData.get('pieceCount');
		const aspectRatioStr = formData.get('aspectRatio');
		const image = formData.get('image') as File | string | null;

		if (!name || typeof name !== 'string' || name.trim().length === 0) {
			return c.json({ error: 'bad_request', message: 'Name is required' }, 400);
		}

		const trimmedName = name.trim();
		if (trimmedName.length > 255) {
			return c.json({ error: 'bad_request', message: 'Name must be at most 255 characters' }, 400);
		}

		if (!pieceCountStr) {
			return c.json({ error: 'bad_request', message: 'Piece count is required' }, 400);
		}

		const aspectRatio =
			typeof aspectRatioStr === 'string' && aspectRatioStr.trim().length > 0
				? aspectRatioStr.trim()
				: DEFAULT_PUZZLE_ASPECT_RATIO;
		if (!isPuzzleAspectRatio(aspectRatio)) {
			return c.json(
				{
					error: 'bad_request',
					message: 'Invalid aspect ratio. Allowed: 1:1, 4:3, 3:4'
				},
				400
			);
		}

		const pieceCount = Number(pieceCountStr.toString());
		if (!Number.isFinite(pieceCount) || !Number.isInteger(pieceCount)) {
			return c.json(
				{
					error: 'bad_request',
					message: `Invalid piece count for ${aspectRatio}`
				},
				400
			);
		}

		if (pieceCount < 4 || pieceCount > MAX_PIECES) {
			return c.json(
				{
					error: 'bad_request',
					message: `Piece count must be between 4 and ${MAX_PIECES}`
				},
				400
			);
		}

		if (!isValidPieceCountForAspectRatio(pieceCount, aspectRatio)) {
			return c.json(
				{
					error: 'bad_request',
					message: `Invalid piece count for ${aspectRatio}`
				},
				400
			);
		}

		if (!image || !(image instanceof File)) {
			return c.json({ error: 'bad_request', message: 'Image file is required' }, 400);
		}

		const categoryStr = formData.get('category');
		let category: PuzzleCategory | undefined;
		if (categoryStr && typeof categoryStr === 'string' && categoryStr.trim().length > 0) {
			const trimmedCategory = categoryStr.trim();
			const validCategories: readonly string[] = PUZZLE_CATEGORIES;
			if (!validCategories.includes(trimmedCategory)) {
				return c.json(
					{
						error: 'bad_request',
						message: `Invalid category. Allowed: ${PUZZLE_CATEGORIES.join(', ')}`
					},
					400
				);
			}
			category = trimmedCategory as PuzzleCategory;
		}

		if (image.size > MAX_FILE_SIZE) {
			return c.json({ error: 'bad_request', message: 'File size exceeds 10MB limit' }, 400);
		}

		const detectedType = await detectImageType(image);
		if (!detectedType || !ALLOWED_MIME_TYPES.includes(detectedType)) {
			return c.json(
				{ error: 'bad_request', message: 'Invalid file type. Allowed: JPEG, PNG, WebP' },
				400
			);
		}

		const dimensions = await parseImageDimensions(image, detectedType);
		if (dimensions) {
			if (!aspectRatiosMatch(dimensions.width, dimensions.height, aspectRatio)) {
				return c.json(
					{
						error: 'bad_request',
						message: `Image aspect ratio (${dimensions.width}x${dimensions.height}) does not match requested ratio ${aspectRatio}. Please pre-crop the image to match.`
					},
					400
				);
			}
		} else {
			console.warn(
				`Could not parse dimensions for ${detectedType} image; skipping aspect-ratio validation`
			);
		}

		const id = crypto.randomUUID();
		const { rows: gridRows, cols: gridCols } = getGridDimensionsForAspectRatio(
			pieceCount,
			aspectRatio
		);
		const imageBuffer = await image.arrayBuffer();

		try {
			await uploadOriginalImage(c.env.PUZZLES_BUCKET, id, imageBuffer, detectedType);
		} catch (error) {
			console.error('Failed to upload original image:', error);
			return c.json({ error: 'internal_error', message: 'Failed to upload image' }, 500);
		}

		const puzzleMetadata: PuzzleMetadata = {
			id,
			name: trimmedName,
			...(category && { category }),
			aspectRatio,
			pieceCount,
			gridCols,
			gridRows,
			imageWidth: 0,
			imageHeight: 0,
			createdAt: Date.now(),
			status: 'processing',
			progress: {
				totalPieces: pieceCount,
				generatedPieces: 0,
				updatedAt: Date.now()
			},
			pieces: [],
			version: 0
		};

		try {
			await createPuzzleMetadata(c.env.PUZZLE_METADATA, puzzleMetadata);
		} catch (error) {
			console.error('Failed to create puzzle metadata:', error);
			const cleanupResult = await deleteOriginalImage(c.env.PUZZLES_BUCKET, id);
			if (!cleanupResult.success) {
				console.error(
					'Failed to cleanup original image after metadata creation failure:',
					cleanupResult.error
				);
			}
			return c.json({ error: 'internal_error', message: 'Failed to create puzzle metadata' }, 500);
		}

		// Record ownership before kicking off the workflow so the puzzle is
		// always visible to its owner. A committed puzzle without an ownership
		// row would process silently and never appear in the player's list.
		try {
			await insertPuzzleOwnership(getWorkerDb(c.env), {
				id,
				ownerId: c.get('playerSession').user.id,
				name: trimmedName,
				pieceCount,
				...(category ? { category } : {}),
				status: 'processing',
				createdAt: puzzleMetadata.createdAt
			});
		} catch (error) {
			console.error('Failed to record puzzle ownership:', error);
			const metadataCleanup = await deletePuzzleMetadata(c.env.PUZZLE_METADATA, id);
			if (!metadataCleanup.success) {
				console.error(
					'Failed to cleanup puzzle metadata after ownership insert failure:',
					metadataCleanup.error
				);
			}
			const imageCleanup = await deleteOriginalImage(c.env.PUZZLES_BUCKET, id);
			if (!imageCleanup.success) {
				console.error(
					'Failed to cleanup original image after ownership insert failure:',
					imageCleanup.error
				);
			}
			return c.json({ error: 'internal_error', message: 'Failed to record puzzle ownership' }, 500);
		}

		if (!c.env.PUZZLE_WORKFLOW || typeof c.env.PUZZLE_WORKFLOW.create !== 'function') {
			await deletePuzzleOwnership(getWorkerDb(c.env), id).catch((err) =>
				console.error('Failed to cleanup ownership after missing workflow binding:', err)
			);
			const metadataCleanup = await deletePuzzleMetadata(c.env.PUZZLE_METADATA, id);
			if (!metadataCleanup.success) {
				console.error(
					'Failed to cleanup puzzle metadata after missing workflow binding:',
					metadataCleanup.error
				);
			}
			const imageCleanup = await deleteOriginalImage(c.env.PUZZLES_BUCKET, id);
			if (!imageCleanup.success) {
				console.error(
					'Failed to cleanup original image after missing workflow binding:',
					imageCleanup.error
				);
			}
			return c.json(
				{
					error: 'service_unavailable',
					message: 'Puzzle workflow is not configured for this environment'
				},
				503
			);
		}

		try {
			await c.env.PUZZLE_WORKFLOW.create({
				id,
				params: { puzzleId: id }
			});
		} catch (error) {
			console.error('Failed to trigger workflow:', error);
			await deletePuzzleOwnership(getWorkerDb(c.env), id).catch((err) =>
				console.error('Failed to cleanup ownership after workflow trigger failure:', err)
			);
			const metadataCleanup = await deletePuzzleMetadata(c.env.PUZZLE_METADATA, id);
			if (!metadataCleanup.success) {
				console.error(
					'Failed to cleanup puzzle metadata after workflow trigger failure:',
					metadataCleanup.error
				);
			}
			const imageCleanup = await deleteOriginalImage(c.env.PUZZLES_BUCKET, id);
			if (!imageCleanup.success) {
				console.error(
					'Failed to cleanup original image after workflow trigger failure:',
					imageCleanup.error
				);
			}
			return c.json({ error: 'internal_error', message: 'Failed to start puzzle processing' }, 500);
		}

		return c.json(puzzleMetadata, 201);
	} catch (error) {
		console.error('Error creating puzzle:', error);
		return c.json({ error: 'internal_error', message: 'Failed to create puzzle' }, 500);
	}
});

// GET /api/puzzles/:id - Get puzzle details
puzzles.get('/:id', async (c) => {
	const id = c.req.param('id');

	if (!validatePuzzleId(id)) {
		return c.json({ error: 'bad_request', message: 'Invalid puzzle ID format' }, 400);
	}

	try {
		const puzzle = await getPuzzle(c.env.PUZZLE_METADATA, id);

		if (!puzzle) {
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}

		if (puzzle.status !== 'ready') {
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}

		// Check R2 for original image existence rather than hardcoding true —
		// puzzles created before the reference-upload patch won't have the asset.
		// Degrade gracefully if R2 is unavailable — hasReference is display-only.
		let hasReference = false;
		try {
			const originalObj = await c.env.PUZZLES_BUCKET.head(getOriginalKey(id));
			hasReference = originalObj !== null;
		} catch (r2Error) {
			console.error(`Failed to check R2 reference for puzzle ${id}:`, r2Error);
		}

		return c.json({ ...puzzle, hasReference });
	} catch (error) {
		console.error(`Failed to retrieve puzzle ${id}:`, error);
		return c.json({ error: 'internal_error', message: 'Failed to retrieve puzzle' }, 500);
	}
});

// GET /api/puzzles/:id/thumbnail - Get puzzle thumbnail image
puzzles.get('/:id/thumbnail', async (c) => {
	const id = c.req.param('id');

	if (!validatePuzzleId(id)) {
		return c.json({ error: 'bad_request', message: 'Invalid puzzle ID format' }, 400);
	}

	try {
		const puzzle = await getPuzzle(c.env.PUZZLE_METADATA, id);

		if (!puzzle) {
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}

		if (puzzle.status !== 'ready') {
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}

		const image = await getImage(c.env.PUZZLES_BUCKET, getThumbnailKey(id));

		if (!image) {
			// Thumbnail missing for puzzle marked ready — inconsistent state / asset missing
			return c.json({ error: 'not_found', message: 'Thumbnail not found' }, 404);
		}

		return new Response(image.data, {
			status: 200,
			headers: {
				'Content-Type': image.contentType,
				'Cache-Control': 'public, max-age=86400'
			}
		});
	} catch (error) {
		console.error(`Failed to retrieve thumbnail for puzzle ${id}:`, error);
		return c.json({ error: 'internal_error', message: 'Failed to retrieve thumbnail' }, 500);
	}
});

// GET /api/puzzles/:id/reference - Get reference image
puzzles.get('/:id/reference', async (c) => {
	const id = c.req.param('id');

	if (!validatePuzzleId(id)) {
		return c.json({ error: 'bad_request', message: 'Invalid puzzle ID format' }, 400);
	}

	try {
		const puzzle = await getPuzzle(c.env.PUZZLE_METADATA, id);

		if (!puzzle) {
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}

		if (puzzle.status !== 'ready') {
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}

		const image = await getImage(c.env.PUZZLES_BUCKET, getOriginalKey(id));

		if (!image) {
			return c.json({ error: 'not_found', message: 'Reference image not found' }, 404);
		}

		return new Response(image.data, {
			status: 200,
			headers: {
				'Content-Type': image.contentType,
				'Cache-Control': 'public, max-age=86400'
			}
		});
	} catch (error) {
		console.error(`Failed to retrieve reference image for puzzle ${id}:`, error);
		return c.json({ error: 'internal_error', message: 'Failed to retrieve reference image' }, 500);
	}
});

// GET /api/puzzles/:id/pieces/:pieceId/image - Get piece image
puzzles.get('/:id/pieces/:pieceId/image', async (c) => {
	const id = c.req.param('id');
	const pieceIdStr = c.req.param('pieceId');
	const pieceId = validatePieceId(pieceIdStr);

	if (!validatePuzzleId(id)) {
		return c.json({ error: 'bad_request', message: 'Invalid puzzle ID format' }, 400);
	}

	if (pieceId === null) {
		return c.json({ error: 'invalid_piece_id', message: 'Invalid piece ID' }, 400);
	}

	try {
		const puzzle = await getPuzzle(c.env.PUZZLE_METADATA, id);

		if (!puzzle) {
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}

		if (puzzle.status !== 'ready') {
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}

		if (typeof puzzle.pieceCount !== 'number' || !Number.isFinite(puzzle.pieceCount)) {
			return c.json({ error: 'unavailable', message: 'Puzzle metadata incomplete' }, 409);
		}

		if (pieceId >= puzzle.pieceCount) {
			return c.json({ error: 'not_found', message: 'Piece not found' }, 404);
		}

		const image = await getImage(c.env.PUZZLES_BUCKET, getPieceKey(id, pieceId));

		if (!image) {
			// Piece image not found despite puzzle being 'ready' — piece may have failed generation or be missing
			return c.json({ error: 'not_found', message: 'Piece image not found' }, 404);
		}

		return new Response(image.data, {
			status: 200,
			headers: {
				'Content-Type': image.contentType,
				'Cache-Control': 'public, max-age=86400'
			}
		});
	} catch (error) {
		console.error(`Failed to retrieve piece ${pieceId} for puzzle ${id}:`, error);
		return c.json({ error: 'internal_error', message: 'Failed to retrieve piece image' }, 500);
	}
});

import complete from './puzzles.complete.worker';
puzzles.route('/', complete);

export default puzzles;
