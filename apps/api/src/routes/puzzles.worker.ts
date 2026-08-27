// Worker-compatible puzzle routes for public access

import { Hono } from 'hono';
import {
	DEFAULT_PUZZLE_ASPECT_RATIO,
	MAX_FILE_SIZE,
	MAX_IMAGE_DIMENSION,
	MAX_PIECES,
	PUZZLE_CATEGORIES,
	ALLOWED_MIME_TYPES,
	aspectRatiosMatch,
	getGridDimensionsForAspectRatio,
	isPuzzleAspectRatio,
	isValidPieceCountForAspectRatio,
	stripIdempotencyKey,
	type PuzzleCategory
} from '@perseus/types';
import { PUZZLE_DIFFICULTIES, type PuzzleDifficulty } from '@perseus/types';
import type { Env } from '../worker';
import {
	createFamilyMetadata,
	createPuzzleMetadata,
	deleteFamilyMetadata,
	deleteOriginalImage,
	deletePuzzleMetadata,
	getPuzzle,
	listPuzzlesPage,
	getThumbnailKey,
	getPieceKey,
	getImage,
	uploadOriginalImage,
	buildFamilyMetadata,
	buildVariantMetadata,
	resolveVariantReferenceKey,
	type PuzzleMetadata,
	type PuzzleFamilyMetadata
} from '../services/storage.worker';
import { requirePlayerAuth } from '../middleware/player-auth.worker';
import type { PlayerSessionRecord } from '../services/player-auth.worker';
import { getWorkerDbContext } from '../db.worker';
import {
	deletePuzzleFamilyOwnership,
	detectImageType,
	insertPuzzleFamilyOwnership,
	parseImageDimensions,
	validateImageEndMarker
} from '@perseus/shared';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PIECE_ID_REGEX = /^\d+$/; // Only non-negative base-10 integers
const MAX_PIECE_ID = 10000; // Validation ceiling, significantly above any expected piece count

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
		if (
			!detectedType ||
			!ALLOWED_MIME_TYPES.includes(detectedType as (typeof ALLOWED_MIME_TYPES)[number])
		) {
			return c.json(
				{ error: 'bad_request', message: 'Invalid file type. Allowed: JPEG, PNG, WebP' },
				400
			);
		}

		// Validate that image dimensions match the requested aspect ratio.
		// parseImageDimensions returns null for files with valid magic bytes
		// but malformed/truncated headers — reject those early so corrupt
		// images don't reach R2 or the puzzle generator. Also check the
		// format's end marker (IEND/EOI/RIFF size) to catch files with a
		// valid header but missing body/trailer, matching the avatar upload
		// path's validation.
		const dimensions = await parseImageDimensions(image, detectedType);
		if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
			return c.json({ error: 'bad_request', message: 'Image is corrupted or truncated' }, 400);
		}
		if (!aspectRatiosMatch(dimensions.width, dimensions.height, aspectRatio)) {
			return c.json(
				{
					error: 'bad_request',
					message: `Image aspect ratio (${dimensions.width}x${dimensions.height}) does not match requested ratio ${aspectRatio}. Please pre-crop the image to match.`
				},
				400
			);
		}
		// Enforce MAX_IMAGE_DIMENSION before validateImageEndMarker(), which
		// fully decodes the image via Photon. A highly compressed file under
		// MAX_FILE_SIZE can declare extremely large dimensions and cause
		// Photon to allocate a large decoded pixel buffer before the request
		// is rejected. The workflow enforces this again, but that protects
		// the workflow's decode, not the earlier API decode. Matches the
		// avatar upload path's per-axis dimension check before decode.
		if (dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION) {
			return c.json(
				{
					error: 'bad_request',
					message: `Image dimensions ${dimensions.width}x${dimensions.height} exceed maximum ${MAX_IMAGE_DIMENSION}px per axis`
				},
				400
			);
		}
		const hasEndMarker = await validateImageEndMarker(image, detectedType, {
			requireFullDecode: true
		});
		if (!hasEndMarker) {
			return c.json({ error: 'bad_request', message: 'Image is corrupted or truncated' }, 400);
		}

		const familyId = crypto.randomUUID();
		const variantIds = Object.fromEntries(
			PUZZLE_DIFFICULTIES.map((difficulty) => [difficulty, crypto.randomUUID()])
		) as Record<PuzzleDifficulty, string>;
		const dbContext = getWorkerDbContext(c.env);
		if (await dbContext.completionWrites.isPuzzleTombstoned(familyId)) {
			return c.json(
				{ error: 'internal_error', message: 'Failed to allocate puzzle family ID' },
				500
			);
		}
		const createdAt = Date.now();
		const imageBuffer = await image.arrayBuffer();

		try {
			await uploadOriginalImage(c.env.PUZZLES_BUCKET, familyId, imageBuffer, detectedType);
		} catch (error) {
			console.error('Failed to upload original image:', error);
			return c.json({ error: 'internal_error', message: 'Failed to upload image' }, 500);
		}

		const familyMetadata = buildFamilyMetadata({
			familyId,
			name: trimmedName,
			aspectRatio,
			createdAt,
			variantIds,
			...(category ? { category } : {})
		});

		try {
			await createFamilyMetadata(c.env.PUZZLE_METADATA, familyMetadata);
			for (const difficulty of PUZZLE_DIFFICULTIES) {
				const variantMetadata = buildVariantMetadata({
					variantId: variantIds[difficulty],
					familyId,
					difficulty,
					name: trimmedName,
					aspectRatio,
					createdAt,
					...(category ? { category } : {})
				});
				await createPuzzleMetadata(c.env.PUZZLE_METADATA, variantMetadata);
			}
		} catch (error) {
			console.error('Failed to create puzzle metadata:', error);
			const cleanupResult = await deleteOriginalImage(c.env.PUZZLES_BUCKET, familyId);
			if (!cleanupResult.success) {
				console.error(
					'Failed to cleanup original image after metadata creation failure:',
					cleanupResult.error
				);
			}
			return c.json({ error: 'internal_error', message: 'Failed to create puzzle metadata' }, 500);
		}

		try {
			await insertPuzzleFamilyOwnership(dbContext.db, {
				id: familyId,
				ownerId: c.get('playerSession').user.id,
				name: trimmedName,
				aspectRatio,
				...(category ? { category } : {}),
				status: 'processing',
				createdAt
			});
		} catch (error) {
			console.error('Failed to record puzzle family ownership:', error);
			const familyMetadataCleanup = await deleteFamilyMetadata(c.env.PUZZLE_METADATA, familyId);
			if (!familyMetadataCleanup.success) {
				console.error(
					'Failed to cleanup puzzle family metadata after ownership insert failure:',
					familyMetadataCleanup.error
				);
			}
			for (const difficulty of PUZZLE_DIFFICULTIES) {
				await deletePuzzleMetadata(c.env.PUZZLE_METADATA, variantIds[difficulty]);
			}
			const imageCleanup = await deleteOriginalImage(c.env.PUZZLES_BUCKET, familyId);
			if (!imageCleanup.success) {
				console.error(
					'Failed to cleanup original image after ownership insert failure:',
					imageCleanup.error
				);
			}
			return c.json({ error: 'internal_error', message: 'Failed to record puzzle ownership' }, 500);
		}

		if (!c.env.PUZZLE_WORKFLOW || typeof c.env.PUZZLE_WORKFLOW.create !== 'function') {
			await deletePuzzleFamilyOwnership(dbContext.db, familyId).catch((err) =>
				console.error('Failed to cleanup ownership after missing workflow binding:', err)
			);
			const familyMetadataCleanup = await deleteFamilyMetadata(c.env.PUZZLE_METADATA, familyId);
			if (!familyMetadataCleanup.success) {
				console.error(
					'Failed to cleanup puzzle family metadata after missing workflow binding:',
					familyMetadataCleanup.error
				);
			}
			for (const difficulty of PUZZLE_DIFFICULTIES) {
				await deletePuzzleMetadata(c.env.PUZZLE_METADATA, variantIds[difficulty]);
			}
			const imageCleanup = await deleteOriginalImage(c.env.PUZZLES_BUCKET, familyId);
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
				id: familyId,
				params: { familyId }
			});
		} catch (error) {
			console.error('Failed to trigger workflow:', error);
			await deletePuzzleFamilyOwnership(dbContext.db, familyId).catch((err) =>
				console.error('Failed to cleanup ownership after workflow trigger failure:', err)
			);
			const familyMetadataCleanup = await deleteFamilyMetadata(c.env.PUZZLE_METADATA, familyId);
			if (!familyMetadataCleanup.success) {
				console.error(
					'Failed to cleanup puzzle family metadata after workflow trigger failure:',
					familyMetadataCleanup.error
				);
			}
			for (const difficulty of PUZZLE_DIFFICULTIES) {
				await deletePuzzleMetadata(c.env.PUZZLE_METADATA, variantIds[difficulty]);
			}
			const imageCleanup = await deleteOriginalImage(c.env.PUZZLES_BUCKET, familyId);
			if (!imageCleanup.success) {
				console.error(
					'Failed to cleanup original image after workflow trigger failure:',
					imageCleanup.error
				);
			}
			return c.json({ error: 'internal_error', message: 'Failed to start puzzle processing' }, 500);
		}

		return c.json(familyMetadata, 201);
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
			const referenceKey = await resolveVariantReferenceKey(c.env.PUZZLE_METADATA, id);
			if (referenceKey) {
				const originalObj = await c.env.PUZZLES_BUCKET.head(referenceKey);
				hasReference = originalObj !== null;
			}
		} catch (r2Error) {
			console.error(`Failed to check R2 reference for puzzle ${id}:`, r2Error);
		}

		// idempotencyKey is an admin/server-side dedup secret — never expose
		// it on public puzzle reads (clients could replay create with it).
		return c.json({ ...stripIdempotencyKey(puzzle), hasReference });
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

		const image = await getImage(c.env.PUZZLES_BUCKET, getThumbnailKey(puzzle.familyId));

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

		const referenceKey = await resolveVariantReferenceKey(c.env.PUZZLE_METADATA, id);
		if (!referenceKey) {
			return c.json({ error: 'not_found', message: 'Reference image not found' }, 404);
		}

		const image = await getImage(c.env.PUZZLES_BUCKET, referenceKey);

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
