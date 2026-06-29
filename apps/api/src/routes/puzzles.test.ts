/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted — must appear before any imports that use the mocked modules.
vi.mock('../db', () => ({
	getDb: vi.fn(() => ({}))
}));

vi.mock('node:fs/promises', () => ({
	readFile: vi.fn(),
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined)
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
		listPuzzlesPage: vi.fn(),
		getThumbnailPath: vi.fn().mockReturnValue('/fake/thumbnail.jpg'),
		getPieceImagePath: vi.fn().mockReturnValue('/fake/pieces/0.png'),
		getOriginalImagePath: vi.fn().mockReturnValue('/fake/original.jpg'),
		getPuzzleDir: vi.fn().mockReturnValue('/fake/data/puzzles/test-id'),
		findOriginalImagePath: vi.fn().mockReturnValue('/fake/original.jpg'),
		createPuzzle: vi.fn().mockResolvedValue(true),
		deletePuzzle: vi.fn().mockResolvedValue(true),
		InvalidPuzzleIdError
	};
});

vi.mock('../services/player-auth', () => ({
	getPlayerSession: vi.fn()
}));

vi.mock('../services/puzzle-generator', () => ({
	generatePuzzle: vi.fn(),
	isValidPieceCount: vi.fn().mockReturnValue(true)
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	return {
		...actual,
		insertPuzzleOwnership: vi.fn().mockResolvedValue(undefined),
		deletePuzzleOwnership: vi.fn().mockResolvedValue(undefined)
	};
});

import puzzles from './puzzles';
import * as storage from '../services/storage';
import * as fsPromises from 'node:fs/promises';
import * as playerAuth from '../services/player-auth';
import * as puzzleGenerator from '../services/puzzle-generator';
import { insertPuzzleOwnership } from '@perseus/shared';

const PUZZLE_ID = 'test-puzzle-abc';
// Minimal valid PNG: 8-byte signature + 13-byte IHDR chunk (width=3, height=4, 3:4 ratio)
// PNG layout: [signature 8B][length 4B][IHDR 4B][width 4B][height 4B][depth+color+compress+filter+interlace 5B][CRC 4B]
const PNG_HEADER = new Uint8Array([
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
	0x0d, // IHDR chunk length = 13
	0x49,
	0x48,
	0x44,
	0x52, // "IHDR"
	0x00,
	0x00,
	0x00,
	0x03, // width = 3
	0x00,
	0x00,
	0x00,
	0x04, // height = 4
	0x08,
	0x02,
	0x00,
	0x00,
	0x00, // bit depth=8, color type=2 (RGB), compression=0, filter=0, interlace=0
	0x45,
	0x48,
	0xcc,
	0x42 // CRC
]);

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

// ─── POST / ───────────────────────────────────────────────────────────────────

describe('POST / - Upload puzzle for player', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns 401 when the player session cookie is missing', async () => {
		const formData = new FormData();
		formData.append('name', 'Player Puzzle');
		formData.append('pieceCount', '48');
		formData.append('aspectRatio', '3:4');
		formData.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'test.png');

		const res = await puzzles.fetch(
			new Request('http://localhost/', {
				method: 'POST',
				body: formData
			})
		);

		expect(res.status).toBe(401);
		const body = (await res.json()) as any;
		expect(body).toEqual({
			error: 'unauthorized',
			message: 'Player authentication required'
		});
		expect(storage.createPuzzle).not.toHaveBeenCalled();
	});

	it('creates a puzzle when the player session is valid', async () => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue({
			sessionHash: 'session-hash',
			user: {
				id: 'player-1',
				email: 'player@example.com',
				createdAt: 1000,
				lastLoginAt: 2000
			},
			createdAt: 2000,
			expiresAt: Date.now() + 1000
		});
		const generatedPuzzle = makePuzzle({
			id: 'generated-id',
			name: 'Player Puzzle',
			pieceCount: 48,
			aspectRatio: '3:4',
			status: undefined
		});
		vi.mocked(puzzleGenerator.generatePuzzle).mockResolvedValue({
			puzzle: generatedPuzzle,
			pieces: generatedPuzzle.pieces
		} as any);
		vi.mocked(storage.createPuzzle).mockResolvedValue(true);

		const formData = new FormData();
		formData.append('name', 'Player Puzzle');
		formData.append('pieceCount', '48');
		formData.append('aspectRatio', '3:4');
		formData.append('category', 'Art');
		formData.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'test.png');

		const res = await puzzles.fetch(
			new Request('http://localhost/', {
				method: 'POST',
				headers: { Cookie: 'perseus_player_session=player-token' },
				body: formData
			})
		);

		expect(res.status).toBe(201);
		const body = (await res.json()) as any;
		expect(playerAuth.getPlayerSession).toHaveBeenCalledWith('player-token');
		expect(puzzleGenerator.generatePuzzle).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'Player Puzzle',
				pieceCount: 48,
				aspectRatio: '3:4'
			})
		);
		expect(storage.createPuzzle).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'Player Puzzle',
				pieceCount: 48,
				aspectRatio: '3:4',
				category: 'Art'
			})
		);
		expect(insertPuzzleOwnership).toHaveBeenCalledTimes(1);
		expect(insertPuzzleOwnership).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				ownerId: 'player-1',
				name: 'Player Puzzle',
				pieceCount: 48,
				category: 'Art',
				status: 'ready'
			})
		);
		expect(body).toEqual(expect.objectContaining({ name: 'Player Puzzle', category: 'Art' }));
	});

	it('returns 500 and cleans up when ownership insert fails', async () => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue({
			sessionHash: 'session-hash',
			user: {
				id: 'player-1',
				email: 'player@example.com',
				createdAt: 1000,
				lastLoginAt: 2000
			},
			createdAt: 2000,
			expiresAt: Date.now() + 1000
		});
		const generatedPuzzle = makePuzzle({ name: 'Player Puzzle' });
		vi.mocked(puzzleGenerator.generatePuzzle).mockResolvedValue({
			puzzle: generatedPuzzle,
			pieces: generatedPuzzle.pieces
		} as any);
		vi.mocked(storage.createPuzzle).mockResolvedValue(true);
		vi.mocked(insertPuzzleOwnership).mockRejectedValue(new Error('DB down'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const formData = new FormData();
		formData.append('name', 'Player Puzzle');
		formData.append('pieceCount', '48');
		formData.append('aspectRatio', '3:4');
		formData.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'test.png');

		const res = await puzzles.fetch(
			new Request('http://localhost/', {
				method: 'POST',
				headers: { Cookie: 'perseus_player_session=player-token' },
				body: formData
			})
		);

		expect(res.status).toBe(500);
		expect(((await res.json()) as any).message).toBe('Failed to record puzzle ownership');
		expect(storage.deletePuzzle).toHaveBeenCalled();
		consoleSpy.mockRestore();
		vi.mocked(insertPuzzleOwnership).mockResolvedValue(undefined);
	});

	it('logs when cleanup also fails after ownership insert failure', async () => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue({
			sessionHash: 'session-hash',
			user: {
				id: 'player-1',
				email: 'player@example.com',
				createdAt: 1000,
				lastLoginAt: 2000
			},
			createdAt: 2000,
			expiresAt: Date.now() + 1000
		});
		const generatedPuzzle = makePuzzle({ name: 'Player Puzzle' });
		vi.mocked(puzzleGenerator.generatePuzzle).mockResolvedValue({
			puzzle: generatedPuzzle,
			pieces: generatedPuzzle.pieces
		} as any);
		vi.mocked(storage.createPuzzle).mockResolvedValue(true);
		vi.mocked(insertPuzzleOwnership).mockRejectedValue(new Error('DB down'));
		// deletePuzzle returns false → the cleanup-failure console.error branch fires
		vi.mocked(storage.deletePuzzle).mockResolvedValue(false);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const formData = new FormData();
		formData.append('name', 'Player Puzzle');
		formData.append('pieceCount', '48');
		formData.append('aspectRatio', '3:4');
		formData.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'test.png');

		const res = await puzzles.fetch(
			new Request('http://localhost/', {
				method: 'POST',
				headers: { Cookie: 'perseus_player_session=player-token' },
				body: formData
			})
		);

		expect(res.status).toBe(500);
		expect(storage.deletePuzzle).toHaveBeenCalled();
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Failed to clean up puzzle directory')
		);
		consoleSpy.mockRestore();
		vi.mocked(insertPuzzleOwnership).mockResolvedValue(undefined);
		vi.mocked(storage.deletePuzzle).mockResolvedValue(true);
	});
});

