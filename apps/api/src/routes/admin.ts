// Admin routes for authentication and puzzle management
import { Hono } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import {
	createSession,
	setSessionCookie,
	clearSessionCookie,
	getSessionToken,
	verifySession,
	requireAuth
} from '../middleware/auth';
import { loginRateLimit, resetLoginAttempts } from '../middleware/rate-limit';
import { generatePuzzle, isValidPieceCount } from '../services/puzzle-generator';
import {
	createPuzzle as storePuzzle,
	deletePuzzle as deleteStoredPuzzle,
	listPuzzles,
	puzzleExists,
	getOriginalImagePath,
	getPuzzleDir
} from '../services/storage';
import { MAX_FILE_SIZE, ALLOWED_MIME_TYPES, PUZZLE_CATEGORIES } from '../types';
import type { PuzzleCategory } from '../types';
import { DEFAULT_PUZZLE_ASPECT_RATIO, isPuzzleAspectRatio } from '@perseus/types';

const admin = new Hono();

const ADMIN_PASSKEY = (() => {
	const passkey = process.env.ADMIN_PASSKEY;
	if (!passkey) {
		throw new Error('ADMIN_PASSKEY environment variable is required');
	}
	return passkey;
})();

const ADMIN_PASSKEY_DIGEST = createHash('sha256').update(ADMIN_PASSKEY).digest();
const DATA_DIR = process.env.DATA_DIR || './data';

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
			const header = await file.slice(12, 34).arrayBuffer();
			if (header.byteLength < 8) return null;
			const decoder = new TextDecoder();
			const fourCC = decoder.decode(new Uint8Array(header, 0, 4));
			if (fourCC === 'VP8 ') {
				// Lossy: frame_tag(3) + sync(3) + width(2) + height(2) = 10 bytes
				if (header.byteLength < 18) return null;
				const view = new DataView(header);
				const w = view.getUint16(14, true) & 0x3fff;
				const h = view.getUint16(16, true) & 0x3fff;
				return { width: w, height: h };
			}
			if (fourCC === 'VP8L') {
				// Lossless: 1-byte signature + 4-byte image-size packed as 28 bits
				if (header.byteLength < 13) return null;
				const b = new DataView(header).getUint32(9, true);
				const w = (b & 0x3fff) + 1;
				const h = ((b >> 14) & 0x3fff) + 1;
				return { width: w, height: h };
			}
			if (fourCC === 'VP8X') {
				// Extended: 1-byte flags + 3-byte reserved + 3-byte canvas-width-1 + 3-byte canvas-height-1
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
const ASPECT_RATIO_TOLERANCE = 0.05; // 5%

function aspectRatiosMatch(imageWidth: number, imageHeight: number, targetRatio: string): boolean {
	const parts = targetRatio.split(':').map(Number);
	const targetW = parts[0];
	const targetH = parts[1];
	const actual = imageWidth / imageHeight;
	const expected = targetW / targetH;
	return Math.abs(actual - expected) / expected <= ASPECT_RATIO_TOLERANCE;
}

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

// POST /api/admin/login - Admin login
admin.post('/login', loginRateLimit, async (c) => {
	try {
		const body = await c.req.json();
		const { passkey } = body as { passkey?: string };

		if (!passkey) {
			return c.json({ error: 'bad_request', message: 'Passkey is required' }, 400);
		}

		const passkeyDigest = createHash('sha256').update(passkey).digest();
		const isValidPasskey = timingSafeEqual(passkeyDigest, ADMIN_PASSKEY_DIGEST);

		if (!isValidPasskey) {
			return c.json({ error: 'unauthorized', message: 'Invalid passkey' }, 401);
		}

		const token = await createSession({
			userId: 'admin',
			username: 'admin',
			role: 'admin'
		});
		setSessionCookie(c, token);
		resetLoginAttempts(c);

		return c.json({ success: true });
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err && (err.name === 'SyntaxError' || err.code === 'ERR_INVALID_ARG_TYPE')) {
			return c.json({ error: 'bad_request', message: 'Invalid request body' }, 400);
		}

		console.error('Failed to process admin login');
		if (error instanceof Error) {
			console.error(error.stack || error.message);
		} else {
			console.error(error);
		}
		return c.json({ error: 'internal_error', message: 'Failed to process login' }, 500);
	}
});

