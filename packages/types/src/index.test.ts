import { describe, it, expect } from 'vitest';
import {
	validateEdgeConfig,
	isPuzzlePiece,
	validateWorkflowParams,
	createPuzzleProgress,
	validatePuzzleMetadata,
	validatePuzzleMetadataLight,
	TAB_RATIO,
	EXPANSION_FACTOR,
	MAX_IMAGE_DIMENSION,
	MAX_PIECES,
	DEFAULT_PIECE_COUNT,
	THUMBNAIL_SIZE,
	PUZZLE_CATEGORIES
} from './index';

// Helper to create a valid piece
function makePiece(overrides: Record<string, unknown> = {}): unknown {
	return {
		id: 0,
		puzzleId: 'abc-123',
		correctX: 0,
		correctY: 0,
		imagePath: 'pieces/0.png',
		edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' },
		...overrides
	};
}

// Helper to create a valid base metadata
function makeMeta(overrides: Record<string, unknown> = {}): unknown {
	return {
		id: 'some-id',
		name: 'Test Puzzle',
		pieceCount: 1,
		gridCols: 1,
		gridRows: 1,
		imageWidth: 800,
		imageHeight: 600,
		createdAt: Date.now(),
		version: 1,
		status: 'ready',
		pieces: [makePiece()],
		...overrides
	};
}

describe('constants', () => {
	it('TAB_RATIO is 0.2', () => {
		expect(TAB_RATIO).toBe(0.2);
	});

	it('EXPANSION_FACTOR is 1.4', () => {
		expect(EXPANSION_FACTOR).toBe(1.4);
	});

	it('MAX_IMAGE_DIMENSION is 4096', () => {
		expect(MAX_IMAGE_DIMENSION).toBe(4096);
	});

	it('MAX_PIECES is 250', () => {
		expect(MAX_PIECES).toBe(250);
	});

	it('DEFAULT_PIECE_COUNT is 225', () => {
		expect(DEFAULT_PIECE_COUNT).toBe(225);
	});

	it('THUMBNAIL_SIZE is 300', () => {
		expect(THUMBNAIL_SIZE).toBe(300);
	});

	it('PUZZLE_CATEGORIES contains expected values', () => {
		expect(PUZZLE_CATEGORIES).toContain('Animals');
		expect(PUZZLE_CATEGORIES).toContain('Nature');
		expect(PUZZLE_CATEGORIES).toContain('Art');
		expect(PUZZLE_CATEGORIES).toContain('Architecture');
		expect(PUZZLE_CATEGORIES).toContain('Abstract');
		expect(PUZZLE_CATEGORIES).toContain('Food');
		expect(PUZZLE_CATEGORIES).toContain('Travel');
	});
});