// ─── POST / - Validation rejections ─────────────────────────────────────────

describe('POST / - Validation rejections', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue({
			sessionHash: 'session-hash',
			user: {
				id: 'player-1',
				email: 'player@example.com',
				createdAt: 1000,
				lastLoginAt: 2000
			},
			createdAt: 2000,
			expiresAt: Date.now() + 1000
		});
		(puzzleGenerator.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
	});

	function buildForm(overrides: Record<string, any> = {}): FormData {
		const fd = new FormData();
		fd.append('name', overrides.name ?? 'Player Puzzle');
		fd.append('pieceCount', String(overrides.pieceCount ?? 48));
		fd.append('aspectRatio', overrides.aspectRatio ?? '3:4');
		if (overrides.category !== undefined) fd.append('category', overrides.category);
		fd.append(
			'image',
			overrides.image ?? new Blob([PNG_HEADER], { type: 'image/png' }),
			'test.png'
		);
		return fd;
	}

	async function post(fd: FormData): Promise<Response> {
		return puzzles.fetch(
			new Request('http://localhost/', {
				method: 'POST',
				headers: { Cookie: 'perseus_player_session=player-token' },
				body: fd
			})
		);
	}

	it('rejects when name is missing', async () => {
		const res = await post(buildForm({ name: '' }));
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).message).toContain('Name is required');
	});

	it('rejects when name exceeds 255 characters', async () => {
		const res = await post(buildForm({ name: 'x'.repeat(256) }));
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).message).toContain('255 characters');
	});

	it('rejects when pieceCount is missing', async () => {
		const fd = new FormData();
		fd.append('name', 'No Pieces');
		fd.append('aspectRatio', '3:4');
		fd.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'test.png');
		const res = await post(fd);
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).message).toContain('Piece count is required');
	});

	it('rejects when aspectRatio is invalid', async () => {
		const res = await post(buildForm({ aspectRatio: '5:6' }));
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).message).toContain('Invalid aspect ratio');
	});

	it('rejects when pieceCount is invalid for aspect ratio', async () => {
		(puzzleGenerator.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(false);
		const res = await post(buildForm({ pieceCount: 50, aspectRatio: '1:1' }));
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).message).toContain('Invalid piece count for 1:1');
	});

	it('rejects when image is missing', async () => {
		const fd = new FormData();
		fd.append('name', 'No Image');
		fd.append('pieceCount', '48');
		fd.append('aspectRatio', '3:4');
		const res = await post(fd);
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).message).toContain('Image file is required');
	});

	it('rejects when category is invalid', async () => {
		const res = await post(buildForm({ category: 'Bogus' }));
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).message).toContain('Invalid category');
	});

	it('rejects when file size exceeds 10MB', async () => {
		const oversized = new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/png' });
		const res = await post(buildForm({ image: oversized }));
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).message).toContain('10MB');
	});

	it('rejects when magic bytes do not match any allowed type', async () => {
		const textBlob = new Blob([new TextEncoder().encode('not an image')], {
			type: 'image/png'
		});
		const res = await post(buildForm({ image: textBlob }));
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).message).toContain('Invalid file type');
	});

	it('rejects when image aspect ratio does not match requested ratio', async () => {
		// 4x4 PNG (1:1) requested as 3:4 — should reject
		const squarePng = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
			0x52, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x04, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00,
			0x00, 0x00, 0x00, 0x00
		]);
		const res = await post(buildForm({ image: new Blob([squarePng], { type: 'image/png' }) }));
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).message).toContain('aspect ratio');
	});

	it('returns 400 when form data cannot be parsed', async () => {
		const res = await puzzles.fetch(
			new Request('http://localhost/', {
				method: 'POST',
				headers: {
					Cookie: 'perseus_player_session=player-token',
					'Content-Type': 'application/json'
				},
				body: '{"name":"oops"}'
			})
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).message).toBe('Invalid form data');
	});
});

