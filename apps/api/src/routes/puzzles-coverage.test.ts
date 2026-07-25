/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage tests for puzzles.ts (Bun runtime):
 * - rejects when image dimensions cannot be parsed (corrupted or truncated)
 * - cleanup failure log when storePuzzle returns false (line 368)
 * - cleanup failure log when ownership insert fails (line 390)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
		validateImageEndMarker: vi.fn().mockResolvedValue(true),
		insertPuzzleOwnership: vi.fn().mockResolvedValue(undefined),
		deletePuzzleOwnership: vi.fn().mockResolvedValue(undefined)
	};
});

import puzzles from './puzzles';
import * as storage from '../services/storage';
import * as playerAuth from '../services/player-auth';
import * as puzzleGenerator from '../services/puzzle-generator';
import { insertPuzzleOwnership } from '@perseus/shared';

// Minimal valid PNG: 8-byte signature + 13-byte IHDR (width=3, height=4, 3:4 ratio)
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
	0x00, // depth=8, color=2, compress=0, filter=0, interlace=0
	0x45,
	0x48,
	0xcc,
	0x42 // CRC
]);

// PNG with valid magic bytes but truncated (no IHDR data at offset 16).
// detectImageType returns 'image/png' but parseImageDimensions returns null.
const TRUNCATED_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

function makePuzzle(overrides: Record<string, any> = {}): any {
	return {
		id: 'generated-id',
		name: 'Player Puzzle',
		pieceCount: 48,
		aspectRatio: '3:4',
		status: undefined,
		pieces: [],
		...overrides
	};
}

function buildForm(image: Uint8Array = PNG_HEADER): FormData {
	const fd = new FormData();
	fd.append('name', 'Player Puzzle');
	fd.append('pieceCount', '48');
	fd.append('aspectRatio', '3:4');
	fd.append('image', new Blob([image], { type: 'image/png' }), 'test.png');
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

describe('POST / - dimensions parse fallback (line 342)', () => {
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
		vi.mocked(puzzleGenerator.generatePuzzle).mockResolvedValue({
			puzzle: makePuzzle(),
			pieces: []
		} as any);
		vi.mocked(storage.createPuzzle).mockResolvedValue(true);
	});

	it('rejects when image dimensions cannot be parsed', async () => {
		const res = await post(buildForm(TRUNCATED_PNG));

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.message).toBe('Image is corrupted or truncated');
	});
});

describe('POST / - cleanup failure logs', () => {
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
		vi.mocked(puzzleGenerator.generatePuzzle).mockResolvedValue({
			puzzle: makePuzzle(),
			pieces: []
		} as any);
	});

	it('logs cleanup failure when deleteStoredPuzzle returns false after storePuzzle fails (line 368)', async () => {
		vi.mocked(storage.createPuzzle).mockResolvedValue(false);
		vi.mocked(storage.deletePuzzle).mockResolvedValue(false);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await post(buildForm());

		expect(res.status).toBe(500);
		expect(((await res.json()) as any).message).toBe('Failed to save puzzle metadata');
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Failed to clean up puzzle directory')
		);
		consoleSpy.mockRestore();
	});

	it('logs cleanup failure when deleteStoredPuzzle returns false after ownership insert fails (line 390)', async () => {
		vi.mocked(storage.createPuzzle).mockResolvedValue(true);
		vi.mocked(insertPuzzleOwnership).mockRejectedValueOnce(new Error('D1 down'));
		vi.mocked(storage.deletePuzzle).mockResolvedValue(false);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await post(buildForm());

		expect(res.status).toBe(500);
		expect(((await res.json()) as any).message).toBe('Failed to record puzzle ownership');
		// First error: "Failed to record puzzle ownership:" with the Error
		// Second error: cleanup failure log with the directory path
		expect(consoleSpy).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining('after ownership insert failure')
		);
		consoleSpy.mockRestore();
		// Restore the mock so it doesn't leak into other test files
		vi.mocked(insertPuzzleOwnership).mockResolvedValue(undefined);
	});
});

describe('GET /:id – unexpected error in puzzleHasReference (lines 204-205)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('logs and returns hasReference false when findOriginalImagePath throws', async () => {
		// GET /:id calls puzzleHasReference(id) which calls findOriginalImagePath.
		// When findOriginalImagePath throws a non-InvalidPuzzleIdError, the catch
		// block logs the error and returns false.
		vi.mocked(storage.getPuzzle).mockResolvedValue({
			id: 'test-id',
			name: 'Test',
			pieceCount: 4,
			status: 'ready'
		} as any);
		vi.mocked(storage.findOriginalImagePath).mockImplementation(() => {
			throw new Error('Filesystem I/O error');
		});
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await puzzles.fetch(new Request('http://localhost/test-id'));

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.hasReference).toBe(false);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Unexpected error checking reference image'),
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});
});
