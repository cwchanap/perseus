// Re-export shared types from @perseus/types package
export type {
	EdgeType,
	EdgeConfig,
	PuzzlePiece,
	PuzzleStatus,
	PuzzleProgress,
	PuzzleMetadata,
	PuzzleSummary,
	PuzzleAspectRatio,
	PuzzleFamilyMetadata,
	ReadyPuzzle,
	FailedPuzzle,
	WorkflowParams,
	PuzzleDifficulty
} from '@perseus/types';

export {
	TAB_RATIO,
	EXPANSION_FACTOR,
	MAX_IMAGE_DIMENSION,
	MAX_PIECES,
	DEFAULT_PIECE_COUNT,
	DEFAULT_PUZZLE_ASPECT_RATIO,
	PUZZLE_ASPECT_RATIOS,
	isPuzzleAspectRatio,
	getGridDimensionsForAspectRatio,
	isValidPieceCountForAspectRatio,
	getAllowedPieceCountsForAspectRatio,
	THUMBNAIL_SIZE,
	validateWorkflowParams,
	validatePuzzleMetadata,
	createPuzzleProgress,
	PUZZLE_DIFFICULTIES,
	getDifficultyPieceCount,
	validatePuzzleFamilyMetadata
} from '@perseus/types';