// ─── POST / - Resource rollback ─────────────────────────────────────────────

describe('POST / - Resource rollback', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue({
			sessionHash: 'session-hash',
			user: {
				id: 'player-1',
				email: 'player@example.com',
				createdAt: 1000,
				lastLoginAt: 2000
			},
			createdAt: 2000,
			expiresAt: Date.now() + 1000
		});
		(puzzleGenerator.isValidPieceCount as ReturnType<typeof vi.fn>).mockReturnValue(true);
		vi.mocked(storage.createPuzzle).mockResolvedValue(true);
		vi.mocked(storage.deletePuzzle).mockResolvedValue(true);
	});

	function buildForm(): FormData {
		const fd = new FormData();
		fd.append('name', 'Rollback Puzzle');
		fd.append('pieceCount', '48');
		fd.append('aspectRatio', '3:4');
		fd.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'test.png');
		return fd;
	}

	async function post(fd: FormData): Promise<Response> {
		return puzzles.fetch(
			new Request('http://localhost/', {
				method: 'POST',
				headers: { Cookie: 'perseus_player_session=player-token' },
				body: fd
			})
		);
	}

	it('returns 500 and cleans up when generatePuzzle throws', async () => {
		vi.mocked(puzzleGenerator.generatePuzzle).mockRejectedValue(new Error('generator down'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await post(buildForm());

		expect(res.status).toBe(500);
		expect(((await res.json()) as any).error).toBe('internal_error');
		expect(storage.deletePuzzle).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it('returns 500 and cleans up when storePuzzle returns false', async () => {
		const generatedPuzzle = makePuzzle({ name: 'Rollback Puzzle' });
		vi.mocked(puzzleGenerator.generatePuzzle).mockResolvedValue({
			puzzle: generatedPuzzle,
			pieces: generatedPuzzle.pieces
		} as any);
		vi.mocked(storage.createPuzzle).mockResolvedValue(false);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await post(buildForm());

		expect(res.status).toBe(500);
		expect(((await res.json()) as any).message).toBe('Failed to save puzzle metadata');
		expect(storage.deletePuzzle).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it('returns 500 and logs cleanup failure when deletePuzzle throws', async () => {
		vi.mocked(puzzleGenerator.generatePuzzle).mockRejectedValue(new Error('generator down'));
		vi.mocked(storage.deletePuzzle).mockRejectedValue(new Error('cleanup also failed'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await post(buildForm());

		expect(res.status).toBe(500);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Failed to clean up puzzle directory after error:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('returns 500 when writeFile fails on image persistence', async () => {
		vi.mocked(fsPromises.writeFile).mockRejectedValue(new Error('disk full'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await post(buildForm());

		expect(res.status).toBe(500);
		expect(((await res.json()) as any).error).toBe('internal_error');
		consoleSpy.mockRestore();
	});
});

// ─── GET / ────────────────────────────────────────────────────────────────────

describe('GET / - List puzzles', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns paginated puzzle data on success', async () => {
		const mockResult = {
			puzzles: [{ id: PUZZLE_ID, name: 'Test', pieceCount: 4 }],
			total: 1,
			offset: 5,
			limit: 20
		};
		vi.mocked(storage.listPuzzlesPage).mockResolvedValue(mockResult as any);

		const res = await puzzles.fetch(
			new Request('http://localhost/?q=test&category=Animals&offset=5&limit=20')
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body).toEqual(mockResult);
		expect(storage.listPuzzlesPage).toHaveBeenCalledWith({
			q: 'test',
			category: 'Animals',
			offset: 5,
			limit: 20
		});
	});

	it('rejects offset with trailing non-numeric characters', async () => {
		vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
			puzzles: [],
			total: 0,
			offset: 0,
			limit: 20
		} as any);

		const res = await puzzles.fetch(new Request('http://localhost/?offset=10abc'));
		expect(res.status).toBe(200);
		expect(storage.listPuzzlesPage).toHaveBeenCalledWith(
			expect.objectContaining({
				offset: 0,
				limit: 20
			})
		);
	});

	it('rejects limit with trailing non-numeric characters', async () => {
		vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
			puzzles: [],
			total: 0,
			offset: 0,
			limit: 20
		} as any);

		const res = await puzzles.fetch(new Request('http://localhost/?limit=5foo'));
		expect(res.status).toBe(200);
		expect(storage.listPuzzlesPage).toHaveBeenCalledWith(
			expect.objectContaining({
				offset: 0,
				limit: 20
			})
		);
	});

	it('rejects decimal offset and limit values', async () => {
		vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
			puzzles: [],
			total: 0,
			offset: 0,
			limit: 20
		} as any);

		const res = await puzzles.fetch(new Request('http://localhost/?offset=3.5&limit=7.9'));
		expect(res.status).toBe(200);
		expect(storage.listPuzzlesPage).toHaveBeenCalledWith(
			expect.objectContaining({
				offset: 0,
				limit: 20
			})
		);
	});

	it('rejects scientific notation offset and limit', async () => {
		vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
			puzzles: [],
			total: 0,
			offset: 0,
			limit: 20
		} as any);

		const res = await puzzles.fetch(new Request('http://localhost/?offset=1e2&limit=2e1'));
		expect(res.status).toBe(200);
		expect(storage.listPuzzlesPage).toHaveBeenCalledWith(
			expect.objectContaining({
				offset: 0,
				limit: 20
			})
		);
	});

	it('rejects hex offset and limit', async () => {
		vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
			puzzles: [],
			total: 0,
			offset: 0,
			limit: 20
		} as any);

		const res = await puzzles.fetch(new Request('http://localhost/?offset=0x10&limit=0xff'));
		expect(res.status).toBe(200);
		expect(storage.listPuzzlesPage).toHaveBeenCalledWith(
			expect.objectContaining({
				offset: 0,
				limit: 20
			})
		);
	});

	it('rejects whitespace-padded offset and limit', async () => {
		vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
			puzzles: [],
			total: 0,
			offset: 0,
			limit: 20
		} as any);

		const res = await puzzles.fetch(new Request('http://localhost/?offset=%2010%20&limit=%205%20'));
		expect(res.status).toBe(200);
		expect(storage.listPuzzlesPage).toHaveBeenCalledWith(
			expect.objectContaining({
				offset: 0,
				limit: 20
			})
		);
	});

	it('returns 500 with internal_error when listPuzzlesPage throws', async () => {
		vi.mocked(storage.listPuzzlesPage).mockRejectedValue(new Error('DB error'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request('http://localhost/'));
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toContain('Failed to list puzzles');
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

	it('returns 404 when puzzle ready flag is false', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle({ ready: false }));

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toBe('Puzzle not found');
		expect(storage.findOriginalImagePath).not.toHaveBeenCalled();
	});

	it('returns 404 when puzzle status is not ready', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle({ status: 'processing' }));

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as any;
		expect(body.error).toBe('not_found');
		expect(body.message).toBe('Puzzle not found');
		expect(storage.findOriginalImagePath).not.toHaveBeenCalled();
	});

	it('returns 200 when puzzle has neither ready flag nor status', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle({ status: undefined }));
		vi.mocked(storage.findOriginalImagePath).mockReturnValue('/fake/original.jpg');

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}`));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.hasReference).toBe(true);
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

	it('returns 200 when puzzle has neither ready flag nor status (legacy Bun shape treated as ready)', async () => {
		vi.mocked(storage.getPuzzle).mockResolvedValue(makePuzzle({ status: undefined }));
		vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from([1, 2, 3]) as any);

		const res = await puzzles.fetch(new Request(`http://localhost/${PUZZLE_ID}/reference`));
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/jpeg');
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
