import { describe, it, expect } from 'vitest';
import {
	validateEdgeConfig,
	isPuzzlePiece,
	validateWorkflowParams,
	createPuzzleProgress,
	stripIdempotencyKey,
	validatePuzzleMetadata,
	validatePuzzleMetadataLight,
	TAB_RATIO,
	EXPANSION_FACTOR,
	MAX_IMAGE_DIMENSION,
	MAX_PIECES,
	DEFAULT_PIECE_COUNT,
	THUMBNAIL_SIZE,
	PUZZLE_CATEGORIES,
	isPlayerSessionResponse,
	isPlayerAllowlistEntry,
	isPlayerProfile,
	isPlayerPuzzleSummary,
	isPlayerStatRow,
	isPuzzleId,
	isPuzzleRunId,
	isRecordPuzzleCompletionV1,
	type PlayerSessionResponse,
	type PlayerAllowlistEntry,
	type PlayerProfile,
	type PlayerPuzzleSummary,
	type PlayerStatRow,
	type ResultClass,
	type RecordPuzzleCompletionResponse,
	coercePuzzleStatus
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

describe('coercePuzzleStatus', () => {
	it.each(['processing', 'ready', 'failed'])('passes through a valid status %s', (status) => {
		expect(coercePuzzleStatus(status)).toBe(status);
	});

	it('defaults an unexpected value to failed', () => {
		expect(coercePuzzleStatus('corrupted')).toBe('failed');
	});
});

describe('versioned puzzle completion contract', () => {
	const currentRunId = '223e4567-e89b-42d3-a456-426614174000';

	describe('current four-field request', () => {
		const timed = {
			version: 1,
			runId: currentRunId,
			resultClass: 'standard_timed' as const,
			elapsedActiveSeconds: 90
		};
		const relaxed = {
			version: 1,
			runId: currentRunId,
			resultClass: 'relaxed' as const,
			elapsedActiveSeconds: null
		};

		it('accepts timed and relaxed four-field requests', () => {
			expect(isRecordPuzzleCompletionV1(timed, 86_400)).toBe(true);
			expect(isRecordPuzzleCompletionV1(relaxed, 86_400)).toBe(true);
		});

		it('rejects timed requests without elapsed seconds', () => {
			expect(isRecordPuzzleCompletionV1({ ...timed, elapsedActiveSeconds: null }, 86_400)).toBe(
				false
			);
		});

		it('rejects relaxed requests with elapsed seconds', () => {
			expect(isRecordPuzzleCompletionV1({ ...relaxed, elapsedActiveSeconds: 90 }, 86_400)).toBe(
				false
			);
		});

		it('rejects the obsolete timingQuality field', () => {
			expect(isRecordPuzzleCompletionV1({ ...timed, timingQuality: 'known' }, 86_400)).toBe(false);
		});

		it('rejects legacy hash run IDs while accepting UUID-v4 run IDs', () => {
			const legacyRunId = `legacy-${'a'.repeat(64)}`;

			expect(isPuzzleRunId(legacyRunId)).toBe(false);
			expect(isRecordPuzzleCompletionV1({ ...timed, runId: legacyRunId }, 86_400)).toBe(false);
			expect(isPuzzleRunId(currentRunId)).toBe(true);
		});
	});

	const validRunId = '123e4567-e89b-42d3-a456-426614174000';
	const legacyRunId = `legacy-${'a'.repeat(64)}`;

	it('accepts the completion quota exceeded response', () => {
		const response: RecordPuzzleCompletionResponse = {
			error: 'completion_quota_exceeded',
			message: 'Completion history limit reached'
		};

		expect(response).toMatchObject({ error: 'completion_quota_exceeded' });
	});

	it.each([
		[validRunId, true],
		[legacyRunId, false],
		['123E4567-E89B-42D3-A456-426614174000', false],
		['123e4567-e89b-12d3-a456-426614174000', false],
		['123e4567-e89b-42d3-c456-426614174000', false],
		[`legacy-${'A'.repeat(64)}`, false],
		[`legacy-${'a'.repeat(63)}`, false],
		['not-a-run-id', false],
		[' legacy-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', false],
		['123e4567-e89b-42d3-a456-426614174000 ', false]
	])('validates puzzle run ID %j as %s', (candidate, expected) => {
		expect(isPuzzleRunId(candidate)).toBe(expected);
	});

	const timedClasses: ResultClass[] = ['standard_timed', 'rotation_timed', 'assisted_timed'];

	it.each(timedClasses)(
		'accepts %s completions with a positive whole-second elapsed time',
		(resultClass) => {
			expect(
				isRecordPuzzleCompletionV1(
					{
						version: 1,
						runId: validRunId,
						resultClass,
						elapsedActiveSeconds: 1
					},
					86_400
				)
			).toBe(true);
		}
	);

	it('accepts relaxed completions with no elapsed time', () => {
		expect(
			isRecordPuzzleCompletionV1(
				{
					version: 1,
					runId: validRunId,
					resultClass: 'relaxed',
					elapsedActiveSeconds: null
				},
				86_400
			)
		).toBe(true);
	});

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'rejects an otherwise valid timed completion when maxElapsedActiveSeconds is %s',
		(maxElapsed) => {
			expect(
				isRecordPuzzleCompletionV1(
					{
						version: 1,
						runId: validRunId,
						resultClass: 'standard_timed',
						elapsedActiveSeconds: 1
					},
					maxElapsed
				)
			).toBe(false);
		}
	);

	it.each([
		[
			{
				version: 1,
				runId: validRunId,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: null
			},
			false
		],
		[
			{
				version: 1,
				runId: validRunId,
				resultClass: 'relaxed',
				elapsedActiveSeconds: 1
			},
			false
		],
		[
			{
				version: 1,
				runId: validRunId,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 0
			},
			false
		],
		[
			{
				version: 1,
				runId: validRunId,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: -1
			},
			false
		],
		[
			{
				version: 1,
				runId: validRunId,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 1.5
			},
			false
		],
		[
			{
				version: 1,
				runId: validRunId,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: Infinity
			},
			false
		],
		[
			{
				version: 1,
				runId: validRunId,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 86_401
			},
			false
		],
		[
			{
				version: 1,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 1
			},
			false
		],
		[{ version: 1, runId: validRunId, resultClass: 'standard_timed' }, false],
		[
			{
				version: 1,
				runId: validRunId,
				resultClass: 'invalid',
				elapsedActiveSeconds: 1
			},
			false
		],
		[
			{
				version: 2,
				runId: validRunId,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 1
			},
			false
		],
		[
			{
				version: 1,
				runId: validRunId,
				resultClass: 'standard_timed',
				elapsedActiveSeconds: 1,
				ignored: true
			},
			false
		]
	])('rejects invalid completion request %j', (candidate, expected) => {
		expect(isRecordPuzzleCompletionV1(candidate, 86_400)).toBe(expected);
	});
});

