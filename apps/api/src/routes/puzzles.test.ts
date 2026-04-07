/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted — must appear before any imports that use the mocked modules.
vi.mock('node:fs/promises', () => ({
	readFile: vi.fn()
}));

vi.mock('../services/storage', () => {
	class InvalidPuzzleIdError extends Error {
		constructor(message = 'Invalid puzzleId') {
			super(message);
			this.name = 'InvalidPuzzleIdError';
		}
	}
	return {
		getPuzzle: vi.fn(),
		listPuzzlesSorted: vi.fn(),
		getThumbnailPath: vi.fn().mockReturnValue('/fake/thumbnail.jpg'),
		getPieceImagePath: vi.fn().mockReturnValue('/fake/pieces/0.png'),
		getOriginalImagePath: vi.fn().mockReturnValue('/fake/original.jpg'),
		findOriginalImagePath: vi.fn().mockReturnValue('/fake/original.jpg'),
		InvalidPuzzleIdError
	};
});

import puzzles from './puzzles';
import * as storage from '../services/storage';
import * as fsPromises from 'node:fs/promises';

const PUZZLE_ID = 'test-puzzle-abc';

/** Creates an Error with no stack trace (empty string), forcing `error.stack || error.message` to use message. */
function errorWithoutStack(message: string): Error {
	const err = new Error(message);
	Object.defineProperty(err, 'stack', { value: '', configurable: true });
	return err;
}

function makePuzzle(overrides: Record<string, any> = {}): any {
	return {
		id: PUZZLE_ID,
		name: 'Test Puzzle',
		pieceCount: 4,
		gridCols: 2,
		gridRows: 2,
		imageWidth: 100,
		imageHeight: 100,
		createdAt: Date.now(),
		pieces: [],
		status: 'ready',
		...overrides
	};
}

// ─── GET / ────────────────────────────────────────────────────────────────────

describe('GET / - List puzzles', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns 200 with puzzle list on success', async () => {
		const mockList = [{ id: PUZZLE_ID, name: 'Test', pieceCount: 4 }];
		vi.mocked(storage.listPuzzlesSorted).mockResolvedValue(mockList as any);

		const res = await puzzles.fetch(new Request('http://localhost/'));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.puzzles).toHaveLength(1);
		expect(body.puzzles[0].id).toBe(PUZZLE_ID);
	});

	it('returns empty puzzles array when no puzzles exist', async () => {
		vi.mocked(storage.listPuzzlesSorted).mockResolvedValue([]);

		const res = await puzzles.fetch(new Request('http://localhost/'));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.puzzles).toEqual([]);
	});

	it('returns 500 with internal_error when listPuzzlesSorted throws', async () => {
		vi.mocked(storage.listPuzzlesSorted).mockRejectedValue(new Error('DB error'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request('http://localhost/'));
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toContain('Failed to list puzzles');
		consoleSpy.mockRestore();
	});

	it('logs error details when listPuzzlesSorted throws an Error', async () => {
		const err = new Error('something broke');
		vi.mocked(storage.listPuzzlesSorted).mockRejectedValue(err);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await puzzles.fetch(new Request('http://localhost/'));
		expect(consoleSpy).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it('uses error.message when error.stack is empty (line 31 || branch)', async () => {
		vi.mocked(storage.listPuzzlesSorted).mockRejectedValue(errorWithoutStack('no-stack message'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request('http://localhost/'));
		expect(res.status).toBe(500);
		expect(consoleSpy).toHaveBeenCalledWith('no-stack message');
		consoleSpy.mockRestore();
	});

	it('logs non-Error exceptions when listPuzzlesSorted throws a string', async () => {
		vi.mocked(storage.listPuzzlesSorted).mockRejectedValue('string error');
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request('http://localhost/'));
		expect(res.status).toBe(500);
		expect(consoleSpy).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────

describe('GET /:id - Get puzzle by ID', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns 200 with puzzle data when found', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		vi.mocked(storage.findOriginalImagePath).mockReturnValue('/fake/original.jpg');

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}`));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.id).toBe(PUZZLE_ID);
		expect(body.name).toBe('Test Puzzle');
		expect(body.hasReference).toBe(true);
	});

	it('returns hasReference false when no original image exists', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		vi.mocked(storage.findOriginalImagePath).mockReturnValue(null);

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}`));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.hasReference).toBe(false);
	});

	it('returns hasReference false when findOriginalImagePath throws', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		vi.mocked(storage.findOriginalImagePath).mockImplementation(() => {
			throw new (storage as any).InvalidPuzzleIdError('bad id');
		});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}`));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.hasReference).toBe(false);
	});

	it('returns 404 with not_found when puzzle does not exist', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(null);

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toContain('Puzzle not found');
	});

	it('returns 500 when getPuzzle throws', async () => {
		vi.mocked(storage.getPuzzle).mockRejectedValue(new Error('Storage failure'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}`));
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		consoleSpy.mockRestore();
	});

	it('uses error.message when error.stack is empty in GET /:id (line 49 || branch)', async () => {
		vi.mocked(storage.getPuzzle).mockRejectedValue(errorWithoutStack('no-stack-get-id'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}`));
		expect(res.status).toBe(500);
		expect(consoleSpy).toHaveBeenCalledWith('no-stack-get-id');
		consoleSpy.mockRestore();
	});

	it('logs non-Error exceptions when getPuzzle throws a non-Error value', async () => {
		vi.mocked(storage.getPuzzle).mockRejectedValue({ code: 'UNKNOWN' });
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}`));
		expect(res.status).toBe(500);
		expect(consoleSpy).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});
});

