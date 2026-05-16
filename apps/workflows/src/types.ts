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
	ReadyPuzzle,
	FailedPuzzle,
	WorkflowParams
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
	createPuzzleProgress
} from '@perseus/types';