describe('validateEdgeConfig', () => {
	it('returns true for valid edge config with all valid types', () => {
		expect(validateEdgeConfig({ top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' })).toBe(
			true
		);
	});

	it('returns true for all-tab edges', () => {
		expect(validateEdgeConfig({ top: 'tab', right: 'tab', bottom: 'tab', left: 'tab' })).toBe(true);
	});

	it('returns true for all-blank edges', () => {
		expect(
			validateEdgeConfig({ top: 'blank', right: 'blank', bottom: 'blank', left: 'blank' })
		).toBe(true);
	});

	it('returns false for null', () => {
		expect(validateEdgeConfig(null)).toBe(false);
	});

	it('returns false for non-object', () => {
		expect(validateEdgeConfig('invalid')).toBe(false);
		expect(validateEdgeConfig(42)).toBe(false);
		expect(validateEdgeConfig(undefined)).toBe(false);
	});

	it('returns false for missing direction', () => {
		expect(validateEdgeConfig({ top: 'flat', right: 'tab', bottom: 'blank' })).toBe(false);
	});

	it('returns false for invalid edge type value', () => {
		expect(
			validateEdgeConfig({ top: 'invalid', right: 'tab', bottom: 'blank', left: 'flat' })
		).toBe(false);
	});

	it('returns false for numeric edge value', () => {
		expect(validateEdgeConfig({ top: 1, right: 'tab', bottom: 'blank', left: 'flat' })).toBe(false);
	});
});

describe('isPuzzlePiece', () => {
	it('returns true for a valid puzzle piece', () => {
		expect(isPuzzlePiece(makePiece())).toBe(true);
	});

	it('returns false for null', () => {
		expect(isPuzzlePiece(null)).toBe(false);
	});

	it('returns false for non-object', () => {
		expect(isPuzzlePiece('string')).toBe(false);
		expect(isPuzzlePiece(42)).toBe(false);
	});

	it('returns false when id is not a number', () => {
		expect(isPuzzlePiece(makePiece({ id: 'not-a-number' }))).toBe(false);
	});

	it('returns false when id is NaN', () => {
		expect(isPuzzlePiece(makePiece({ id: NaN }))).toBe(false);
	});

	it('returns false when id is Infinity', () => {
		expect(isPuzzlePiece(makePiece({ id: Infinity }))).toBe(false);
	});

	it('returns false when puzzleId is not a string', () => {
		expect(isPuzzlePiece(makePiece({ puzzleId: 123 }))).toBe(false);
	});

	it('returns false when correctX is not a number', () => {
		expect(isPuzzlePiece(makePiece({ correctX: 'zero' }))).toBe(false);
	});

	it('returns false when correctX is Infinity', () => {
		expect(isPuzzlePiece(makePiece({ correctX: Infinity }))).toBe(false);
	});

	it('returns false when correctY is NaN', () => {
		expect(isPuzzlePiece(makePiece({ correctY: NaN }))).toBe(false);
	});

	it('returns false when imagePath is not a string', () => {
		expect(isPuzzlePiece(makePiece({ imagePath: null }))).toBe(false);
	});

	it('returns false when edges is invalid', () => {
		expect(
			isPuzzlePiece(
				makePiece({ edges: { top: 'bad', right: 'tab', bottom: 'blank', left: 'flat' } })
			)
		).toBe(false);
	});

	it('returns false when edges is missing', () => {
		expect(isPuzzlePiece(makePiece({ edges: null }))).toBe(false);
	});
});

describe('validateWorkflowParams', () => {
	it('returns true for valid UUIDv4', () => {
		expect(validateWorkflowParams({ puzzleId: '123e4567-e89b-42d3-a456-426614174000' })).toBe(true);
	});

	it('returns true for uppercase UUIDv4', () => {
		expect(validateWorkflowParams({ puzzleId: '123E4567-E89B-42D3-A456-426614174000' })).toBe(true);
	});

	it('returns false for null', () => {
		expect(validateWorkflowParams(null)).toBe(false);
	});

	it('returns false for non-object', () => {
		expect(validateWorkflowParams('string')).toBe(false);
	});

	it('returns false when puzzleId is not a string', () => {
		expect(validateWorkflowParams({ puzzleId: 123 })).toBe(false);
	});

	it('returns false for non-UUID string', () => {
		expect(validateWorkflowParams({ puzzleId: 'not-a-uuid' })).toBe(false);
	});

	it('returns false for UUIDv1 format (wrong version digit)', () => {
		expect(validateWorkflowParams({ puzzleId: '123e4567-e89b-12d3-a456-426614174000' })).toBe(
			false
		);
	});

	it('returns false for empty string puzzleId', () => {
		expect(validateWorkflowParams({ puzzleId: '' })).toBe(false);
	});
});

describe('createPuzzleProgress', () => {
	it('creates valid progress object', () => {
		const progress = createPuzzleProgress(100, 50);
		expect(progress.totalPieces).toBe(100);
		expect(progress.generatedPieces).toBe(50);
		expect(typeof progress.updatedAt).toBe('number');
		expect(progress.updatedAt).toBeGreaterThan(0);
	});

	it('allows generatedPieces = 0', () => {
		const progress = createPuzzleProgress(100, 0);
		expect(progress.generatedPieces).toBe(0);
	});

	it('allows generatedPieces = totalPieces', () => {
		const progress = createPuzzleProgress(100, 100);
		expect(progress.generatedPieces).toBe(100);
	});

	it('throws when totalPieces is not finite', () => {
		expect(() => createPuzzleProgress(Infinity, 0)).toThrow('totalPieces must be a finite integer');
	});

	it('throws when totalPieces is not an integer', () => {
		expect(() => createPuzzleProgress(3.5, 0)).toThrow('totalPieces must be a finite integer');
	});

	it('throws when generatedPieces is not finite', () => {
		expect(() => createPuzzleProgress(100, Infinity)).toThrow(
			'generatedPieces must be a finite integer'
		);
	});

	it('throws when generatedPieces is not an integer', () => {
		expect(() => createPuzzleProgress(100, 1.5)).toThrow(
			'generatedPieces must be a finite integer'
		);
	});

	it('throws when totalPieces is zero', () => {
		expect(() => createPuzzleProgress(0, 0)).toThrow('totalPieces must be positive');
	});

	it('throws when totalPieces is negative', () => {
		expect(() => createPuzzleProgress(-1, 0)).toThrow('totalPieces must be positive');
	});

	it('throws when generatedPieces is negative', () => {
		expect(() => createPuzzleProgress(100, -1)).toThrow('generatedPieces cannot be negative');
	});

	it('throws when generatedPieces exceeds totalPieces', () => {
		expect(() => createPuzzleProgress(10, 11)).toThrow('generatedPieces exceeds totalPieces');
	});
});

describe('validatePuzzleMetadata', () => {
	it('returns true for valid ready puzzle', () => {
		expect(validatePuzzleMetadata(makeMeta())).toBe(true);
	});

	it('returns true for valid ready puzzle with category', () => {
		expect(validatePuzzleMetadata(makeMeta({ category: 'Animals' }))).toBe(true);
	});

	it('returns true for valid processing puzzle', () => {
		const meta = makeMeta({
			status: 'processing',
			pieces: [],
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			progress: { totalPieces: 9, generatedPieces: 3, updatedAt: Date.now() }
		});
		expect(validatePuzzleMetadata(meta)).toBe(true);
	});

	it('returns true for valid failed puzzle', () => {
		const meta = makeMeta({
			status: 'failed',
			pieces: [],
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			error: { message: 'Something went wrong' }
		});
		expect(validatePuzzleMetadata(meta)).toBe(true);
	});

	it('returns false for null', () => {
		expect(validatePuzzleMetadata(null)).toBe(false);
	});

	it('returns false when id is not a string', () => {
		expect(validatePuzzleMetadata(makeMeta({ id: 123 }))).toBe(false);
	});

	it('returns false when name is not a string', () => {
		expect(validatePuzzleMetadata(makeMeta({ name: null }))).toBe(false);
	});

	it('returns false when pieceCount is Infinity', () => {
		expect(validatePuzzleMetadata(makeMeta({ pieceCount: Infinity }))).toBe(false);
	});

	it('returns false when gridCols is not a number', () => {
		expect(validatePuzzleMetadata(makeMeta({ gridCols: 'one' }))).toBe(false);
	});

	it('returns false when imageWidth is missing', () => {
		expect(validatePuzzleMetadata(makeMeta({ imageWidth: undefined }))).toBe(false);
	});

	it('returns false when imageHeight is NaN', () => {
		expect(validatePuzzleMetadata(makeMeta({ imageHeight: NaN }))).toBe(false);
	});

	it('returns false when createdAt is missing', () => {
		expect(validatePuzzleMetadata(makeMeta({ createdAt: undefined }))).toBe(false);
	});

	it('returns false when version is missing', () => {
		expect(validatePuzzleMetadata(makeMeta({ version: undefined }))).toBe(false);
	});

	it('returns false when pieces is not an array', () => {
		expect(validatePuzzleMetadata(makeMeta({ pieces: null }))).toBe(false);
	});

	it('returns false when status is invalid', () => {
		expect(validatePuzzleMetadata(makeMeta({ status: 'unknown' }))).toBe(false);
	});

	it('returns false when status is missing', () => {
		expect(validatePuzzleMetadata(makeMeta({ status: undefined }))).toBe(false);
	});

	it('returns false when grid math is inconsistent', () => {
		expect(validatePuzzleMetadata(makeMeta({ gridCols: 2, gridRows: 2, pieceCount: 9 }))).toBe(
			false
		);
	});

	it('returns false for processing puzzle without progress', () => {
		const meta = makeMeta({
			status: 'processing',
			pieces: [],
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3
		});
		expect(validatePuzzleMetadata(meta)).toBe(false);
	});

	it('returns false for processing puzzle with invalid progress', () => {
		const meta = makeMeta({
			status: 'processing',
			pieces: [],
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			progress: { totalPieces: 'bad', generatedPieces: 0, updatedAt: 0 }
		});
		expect(validatePuzzleMetadata(meta)).toBe(false);
	});

	it('returns false for processing puzzle with error field set', () => {
		const meta = makeMeta({
			status: 'processing',
			pieces: [],
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			progress: { totalPieces: 9, generatedPieces: 3, updatedAt: Date.now() },
			error: { message: 'should not be here' }
		});
		expect(validatePuzzleMetadata(meta)).toBe(false);
	});

	it('returns false for failed puzzle without error', () => {
		const meta = makeMeta({
			status: 'failed',
			pieces: [],
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3
		});
		expect(validatePuzzleMetadata(meta)).toBe(false);
	});

	it('returns false for failed puzzle with progress field set', () => {
		const meta = makeMeta({
			status: 'failed',
			pieces: [],
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			progress: { totalPieces: 9, generatedPieces: 3, updatedAt: Date.now() },
			error: { message: 'error' }
		});
		expect(validatePuzzleMetadata(meta)).toBe(false);
	});

	it('returns false for failed puzzle with non-object error', () => {
		const meta = makeMeta({
			status: 'failed',
			pieces: [],
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			error: 'not an object'
		});
		expect(validatePuzzleMetadata(meta)).toBe(false);
	});

	it('returns false for failed puzzle with error missing message', () => {
		const meta = makeMeta({
			status: 'failed',
			pieces: [],
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			error: { code: 123 }
		});
		expect(validatePuzzleMetadata(meta)).toBe(false);
	});

	it('returns false for ready puzzle with pieces count mismatch', () => {
		const meta = makeMeta({
			status: 'ready',
			pieces: [makePiece(), makePiece({ id: 1 })],
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2
		});
		expect(validatePuzzleMetadata(meta)).toBe(false);
	});

	it('returns false for ready puzzle with error field', () => {
		const meta = makeMeta({
			error: { message: 'should not be here' }
		}) as Record<string, unknown>;
		expect(validatePuzzleMetadata(meta)).toBe(false);
	});

	it('returns false for ready puzzle with progress field', () => {
		const meta = makeMeta({
			progress: { totalPieces: 1, generatedPieces: 1, updatedAt: Date.now() }
		}) as Record<string, unknown>;
		expect(validatePuzzleMetadata(meta)).toBe(false);
	});

	it('returns false for invalid category', () => {
		expect(validatePuzzleMetadata(makeMeta({ category: 'Robots' }))).toBe(false);
	});

	it('returns false when a piece is invalid', () => {
		expect(
			validatePuzzleMetadata(
				makeMeta({ pieces: [makePiece({ id: 'not-a-number' })], pieceCount: 1 })
			)
		).toBe(false);
	});
});

describe('validatePuzzleMetadataLight', () => {
	it('returns true for valid ready puzzle', () => {
		expect(validatePuzzleMetadataLight(makeMeta())).toBe(true);
	});

	it('returns true for a ready puzzle even with invalid piece internals', () => {
		// Light validation skips per-piece validation
		const meta = makeMeta({
			pieces: [{ totally: 'invalid' }],
			pieceCount: 1,
			gridCols: 1,
			gridRows: 1
		});
		expect(validatePuzzleMetadataLight(meta)).toBe(true);
	});

	it('returns false for null', () => {
		expect(validatePuzzleMetadataLight(null)).toBe(false);
	});

	it('returns false when pieces is not an array', () => {
		expect(validatePuzzleMetadataLight(makeMeta({ pieces: 'not-array' }))).toBe(false);
	});

	it('returns false when grid math is inconsistent', () => {
		expect(validatePuzzleMetadataLight(makeMeta({ gridCols: 2, gridRows: 3, pieceCount: 1 }))).toBe(
			false
		);
	});

	it('returns false for invalid status', () => {
		expect(validatePuzzleMetadataLight(makeMeta({ status: 'invalid' }))).toBe(false);
	});

	it('returns true for valid processing puzzle', () => {
		const meta = makeMeta({
			status: 'processing',
			pieces: [],
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			progress: { totalPieces: 9, generatedPieces: 3, updatedAt: Date.now() }
		});
		expect(validatePuzzleMetadataLight(meta)).toBe(true);
	});

	it('returns false for processing puzzle without progress', () => {
		const meta = makeMeta({
			status: 'processing',
			pieces: [],
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3
		});
		expect(validatePuzzleMetadataLight(meta)).toBe(false);
	});

	it('returns true for valid failed puzzle', () => {
		const meta = makeMeta({
			status: 'failed',
			pieces: [],
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			error: { message: 'failed' }
		});
		expect(validatePuzzleMetadataLight(meta)).toBe(true);
	});

	it('returns false for failed puzzle with progress set', () => {
		const meta = makeMeta({
			status: 'failed',
			pieces: [],
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			error: { message: 'err' },
			progress: { totalPieces: 9, generatedPieces: 0, updatedAt: Date.now() }
		});
		expect(validatePuzzleMetadataLight(meta)).toBe(false);
	});

	it('returns false for ready puzzle with pieces count mismatch', () => {
		const meta = makeMeta({
			status: 'ready',
			pieces: [],
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2
		});
		expect(validatePuzzleMetadataLight(meta)).toBe(false);
	});

	it('returns false for invalid category', () => {
		expect(validatePuzzleMetadataLight(makeMeta({ category: 'Unknown' }))).toBe(false);
	});
});
