// Re-export shared types from @perseus/types package
export type {
	EdgeType,
	EdgeConfig,
	PuzzlePiece,
	PuzzleStatus,
	PuzzleProgress,
	PuzzleMetadata,
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
	THUMBNAIL_SIZE,
	validateWorkflowParams,
	createPuzzleProgress
} from '@perseus/types';