// ─── GET /:id/thumbnail ───────────────────────────────────────────────────────

describe('GET /:id/thumbnail - Get thumbnail image', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(storage.getThumbnailPath).mockReturnValue('/fake/thumbnail.jpg');
	});

	it('returns 200 with image data and jpeg content-type for .jpg', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		vi.mocked(storage.getThumbnailPath).mockReturnValue('/fake/thumbnail.jpg');
		vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from([0xff, 0xd8]) as any);

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/thumbnail`));
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/jpeg');
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
	});

	it('returns image/jpeg for .jpeg extension', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		vi.mocked(storage.getThumbnailPath).mockReturnValue('/fake/thumbnail.jpeg');
		vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from([1, 2, 3]) as any);

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/thumbnail`));
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/jpeg');
	});

	it('returns image/png for .png extension', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		vi.mocked(storage.getThumbnailPath).mockReturnValue('/fake/thumbnail.png');
		vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from([0x89, 0x50]) as any);

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/thumbnail`));
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/png');
	});

	it('returns image/webp for .webp extension', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		vi.mocked(storage.getThumbnailPath).mockReturnValue('/fake/thumbnail.webp');
		vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from([1, 2, 3]) as any);

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/thumbnail`));
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/webp');
	});

	it('returns application/octet-stream for unknown extension', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		vi.mocked(storage.getThumbnailPath).mockReturnValue('/fake/thumbnail.bin');
		vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from([1, 2, 3]) as any);

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/thumbnail`));
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
	});

	it('returns 404 when puzzle is not found', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(null);

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/thumbnail`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toContain('Puzzle not found');
	});

	it('returns 404 when thumbnail file not found (ENOENT)', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		const enoentError = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
		vi.mocked(fsPromises.readFile).mockRejectedValue(enoentError);

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/thumbnail`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toBe('Thumbnail not found');
	});

	it('returns 404 when getThumbnailPath throws InvalidPuzzleIdError', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		vi.mocked(storage.getThumbnailPath).mockImplementation(() => {
			throw new (storage as any).InvalidPuzzleIdError('bad id');
		});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/thumbnail`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toBe('Thumbnail not found');
	});

	it('uses error.message when error.stack is empty in thumbnail handler (line 86 || branch)', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		vi.mocked(fsPromises.readFile).mockRejectedValue(errorWithoutStack('no-stack-thumbnail'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/thumbnail`));
		expect(res.status).toBe(500);
		expect(consoleSpy).toHaveBeenCalledWith('no-stack-thumbnail');
		consoleSpy.mockRestore();
	});

	it('returns 500 when readFile throws an unexpected error', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		vi.mocked(fsPromises.readFile).mockRejectedValue(new Error('permission denied'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/thumbnail`));
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toContain('Failed to retrieve thumbnail');
		consoleSpy.mockRestore();
	});

	it('logs non-Error exceptions in thumbnail error handler', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		vi.mocked(fsPromises.readFile).mockRejectedValue('raw string error');
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/thumbnail`));
		expect(res.status).toBe(500);
		expect(consoleSpy).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});
});

// ─── GET /:id/pieces/:pieceId/image ──────────────────────────────────────────

describe('GET /:id/pieces/:pieceId/image - Get piece image', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(storage.getPieceImagePath).mockReturnValue('/fake/pieces/0.png');
	});

	it('returns 200 with PNG image data for valid piece', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle({ pieceCount: 4 }));
		vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from([0x89, 0x50]) as any);

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/pieces/0/image`));
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/png');
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
	});

	it('returns 200 for last valid pieceId (pieceCount - 1)', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle({ pieceCount: 4 }));
		vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from([1, 2, 3]) as any);

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/pieces/3/image`));
		expect(res.status).toBe(200);
	});

	it('returns 400 with invalid_piece_id for non-numeric pieceId', async () => {
		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/pieces/abc/image`));
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBe('invalid_piece_id');
		expect(body.message).toContain('Invalid piece ID');
	});

	it('returns 400 for negative pieceId', async () => {
		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/pieces/-1/image`));
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBe('invalid_piece_id');
	});

	it('returns 500 when getPuzzle throws during piece image request', async () => {
		vi.mocked(storage.getPuzzle).mockRejectedValue(new Error('Storage error'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/pieces/0/image`));
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		consoleSpy.mockRestore();
	});

	it('uses error.message when error.stack is empty in piece image getPuzzle catch (line 111 || branch)', async () => {
		vi.mocked(storage.getPuzzle).mockRejectedValue(errorWithoutStack('no-stack-get-puzzle'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/pieces/0/image`));
		expect(res.status).toBe(500);
		expect(consoleSpy).toHaveBeenCalledWith('no-stack-get-puzzle');
		consoleSpy.mockRestore();
	});

	it('returns 404 when puzzle not found for piece image request', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(null);

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/pieces/0/image`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toBe('Puzzle not found');
	});

	it('returns 404 when pieceId equals pieceCount (out of bounds)', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle({ pieceCount: 4 }));

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/pieces/4/image`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toBe('Piece not found');
	});

	it('returns 404 when pieceId exceeds pieceCount', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle({ pieceCount: 4 }));

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/pieces/99/image`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toBe('Piece not found');
	});

	it('returns 404 when piece image file not found (ENOENT)', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle({ pieceCount: 4 }));
		const enoentError = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
		vi.mocked(fsPromises.readFile).mockRejectedValue(enoentError);

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/pieces/0/image`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toBe('Piece image not found');
	});

	it('returns 404 when getPieceImagePath throws InvalidPuzzleIdError', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle({ pieceCount: 4 }));
		vi.mocked(storage.getPieceImagePath).mockImplementation(() => {
			throw new (storage as any).InvalidPuzzleIdError('bad id');
		});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/pieces/0/image`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toBe('Piece image not found');
	});

	it('returns 500 when readFile throws an unexpected error for piece image', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle({ pieceCount: 4 }));
		vi.mocked(fsPromises.readFile).mockRejectedValue(new Error('disk error'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/pieces/0/image`));
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toContain('Failed to retrieve piece image');
		consoleSpy.mockRestore();
	});

	it('uses error.message when error.stack is empty in piece image readFile catch (line 140 || branch)', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle({ pieceCount: 4 }));
		vi.mocked(fsPromises.readFile).mockRejectedValue(errorWithoutStack('no-stack-readfile'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/pieces/0/image`));
		expect(res.status).toBe(500);
		expect(consoleSpy).toHaveBeenCalledWith('no-stack-readfile');
		consoleSpy.mockRestore();
	});

	it('logs non-Error exceptions in piece image error handler', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle({ pieceCount: 4 }));
		vi.mocked(fsPromises.readFile).mockRejectedValue('string error');
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/pieces/0/image`));
		expect(res.status).toBe(500);
		expect(consoleSpy).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it('logs non-Error when getPuzzle throws a non-Error in piece image handler (line 113)', async () => {
		vi.mocked(storage.getPuzzle).mockRejectedValue('non-error string from getPuzzle');
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/pieces/0/image`));
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Failed to retrieve puzzle');
		expect(consoleSpy).toHaveBeenCalledWith('non-error string from getPuzzle');
		consoleSpy.mockRestore();
	});
});

