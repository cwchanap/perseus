// Public puzzle-family catalog and player upload routes

import { Hono } from 'hono';
import {
	DEFAULT_PUZZLE_ASPECT_RATIO,
	MAX_FILE_SIZE,
	MAX_IMAGE_DIMENSION,
	PUZZLE_CATEGORIES,
	ALLOWED_MIME_TYPES,
	aspectRatiosMatch,
	isPuzzleAspectRatio,
	isPuzzleId,
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
	enrichFamilySummary,
	getFamily,
	getFamilyThumbnailKey,
	getImage,
	listFamiliesPage,
	uploadOriginalImage,
	buildFamilyMetadata,
	buildVariantMetadata
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

const VALID_PUZZLE_CATEGORIES = new Set(PUZZLE_CATEGORIES as readonly PuzzleCategory[]);

function isPuzzleCategory(value: string): value is PuzzleCategory {
	return VALID_PUZZLE_CATEGORIES.has(value as PuzzleCategory);
}

function parseCategory(value: string | null | undefined): PuzzleCategory | undefined {
	if (value == null) return undefined;
	return isPuzzleCategory(value) ? value : undefined;
}

const puzzleFamilies = new Hono<{
	Bindings: Env;
	Variables: { playerSession: PlayerSessionRecord };
}>();

// GET /api/puzzle-families — ready families with pagination
puzzleFamilies.get('/', async (c) => {
	try {
		const searchParams = new URL(c.req.url).searchParams;
		const q = searchParams.get('q') || undefined;
		const category = parseCategory(searchParams.get('category'));
		const offset = parseOffset(searchParams.get('offset'));
		const limit = parseLimit(searchParams.get('limit'));
		const cursor = searchParams.get('cursor') || undefined;
		const result = await listFamiliesPage(c.env.PUZZLE_METADATA, {
			q,
			category,
			offset,
			limit,
			cursor,
			readyOnly: true
		});
		return c.json(result);
	} catch (error) {
		console.error('Failed to list puzzle families', error);
		return c.json({ error: 'internal_error', message: 'Failed to list puzzle families' }, 500);
	}
});

// POST /api/puzzle-families — signed-in player create (name/category/aspect/image only)
puzzleFamilies.post('/', requirePlayerAuth, async (c) => {
	try {
		let formData: FormData;
		try {
			formData = await c.req.formData();
		} catch (error) {
			console.error('Failed to parse puzzle family form data', error);
			return c.json({ error: 'bad_request', message: 'Invalid form data' }, 400);
		}

		if (formData.get('pieceCount') !== null) {
			return c.json(
				{
					error: 'bad_request',
					message: 'pieceCount is not accepted; families generate Easy, Normal, and Hard variants'
				},
				400
			);
		}

		const name = formData.get('name');
		const aspectRatioStr = formData.get('aspectRatio');
		const image = formData.get('image') as File | string | null;

		if (!name || typeof name !== 'string' || name.trim().length === 0) {
			return c.json({ error: 'bad_request', message: 'Name is required' }, 400);
		}

		const trimmedName = name.trim();
		if (trimmedName.length > 255) {
			return c.json({ error: 'bad_request', message: 'Name must be at most 255 characters' }, 400);
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

		let familyMetadataWritten = false;
		try {
			await createFamilyMetadata(c.env.PUZZLE_METADATA, familyMetadata);
			familyMetadataWritten = true;
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
			console.error('Failed to create puzzle family metadata:', error);
			if (familyMetadataWritten) {
				const familyMetadataCleanup = await deleteFamilyMetadata(c.env.PUZZLE_METADATA, familyId);
				if (!familyMetadataCleanup.success) {
					console.error(
						'Failed to cleanup puzzle family metadata after metadata creation failure:',
						familyMetadataCleanup.error
					);
				}
				for (const difficulty of PUZZLE_DIFFICULTIES) {
					await deletePuzzleMetadata(c.env.PUZZLE_METADATA, variantIds[difficulty]);
				}
			}
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

		return c.json(stripIdempotencyKey(familyMetadata), 201);
	} catch (error) {
		console.error('Error creating puzzle family:', error);
		return c.json({ error: 'internal_error', message: 'Failed to create puzzle family' }, 500);
	}
});

// GET /api/puzzle-families/:familyId/thumbnail — must be registered before /:familyId
puzzleFamilies.get('/:familyId/thumbnail', async (c) => {
	const familyId = c.req.param('familyId');

	if (!isPuzzleId(familyId)) {
		return c.json({ error: 'bad_request', message: 'Invalid family ID format' }, 400);
	}

	try {
		const family = await getFamily(c.env.PUZZLE_METADATA, familyId);

		if (!family || family.status !== 'ready') {
			return c.json({ error: 'not_found', message: 'Puzzle family not found' }, 404);
		}

		const image = await getImage(c.env.PUZZLES_BUCKET, getFamilyThumbnailKey(familyId));

		if (!image) {
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
		console.error(`Failed to retrieve thumbnail for family ${familyId}:`, error);
		return c.json({ error: 'internal_error', message: 'Failed to retrieve thumbnail' }, 500);
	}
});

// GET /api/puzzle-families/:familyId — family detail with variant summaries
puzzleFamilies.get('/:familyId', async (c) => {
	const familyId = c.req.param('familyId');

	if (!isPuzzleId(familyId)) {
		return c.json({ error: 'bad_request', message: 'Invalid family ID format' }, 400);
	}

	try {
		const family = await getFamily(c.env.PUZZLE_METADATA, familyId);

		if (!family || family.status !== 'ready') {
			return c.json({ error: 'not_found', message: 'Puzzle family not found' }, 404);
		}

		const summary = await enrichFamilySummary(c.env.PUZZLE_METADATA, family);
		return c.json(summary);
	} catch (error) {
		console.error(`Failed to retrieve puzzle family ${familyId}:`, error);
		return c.json({ error: 'internal_error', message: 'Failed to retrieve puzzle family' }, 500);
	}
});

export default puzzleFamilies;
