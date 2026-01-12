// Workflow-related types shared between API and Workflows workers

export interface WorkflowParams {
	puzzleId: string;
}

export type PuzzleStatus = 'processing' | 'ready' | 'failed';

export interface PuzzleProgress {
	totalPieces: number;
	generatedPieces: number;
	updatedAt: number;
}