// POST /api/admin/logout - Admin logout
admin.post('/logout', async (c) => {
	clearSessionCookie(c);
	return c.json({ success: true });
});

// GET /api/admin/session - Check admin session
admin.get('/session', async (c) => {
	const token = getSessionToken(c);

	if (!token) {
		return c.json({ authenticated: false });
	}

	const session = await verifySession(token);

	if (!session) {
		clearSessionCookie(c);
		return c.json({ authenticated: false });
	}

	return c.json({ authenticated: true });
});

// GET /api/admin/puzzles - List all puzzles for admin
admin.get('/puzzles', requireAuth, async (c) => {
	try {
		const puzzleList = await listPuzzles();
		return c.json({ puzzles: puzzleList });
	} catch (error) {
		console.error('Failed to list puzzles for admin', error);
		return c.json({ error: 'internal_error', message: 'Failed to list puzzles' }, 500);
	}
});

// POST /api/admin/puzzles - Create new puzzle (protected)
admin.post('/puzzles', requireAuth, async (c) => {
	let puzzleDirCreated = false;
	let id = '';

	try {
		const formData = await c.req.formData();
		const name = formData.get('name');
		const pieceCountStr = formData.get('pieceCount');
		const aspectRatioStr = formData.get('aspectRatio');
		const image = formData.get('image') as File | string | null;

		// Validate required fields
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
		if (!Number.isInteger(pieceCount) || !isValidPieceCount(pieceCount, aspectRatio)) {
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

		// Validate optional category
		const categoryStr = formData.get('category');
		let category: PuzzleCategory | undefined;
		if (categoryStr && typeof categoryStr === 'string' && categoryStr.trim().length > 0) {
			const trimmedCategory = categoryStr.trim();
			if (!(PUZZLE_CATEGORIES as readonly string[]).includes(trimmedCategory)) {
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

		// Validate file size
		if (image.size > MAX_FILE_SIZE) {
			return c.json({ error: 'bad_request', message: 'File size exceeds 10MB limit' }, 400);
		}

		// Validate file type via magic bytes instead of trusting image.type
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
		// If dimensions can't be parsed, proceed — the generator will use actual pixel dimensions

		// Generate puzzle ID
		id = crypto.randomUUID();

		// Read image buffer
		const imageBuffer = Buffer.from(await image.arrayBuffer());

		// Persist original image for the /reference endpoint using detected type
		await mkdir(getPuzzleDir(id), { recursive: true });
		puzzleDirCreated = true;
		await writeFile(getOriginalImagePath(id, detectedType), imageBuffer);

		// Generate puzzle pieces and thumbnail
		const result = await generatePuzzle({
			id,
			name: trimmedName,
			pieceCount,
			aspectRatio,
			imageBuffer,
			outputDir: `${DATA_DIR}/puzzles`
		});

		// Save puzzle metadata
		const puzzleToStore = category ? { ...result.puzzle, category } : result.puzzle;
		const saved = await storePuzzle(puzzleToStore);
		if (!saved) {
			const cleaned = await deleteStoredPuzzle(id);
			if (!cleaned) {
				console.error(`Failed to clean up puzzle directory ${id} after metadata save failure`);
			}
			return c.json({ error: 'internal_error', message: 'Failed to save puzzle metadata' }, 500);
		}

		return c.json(puzzleToStore, 201);
	} catch (error) {
		console.error('Error creating puzzle:', error);
		// Clean up the puzzle directory if it was created before the failure
		if (puzzleDirCreated) {
			try {
				await deleteStoredPuzzle(id);
			} catch (cleanupError) {
				console.error('Failed to clean up puzzle directory after error:', cleanupError);
			}
		}
		return c.json({ error: 'internal_error', message: 'Failed to create puzzle' }, 500);
	}
});

// DELETE /api/admin/puzzles/:id - Delete puzzle (protected)
admin.delete('/puzzles/:id', requireAuth, async (c) => {
	const id = c.req.param('id');

	const exists = await puzzleExists(id);

	if (!exists) {
		return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
	}

	const deleted = await deleteStoredPuzzle(id);

	if (!deleted) {
		return c.json({ error: 'internal_error', message: 'Failed to delete puzzle' }, 500);
	}

	return c.body(null, 204);
});

export default admin;
