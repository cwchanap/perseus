// Worker-compatible admin routes for authentication and puzzle management

import { Hono } from 'hono';
import {
	DEFAULT_PUZZLE_ASPECT_RATIO,
	MAX_PIECES,
	PUZZLE_CATEGORIES,
	getGridDimensionsForAspectRatio,
	isPuzzleAspectRatio,
	isValidPieceCountForAspectRatio
} from '@perseus/types';
import type { PuzzleCategory } from '@perseus/types';
import type { Env } from '../worker';
import {
	createPuzzleMetadata,
	deletePuzzleMetadata,
	deletePuzzleAssets,
	uploadOriginalImage,
	deleteOriginalImage,
	getPuzzle,
	listPuzzles,
	type PuzzleMetadata
} from '../services/storage.worker';
import {
	createSession,
	setSessionCookie,
	clearSessionCookie,
	getSessionToken,
	revokeSession,
	verifySession,
	requireAuth
} from '../middleware/auth.worker';
import { loginRateLimit } from '../middleware/rate-limit.worker';

const admin = new Hono<{ Bindings: Env }>();

// Constraints
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Detect image MIME type from magic bytes
async function detectImageType(file: File | Blob): Promise<string | null> {
	try {
		const header = await file.slice(0, 12).arrayBuffer();
		const bytes = new Uint8Array(header);
		if (bytes.length < 4) return null;

		// JPEG: starts with FF D8 FF
		if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
			return 'image/jpeg';
		}
		// PNG: starts with 89 50 4E 47 0D 0A 1A 0A
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
		// WebP: starts with RIFF....WEBP
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
			// PNG: width/height are 4-byte big-endian at offset 16–23
			const header = await file.slice(16, 24).arrayBuffer();
			if (header.byteLength < 8) return null;
			const view = new DataView(header);
			return { width: view.getUint32(0), height: view.getUint32(4) };
		}

		if (mimeType === 'image/jpeg') {
			// JPEG: scan SOF markers (FF C0..FF C3, FF C5..FF C7, FF C9..FF CB, FF CD..FF CF)
			// Height/width are at offset+5/offset+7 within each marker segment
			const buf = await file.slice(0, Math.min(file.size, 256 * 1024)).arrayBuffer();
			const bytes = new Uint8Array(buf);
			let offset = 2; // skip FF D8 SOI
			while (offset < bytes.length - 8) {
				if (bytes[offset] !== 0xff) break;
				const marker = bytes[offset + 1];
				// SOS (FF DA) or EOI (FF D9) — stop scanning
				if (marker === 0xda || marker === 0xd9) break;
				// Standalone markers (no payload)
				if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
					offset += 2;
					continue;
				}
				// SOF markers carry dimensions
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
				// Skip this marker segment
				if (offset + 4 > bytes.length) break;
				const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
				offset += 2 + segLen;
			}
			return null;
		}

		if (mimeType === 'image/webp') {
			// WebP: check for VP8/VP8L/VP8X chunk
			// slice(12, 34) gives us up to 22 bytes: 4-byte fourCC + 4-byte chunk size +
			// up to 14 bytes of chunk data (enough for all three VP8 variants)
			const header = await file.slice(12, 34).arrayBuffer();
			if (header.byteLength < 8) return null;
			const decoder = new TextDecoder();
			const fourCC = decoder.decode(new Uint8Array(header, 0, 4));
			if (fourCC === 'VP8 ') {
				// Lossy: frame_tag(3) + sync(3) + width(2) + height(2) = 10 bytes
				// Relative to header start: 4(fourCC) + 4(chunkSize) + 6 = offset 14
				if (header.byteLength < 18) return null;
				const view = new DataView(header);
				const w = view.getUint16(14, true) & 0x3fff;
				const h = view.getUint16(16, true) & 0x3fff;
				return { width: w, height: h };
			}
			if (fourCC === 'VP8L') {
				// Lossless: 1-byte signature + 4-byte image-size packed as 28 bits
				// Relative to header: 4 + 4 + 1 = offset 9
				if (header.byteLength < 13) return null;
				const b = new DataView(header).getUint32(9, true);
				const w = (b & 0x3fff) + 1;
				const h = ((b >> 14) & 0x3fff) + 1;
				return { width: w, height: h };
			}
			if (fourCC === 'VP8X') {
				// Extended: 1-byte flags + 3-byte reserved + 3-byte canvas-width-1 + 3-byte canvas-height-1
				// Relative to header: 4(fourCC) + 4(chunkSize) + 1(flags) + 3(reserved) = offset 12 for width, offset 15 for height
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

// Tolerance for aspect ratio mismatch between image dimensions and requested ratio.
// Accounts for rounding in normalized images (e.g., 3:4 at 300px wide → 400px tall, not 399.99).
const ASPECT_RATIO_TOLERANCE = 0.05; // 5%

function aspectRatiosMatch(imageWidth: number, imageHeight: number, targetRatio: string): boolean {
	const parts = targetRatio.split(':').map(Number);
	const targetW = parts[0];
	const targetH = parts[1];
	const actual = imageWidth / imageHeight;
	const expected = targetW / targetH;
	return Math.abs(actual - expected) / expected <= ASPECT_RATIO_TOLERANCE;
}

// POST /api/admin/login - Admin login
admin.post('/login', loginRateLimit, async (c) => {
	try {
		let body;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
		}

		const { passkey } = body as { passkey?: string };

		if (!passkey || typeof passkey !== 'string') {
			return c.json({ error: 'bad_request', message: 'Passkey is required' }, 400);
		}

		// Validate ADMIN_PASSKEY is configured
		if (!c.env.ADMIN_PASSKEY) {
			console.error('ADMIN_PASSKEY environment variable is not configured');
			return c.json({ error: 'internal_error', message: 'Server configuration error' }, 500);
		}

		// Use WebCrypto for constant-time comparison
		const encoder = new TextEncoder();
		const passkeyBytes = encoder.encode(passkey);
		const expectedBytes = encoder.encode(c.env.ADMIN_PASSKEY);

		// Hash both for constant-time comparison
		const passkeyHash = await crypto.subtle.digest('SHA-256', passkeyBytes);
		const expectedHash = await crypto.subtle.digest('SHA-256', expectedBytes);

		// Constant-time comparison via XOR over fixed-length SHA-256 hashes
		const passkeyArr = new Uint8Array(passkeyHash);
		const expectedArr = new Uint8Array(expectedHash);

		let diff = passkeyArr.length ^ expectedArr.length;
		const maxLength = Math.max(passkeyArr.length, expectedArr.length);
		for (let i = 0; i < maxLength; i++) {
			const a = i < passkeyArr.length ? passkeyArr[i] : 0;
			const b = i < expectedArr.length ? expectedArr[i] : 0;
			diff |= a ^ b;
		}
		const isValid = diff === 0;

		if (!isValid) {
			return c.json({ error: 'unauthorized', message: 'Invalid passkey' }, 401);
		}

		const token = await createSession(c.env, {
			userId: 'admin',
			username: 'admin',
			role: 'admin'
		});
		setSessionCookie(c, token);
		// Rate limit reset is handled by loginRateLimit middleware on 200 response

		return c.json({ success: true });
	} catch (error) {
		console.error('Failed to process admin login', error);
		return c.json({ error: 'internal_error', message: 'Failed to process login' }, 500);
	}
});

// POST /api/admin/logout - Admin logout
admin.post('/logout', async (c) => {
	const token = getSessionToken(c);
	if (token) {
		try {
			await revokeSession(c.env, token);
		} catch (error) {
			// In production, session revocation failure is a security concern.
			// We must not silently suppress this - the client needs to know and retry.
			console.error('Failed to revoke session server-side:', error);
			// In production, return an error so the client can retry
			if (c.env.NODE_ENV !== 'development') {
				return c.json(
					{
						error: 'internal_error',
						message: 'Failed to revoke session. Please try again.'
					},
					500
				);
			}
			// In development, fall through to clear cookie for debugging convenience
		}
	}
	clearSessionCookie(c);
	return c.json({ success: true });
});

// GET /api/admin/session - Check admin session
admin.get('/session', async (c) => {
	try {
		const token = getSessionToken(c);

		if (!token) {
			return c.json({ authenticated: false });
		}

		const session = await verifySession(c.env, token);

		if (!session) {
			clearSessionCookie(c);
			return c.json({ authenticated: false });
		}

		return c.json({ authenticated: true });
	} catch (error) {
		// Unexpected error during session verification (e.g., JWT_SECRET misconfiguration)
		console.error('Session verification failed unexpectedly:', error);
		return c.json({ error: 'internal_error', message: 'Session verification failed' }, 500);
	}
});

// GET /api/admin/puzzles - List all puzzles for admin (includes processing/failed)
admin.get('/puzzles', requireAuth, async (c) => {
	try {
		const { puzzles: puzzleList } = await listPuzzles(c.env.PUZZLE_METADATA);
		return c.json({ puzzles: puzzleList });
	} catch (error) {
		console.error('Failed to list puzzles for admin', error);
		return c.json({ error: 'internal_error', message: 'Failed to list puzzles' }, 500);
	}
});

// POST /api/admin/puzzles - Create new puzzle (protected)
admin.post('/puzzles', requireAuth, async (c) => {
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

		// Validate name
		if (!name || typeof name !== 'string' || name.trim().length === 0) {
			return c.json({ error: 'bad_request', message: 'Name is required' }, 400);
		}

		const trimmedName = name.trim();
		if (trimmedName.length > 255) {
			return c.json({ error: 'bad_request', message: 'Name must be at most 255 characters' }, 400);
		}

		// Validate piece count for the selected fixed aspect ratio.
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

		// Validate image
		if (!image || !(image instanceof File)) {
			return c.json({ error: 'bad_request', message: 'Image file is required' }, 400);
		}

		// Validate optional category
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

		// Verify actual file type via magic bytes instead of trusting image.type
		const detectedType = await detectImageType(image);
		if (!detectedType || !ALLOWED_MIME_TYPES.includes(detectedType)) {
			return c.json(
				{ error: 'bad_request', message: 'Invalid file type. Allowed: JPEG, PNG, WebP' },
				400
			);
		}

		// Validate that image dimensions match the requested aspect ratio
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
		}
		// If dimensions can't be parsed, proceed — the workflow will use actual pixel dimensions

		// Generate puzzle ID
		const id = crypto.randomUUID();

		// Calculate grid dimensions (must match workflow calculation)
		const { rows: gridRows, cols: gridCols } = getGridDimensionsForAspectRatio(
			pieceCount,
			aspectRatio
		);

		// Prepare image buffer
		const imageBuffer = await image.arrayBuffer();

		// Step 1: Upload original image to R2 first
		try {
			await uploadOriginalImage(c.env.PUZZLES_BUCKET, id, imageBuffer, detectedType);
		} catch (error) {
			console.error('Failed to upload original image:', error);
			return c.json({ error: 'internal_error', message: 'Failed to upload image' }, 500);
		}

		// Step 2: Create puzzle metadata with processing status
		const puzzleMetadata: PuzzleMetadata = {
			id,
			name: trimmedName,
			...(category && { category }),
			aspectRatio,
			pieceCount,
			gridCols,
			gridRows,
			imageWidth: 0, // Will be set by workflow
			imageHeight: 0, // Will be set by workflow
			createdAt: Date.now(),
			status: 'processing',
			progress: {
				totalPieces: pieceCount,
				generatedPieces: 0,
				updatedAt: Date.now()
			},
			pieces: [],
			version: 0 // Initial version for optimistic concurrency
		};

		try {
			// Store metadata in KV
			await createPuzzleMetadata(c.env.PUZZLE_METADATA, puzzleMetadata);
		} catch (error) {
			console.error('Failed to create puzzle metadata:', error);
			// Clean up the uploaded image
			const cleanupResult = await deleteOriginalImage(c.env.PUZZLES_BUCKET, id);
			if (!cleanupResult.success) {
				console.error(
					'Failed to cleanup original image after metadata creation failure:',
					cleanupResult.error
				);
			}
			return c.json({ error: 'internal_error', message: 'Failed to create puzzle metadata' }, 500);
		}

		// Step 3: Trigger workflow for puzzle generation
		if (!c.env.PUZZLE_WORKFLOW || typeof c.env.PUZZLE_WORKFLOW.create !== 'function') {
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
			// Clean up both metadata and image
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

// DELETE /api/admin/puzzles/:id - Delete puzzle (protected)
admin.delete('/puzzles/:id', requireAuth, async (c) => {
	const id = c.req.param('id');
	const force = c.req.query('force') === 'true';

	// Validate UUID format
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	if (!uuidRegex.test(id)) {
		return c.json({ error: 'bad_request', message: 'Invalid puzzle ID format' }, 400);
	}

	try {
		// Get puzzle to check status before deletion
		// Note: There is a small TOCTOU window between getPuzzle and deletePuzzleMetadata
		// where the puzzle status could change. This endpoint accepts that risk for simplicity.
		// The status check prevents deletion of processing puzzles, but a race could still occur
		// if processing completes between the check and the delete.
		const puzzle = await getPuzzle(c.env.PUZZLE_METADATA, id);

		if (!puzzle) {
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}

		// Block deletion if puzzle is still processing unless force=true
		// Force delete allows cleanup of stuck puzzles where workflow failed to mark them as failed
		if (puzzle.status === 'processing' && !force) {
			return c.json(
				{
					error: 'conflict',
					message:
						'Cannot delete puzzle while it is being processed. Please wait for processing to complete, or use force=true to delete a stuck puzzle.'
				},
				409
			);
		}

		// Delete metadata from KV first
		const metadataResult = await deletePuzzleMetadata(c.env.PUZZLE_METADATA, id);

		if (!metadataResult.success) {
			console.error('Failed to delete puzzle metadata:', metadataResult.error);
			return c.json({ error: 'internal_error', message: 'Failed to delete puzzle' }, 500);
		}

		// Delete assets from R2
		const deleteResult = await deletePuzzleAssets(c.env.PUZZLES_BUCKET, id, puzzle.pieceCount);

		// If some assets failed to delete, return 207 Multi-Status
		if (!deleteResult.success) {
			console.error(`Failed to delete some assets for puzzle ${id}:`, deleteResult.failedKeys);
			return c.json(
				{
					success: false,
					partialSuccess: true,
					warning: 'Puzzle metadata deleted but some assets failed to delete',
					failedAssets: deleteResult.failedKeys
				},
				207
			);
		}

		return c.body(null, 204);
	} catch (error) {
		console.error(`Error deleting puzzle ${id}:`, error);
		return c.json({ error: 'internal_error', message: 'Failed to delete puzzle' }, 500);
	}
});

export default admin;