describe('player auth contracts', () => {
	it('validates an authenticated player session response', () => {
		const response: PlayerSessionResponse = {
			authenticated: true,
			user: {
				id: 'google-sub-123',
				email: 'player@example.com',
				name: 'Player One',
				picture: 'https://example.com/avatar.png',
				createdAt: 1716500000000,
				lastLoginAt: 1716500100000
			}
		};

		expect(isPlayerSessionResponse(response)).toBe(true);
	});

	it('rejects authenticated session responses without a user', () => {
		expect(isPlayerSessionResponse({ authenticated: true })).toBe(false);
	});

	it('validates an unauthenticated player session response', () => {
		const response: PlayerSessionResponse = {
			authenticated: false
		};

		expect(isPlayerSessionResponse(response)).toBe(true);
	});

	it('rejects unauthenticated session responses with a user', () => {
		const response = {
			authenticated: false,
			user: {
				id: 'google-sub-123',
				email: 'player@example.com',
				createdAt: 1716500000000,
				lastLoginAt: 1716500100000
			}
		} as const;

		// @ts-expect-error unauthenticated responses must not include player metadata
		const typedResponse: PlayerSessionResponse = response;

		expect(isPlayerSessionResponse(response)).toBe(false);
		expect(typedResponse.authenticated).toBe(false);
	});

	it('rejects session responses with invalid nested player fields', () => {
		expect(
			isPlayerSessionResponse({
				authenticated: true,
				user: {
					id: 'google-sub-123',
					email: 'player@example.com',
					name: ' ',
					createdAt: 1716500000000,
					lastLoginAt: 1716500100000
				}
			})
		).toBe(false);

		expect(
			isPlayerSessionResponse({
				authenticated: true,
				user: {
					id: 'google-sub-123',
					email: 'player@example.com',
					createdAt: 1716500000000,
					lastLoginAt: Number.NaN
				}
			})
		).toBe(false);
	});

	it('validates allowlist entries with linked player metadata', () => {
		const entry: PlayerAllowlistEntry = {
			email: 'player@example.com',
			createdAt: 1716500000000,
			addedBy: 'admin',
			player: {
				id: 'google-sub-123',
				email: 'player@example.com',
				createdAt: 1716500000000,
				lastLoginAt: 1716500100000
			}
		};

		expect(isPlayerAllowlistEntry(entry)).toBe(true);
	});

	it('validates allowlist entries without linked player metadata', () => {
		const entry: PlayerAllowlistEntry = {
			email: 'player@example.com',
			createdAt: 1716500000000,
			addedBy: 'admin'
		};

		expect(isPlayerAllowlistEntry(entry)).toBe(true);
	});

	it('rejects allowlist entries with invalid nested player fields', () => {
		expect(
			isPlayerAllowlistEntry({
				email: 'player@example.com',
				createdAt: 1716500000000,
				addedBy: 'admin',
				player: {
					id: 'google-sub-123',
					email: 'not-an-email',
					createdAt: 1716500000000,
					lastLoginAt: 1716500100000
				}
			})
		).toBe(false);
	});

	it('rejects allowlist entries with invalid email shape', () => {
		expect(
			isPlayerAllowlistEntry({
				email: 'not-an-email',
				createdAt: 1716500000000,
				addedBy: 'admin'
			})
		).toBe(false);
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

describe('isPuzzleId', () => {
	it('returns true for a valid lowercase UUIDv4', () => {
		expect(isPuzzleId('123e4567-e89b-42d3-a456-426614174000')).toBe(true);
	});

	it('returns true for an uppercase UUIDv4', () => {
		expect(isPuzzleId('123E4567-E89B-42D3-A456-426614174000')).toBe(true);
	});

	it('returns false for a non-UUID string', () => {
		expect(isPuzzleId('pz1')).toBe(false);
		expect(isPuzzleId('not-a-uuid')).toBe(false);
	});

	it('returns false for a UUIDv1 (wrong version digit)', () => {
		expect(isPuzzleId('123e4567-e89b-12d3-a456-426614174000')).toBe(false);
	});

	it('returns false for non-strings', () => {
		expect(isPuzzleId(null)).toBe(false);
		expect(isPuzzleId(123)).toBe(false);
		expect(isPuzzleId(undefined)).toBe(false);
		expect(isPuzzleId('')).toBe(false);
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

describe('stripIdempotencyKey', () => {
	it('removes idempotencyKey when present', () => {
		const puzzle = { id: 'p1', name: 'Test', idempotencyKey: 'secret-key' };
		const stripped = stripIdempotencyKey(puzzle);
		expect(stripped).toEqual({ id: 'p1', name: 'Test' });
		expect('idempotencyKey' in stripped).toBe(false);
	});

	it('preserves all other fields', () => {
		const puzzle = {
			id: 'p1',
			name: 'Test',
			pieceCount: 100,
			idempotencyKey: 'secret-key',
			extra: 'kept'
		};
		const stripped = stripIdempotencyKey(puzzle);
		expect(stripped.id).toBe('p1');
		expect(stripped.name).toBe('Test');
		expect(stripped.pieceCount).toBe(100);
		expect(stripped.extra).toBe('kept');
		expect('idempotencyKey' in stripped).toBe(false);
	});

	it('works when idempotencyKey is absent', () => {
		const puzzle: { id: string; name: string; idempotencyKey?: string } = {
			id: 'p1',
			name: 'Test'
		};
		const stripped = stripIdempotencyKey(puzzle);
		expect(stripped).toEqual({ id: 'p1', name: 'Test' });
		expect('idempotencyKey' in stripped).toBe(false);
	});

	it('does not mutate the input', () => {
		const puzzle = { id: 'p1', name: 'Test', idempotencyKey: 'secret-key' };
		stripIdempotencyKey(puzzle);
		expect(puzzle.idempotencyKey).toBe('secret-key');
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

	it('returns true for valid aspectRatio with matching grid dimensions', () => {
		// 3:4 aspect ratio, 48 pieces → 8 rows × 6 cols
		const meta = makeMeta({
			aspectRatio: '3:4',
			pieceCount: 48,
			gridCols: 6,
			gridRows: 8,
			pieces: Array.from({ length: 48 }, (_, i) =>
				makePiece({ id: i, correctX: i % 6, correctY: Math.floor(i / 6) })
			)
		});
		expect(validatePuzzleMetadata(meta)).toBe(true);
	});

	it('returns false when aspectRatio grid dimensions do not match stored gridRows/gridCols', () => {
		// 3:4 aspect ratio, 48 pieces → should be 8 rows × 6 cols, but we pass 15×15
		const meta = makeMeta({
			aspectRatio: '3:4',
			pieceCount: 48,
			gridCols: 15,
			gridRows: 15
		});
		expect(validatePuzzleMetadata(meta)).toBe(false);
	});

	it('returns false when pieceCount is invalid for the given aspectRatio', () => {
		// 3:4 aspect ratio with 225 pieces → 225 is not valid for 3:4
		// Use 'processing' status so validation reaches the aspectRatio cross-check
		// (status: 'ready' would fail earlier on pieces.length !== pieceCount)
		const meta = makeMeta({
			status: 'processing',
			aspectRatio: '3:4',
			pieceCount: 225,
			gridCols: 15,
			gridRows: 15,
			pieces: [],
			progress: { totalPieces: 225, generatedPieces: 0, updatedAt: Date.now() }
		});
		expect(validatePuzzleMetadata(meta)).toBe(false);
	});

	it('returns true when aspectRatio is undefined (no cross-validation)', () => {
		// No aspectRatio set - only grid math check applies
		const meta = makeMeta({
			pieceCount: 6,
			gridCols: 3,
			gridRows: 2,
			pieces: Array.from({ length: 6 }, (_, i) =>
				makePiece({ id: i, correctX: i % 3, correctY: Math.floor(i / 3) })
			)
		});
		expect(validatePuzzleMetadata(meta)).toBe(true);
	});

	it('returns false when category is a non-string value', () => {
		expect(validatePuzzleMetadata(makeMeta({ category: 42 }))).toBe(false);
	});

	it('returns false when a piece is invalid', () => {
		expect(
			validatePuzzleMetadata(
				makeMeta({ pieces: [makePiece({ id: 'not-a-number' })], pieceCount: 1 })
			)
		).toBe(false);
	});

	it('returns true when idempotencyKey is a string', () => {
		expect(validatePuzzleMetadata(makeMeta({ idempotencyKey: 'abc123' }))).toBe(true);
	});

	it('returns true when idempotencyKey is absent', () => {
		// makeMeta() does not include idempotencyKey by default, so this
		// genuinely exercises the absent-property case (not a string, not
		// a non-string — the key is simply not present on the object).
		const meta = makeMeta();
		expect(validatePuzzleMetadata(meta)).toBe(true);
	});

	it('returns false when idempotencyKey is a non-string', () => {
		expect(validatePuzzleMetadata(makeMeta({ idempotencyKey: 42 }))).toBe(false);
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

	it('returns true for valid aspectRatio with matching grid dimensions', () => {
		const meta = makeMeta({
			aspectRatio: '3:4',
			pieceCount: 48,
			gridCols: 6,
			gridRows: 8,
			pieces: Array.from({ length: 48 }, (_, i) =>
				makePiece({ id: i, correctX: i % 6, correctY: Math.floor(i / 6) })
			)
		});
		expect(validatePuzzleMetadataLight(meta)).toBe(true);
	});

	it('returns false when aspectRatio grid dimensions do not match stored gridRows/gridCols', () => {
		const meta = makeMeta({
			aspectRatio: '3:4',
			pieceCount: 48,
			gridCols: 15,
			gridRows: 15
		});
		expect(validatePuzzleMetadataLight(meta)).toBe(false);
	});

	it('returns false when pieceCount is invalid for the given aspectRatio', () => {
		// 3:4 aspect ratio with 225 pieces → 225 is not valid for 3:4
		// Use 'processing' status so validation reaches the aspectRatio cross-check
		const meta = makeMeta({
			status: 'processing',
			aspectRatio: '3:4',
			pieceCount: 225,
			gridCols: 15,
			gridRows: 15,
			pieces: [],
			progress: { totalPieces: 225, generatedPieces: 0, updatedAt: Date.now() }
		});
		expect(validatePuzzleMetadataLight(meta)).toBe(false);
	});

	it('returns true when aspectRatio is undefined (no cross-validation)', () => {
		const meta = makeMeta({
			pieceCount: 6,
			gridCols: 3,
			gridRows: 2,
			pieces: Array.from({ length: 6 }, (_, i) =>
				makePiece({ id: i, correctX: i % 3, correctY: Math.floor(i / 3) })
			)
		});
		expect(validatePuzzleMetadataLight(meta)).toBe(true);
	});

	it('returns false when category is a non-string value', () => {
		expect(validatePuzzleMetadataLight(makeMeta({ category: 42 }))).toBe(false);
	});

	it('returns false when id is not a string', () => {
		expect(validatePuzzleMetadataLight(makeMeta({ id: 999 }))).toBe(false);
	});

	it('returns false when gridCols is not a number', () => {
		expect(validatePuzzleMetadataLight(makeMeta({ gridCols: 'two' }))).toBe(false);
	});

	it('returns false when imageWidth is not a number', () => {
		expect(validatePuzzleMetadataLight(makeMeta({ imageWidth: 'wide' }))).toBe(false);
	});

	it('returns false when createdAt is missing', () => {
		expect(validatePuzzleMetadataLight(makeMeta({ createdAt: undefined }))).toBe(false);
	});

	it('returns true when idempotencyKey is a string', () => {
		expect(validatePuzzleMetadataLight(makeMeta({ idempotencyKey: 'abc123' }))).toBe(true);
	});

	it('returns true when idempotencyKey is absent', () => {
		// Parallel to the validatePuzzleMetadata absent-key case: makeMeta()
		// does not include idempotencyKey by default, so this genuinely
		// exercises the absent-property case.
		expect(validatePuzzleMetadataLight(makeMeta())).toBe(true);
	});

	it('returns false when idempotencyKey is a non-string', () => {
		expect(validatePuzzleMetadataLight(makeMeta({ idempotencyKey: 42 }))).toBe(false);
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
		expect(validatePuzzleMetadataLight(meta)).toBe(false);
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
		expect(validatePuzzleMetadataLight(meta)).toBe(false);
	});

	it('returns false for failed puzzle with error missing message property', () => {
		const meta = makeMeta({
			status: 'failed',
			pieces: [],
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			error: { code: 123 }
		});
		expect(validatePuzzleMetadataLight(meta)).toBe(false);
	});

	it('returns false for ready puzzle with error field set', () => {
		const meta = makeMeta({
			error: { message: 'should not be here' }
		}) as Record<string, unknown>;
		expect(validatePuzzleMetadataLight(meta)).toBe(false);
	});

	it('returns false for ready puzzle with progress field set', () => {
		const meta = makeMeta({
			progress: { totalPieces: 1, generatedPieces: 1, updatedAt: Date.now() }
		}) as Record<string, unknown>;
		expect(validatePuzzleMetadataLight(meta)).toBe(false);
	});
});

describe('player profile validators', () => {
	const profile: PlayerProfile = {
		id: 'p1',
		email: 'p@example.com',
		name: 'Player',
		picture: null,
		createdAt: 1,
		lastLoginAt: 2,
		summary: { puzzlesUploaded: 1, puzzlesSolved: 2, totalCompletions: 3 }
	};

	it('validates a well-formed profile', () => {
		expect(isPlayerProfile(profile)).toBe(true);
	});

	it('rejects profile with bad summary', () => {
		expect(isPlayerProfile({ ...profile, summary: { puzzlesUploaded: 'x' } })).toBe(false);
	});

	it('rejects null', () => {
		expect(isPlayerProfile(null)).toBe(false);
	});

	const stat: PlayerStatRow = {
		puzzleId: 'pz1',
		puzzleName: 'Cat',
		bestTimeSeconds: 90,
		totalCompletions: 2,
		firstCompletedAt: 10,
		lastCompletedAt: 20
	};

	it('validates a stat row', () => {
		expect(isPlayerStatRow(stat)).toBe(true);
	});

	it('validates a stat row without a standard best time', () => {
		const nullableStat: PlayerStatRow = { ...stat, bestTimeSeconds: null };

		expect(isPlayerStatRow(nullableStat)).toBe(true);
	});

	it('rejects a stat row with a missing standard best time', () => {
		const { bestTimeSeconds: _bestTimeSeconds, ...missingBest } = stat;

		expect(isPlayerStatRow(missingBest)).toBe(false);
	});

	it.each([
		['undefined', { ...stat, bestTimeSeconds: undefined }],
		['string', { ...stat, bestTimeSeconds: '90' }],
		['NaN', { ...stat, bestTimeSeconds: NaN }],
		['positive infinity', { ...stat, bestTimeSeconds: Infinity }],
		['negative infinity', { ...stat, bestTimeSeconds: -Infinity }]
	])('rejects a stat row with a %s standard best time', (_case, value) => {
		expect(isPlayerStatRow(value)).toBe(false);
	});

	const puzzle: PlayerPuzzleSummary = {
		id: 'pz1',
		name: 'Cat',
		pieceCount: 100,
		status: 'ready',
		createdAt: 5
	};

	it('validates a player puzzle summary', () => {
		expect(isPlayerPuzzleSummary(puzzle)).toBe(true);
		expect(isPlayerPuzzleSummary({ ...puzzle, status: 5 })).toBe(false);
	});

	it('rejects non-object profiles', () => {
		expect(isPlayerProfile('nope')).toBe(false);
		expect(isPlayerProfile(42)).toBe(false);
	});

	it('rejects profile with blank id', () => {
		expect(isPlayerProfile({ ...profile, id: ' ' })).toBe(false);
	});

	it('rejects profile with blank email', () => {
		expect(isPlayerProfile({ ...profile, email: ' ' })).toBe(false);
	});

	it('rejects profile with blank name', () => {
		expect(isPlayerProfile({ ...profile, name: '' })).toBe(false);
	});

	it('rejects profile with invalid picture', () => {
		expect(isPlayerProfile({ ...profile, picture: 5 })).toBe(false);
		expect(isPlayerProfile({ ...profile, picture: '' })).toBe(false);
	});

	it('rejects profile with non-finite createdAt', () => {
		expect(isPlayerProfile({ ...profile, createdAt: NaN })).toBe(false);
	});

	it('rejects profile with non-finite lastLoginAt', () => {
		expect(isPlayerProfile({ ...profile, lastLoginAt: Infinity })).toBe(false);
	});

	it('rejects profile with null summary', () => {
		expect(isPlayerProfile({ ...profile, summary: null })).toBe(false);
	});

	it('rejects profile with incomplete summary', () => {
		expect(isPlayerProfile({ ...profile, summary: { puzzlesUploaded: 1 } })).toBe(false);
	});

	it('rejects null stat row', () => {
		expect(isPlayerStatRow(null)).toBe(false);
	});

	it('rejects stat row with blank puzzleId', () => {
		expect(isPlayerStatRow({ ...stat, puzzleId: '' })).toBe(false);
	});

	it('rejects stat row with non-finite totalCompletions', () => {
		expect(isPlayerStatRow({ ...stat, totalCompletions: NaN })).toBe(false);
	});

	it('rejects stat row with non-finite firstCompletedAt', () => {
		expect(isPlayerStatRow({ ...stat, firstCompletedAt: Infinity })).toBe(false);
	});

	it('rejects stat row with non-finite lastCompletedAt', () => {
		expect(isPlayerStatRow({ ...stat, lastCompletedAt: 'nope' as unknown as number })).toBe(false);
	});

	it('rejects null player puzzle summary', () => {
		expect(isPlayerPuzzleSummary(null)).toBe(false);
	});

	it('rejects player puzzle summary with blank id', () => {
		expect(isPlayerPuzzleSummary({ ...puzzle, id: ' ' })).toBe(false);
	});

	it('rejects player puzzle summary with blank name', () => {
		expect(isPlayerPuzzleSummary({ ...puzzle, name: '' })).toBe(false);
	});

	it('rejects player puzzle summary with non-finite pieceCount', () => {
		expect(isPlayerPuzzleSummary({ ...puzzle, pieceCount: Infinity })).toBe(false);
	});

	it('rejects player puzzle summary with non-finite createdAt', () => {
		expect(isPlayerPuzzleSummary({ ...puzzle, createdAt: NaN })).toBe(false);
	});

	it('rejects player puzzle summary with non-string category', () => {
		expect(isPlayerPuzzleSummary({ ...puzzle, category: 5 })).toBe(false);
	});

	it('accepts player puzzle summary with valid category', () => {
		expect(isPlayerPuzzleSummary({ ...puzzle, category: 'Animals' })).toBe(true);
	});
});