// ─── GET /:id/reference ───────────────────────────────────────────────────────

describe('GET /:id/reference - Get reference image', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(storage.findOriginalImagePath).mockReturnValue('/fake/original.jpg');
	});

	it.each([
		{ ext: '.jpg', contentType: 'image/jpeg' },
		{ ext: '.jpeg', contentType: 'image/jpeg' },
		{ ext: '.png', contentType: 'image/png' },
		{ ext: '.webp', contentType: 'image/webp' },
		{ ext: '.bin', contentType: 'application/octet-stream' }
	] satisfies Array<{ ext: string; contentType: string }>)(
		'returns 200 with $contentType for $ext extension',
		async ({ ext, contentType }) => {
			vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
			vi.mocked(storage.findOriginalImagePath).mockReturnValue(`/fake/original${ext}`);
			vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from([1, 2, 3]) as any);

			const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/reference`));
			expect(res.status).toBe(200);
			expect(res.headers.get('Content-Type')).toBe(contentType);
			expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
		}
	);

	it('returns 404 when puzzle is not found', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(null);

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/reference`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toContain('Puzzle not found');
	});

	it('returns 404 when puzzle ready flag is false', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle({ ready: false }));

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/reference`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toBe('Puzzle not found');
		expect(storage.findOriginalImagePath).not.toHaveBeenCalled();
		expect(fsPromises.readFile).not.toHaveBeenCalled();
	});

	it('returns 404 when puzzle status is not ready', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle({ status: 'processing' }));

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/reference`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toBe('Puzzle not found');
		expect(storage.findOriginalImagePath).not.toHaveBeenCalled();
		expect(fsPromises.readFile).not.toHaveBeenCalled();
	});

	it('returns 404 when puzzle has neither ready flag nor status (fail-closed)', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle({ status: undefined }));

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/reference`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toBe('Puzzle not found');
		expect(storage.findOriginalImagePath).not.toHaveBeenCalled();
		expect(fsPromises.readFile).not.toHaveBeenCalled();
	});

	it('returns 404 when original image file not found (ENOENT)', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		const enoentError = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
		vi.mocked(fsPromises.readFile).mockRejectedValue(enoentError);

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/reference`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toBe('Reference image not found');
	});

	it('returns 404 when findOriginalImagePath returns null', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		vi.mocked(storage.findOriginalImagePath).mockReturnValue(null);

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/reference`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toBe('Reference image not found');
	});

	it('returns 404 when findOriginalImagePath throws InvalidPuzzleIdError', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		vi.mocked(storage.findOriginalImagePath).mockImplementation(() => {
			throw new (storage as any).InvalidPuzzleIdError('bad id');
		});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/reference`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toBe('Reference image not found');
	});

	it('returns 500 when readFile throws an unexpected error', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		vi.mocked(fsPromises.readFile).mockRejectedValue(new Error('permission denied'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/reference`));
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toContain('Failed to retrieve reference image');
		consoleSpy.mockRestore();
	});

	it('logs non-Error exceptions in reference image error handler', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle());
		vi.mocked(fsPromises.readFile).mockRejectedValue('raw string error');
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/reference`));
		expect(res.status).toBe(500);
		expect(consoleSpy).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});
});
