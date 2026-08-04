import {
	MAX_PIECES,
	classifyProgressBucket,
	isAnalyticsEventInputV1,
	type AnalyticsAspectBucket,
	type AnalyticsAssistanceMode,
	type AnalyticsAuthenticationClass,
	type AnalyticsClientContextV1,
	type AnalyticsContentOrigin,
	type AnalyticsPieceCountBucket,
	type AnalyticsPrimaryInput,
	type AnalyticsPuzzleContextV1,
	type AnalyticsPuzzleSource,
	type AnalyticsSessionMode,
	type AnalyticsSessionOrigin,
	type AnalyticsViewportClass,
	type ResultClass,
	type TimingQuality
} from '@perseus/types';

const VALID_ASPECTS = new Set<AnalyticsAspectBucket>(['square', 'landscape', 'portrait']);
const CONTEXT_VALIDATION_RUN_ID = '00000000-0000-4000-8000-000000000000';

export type AnalyticsAuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface PrimaryInputSnapshot {
	lastInteraction: 'keyboard' | 'pointer' | null;
	pointerType?: 'mouse' | 'pen' | 'touch' | '';
	coarsePointer: boolean | null;
}

export interface AssistanceUsageSnapshot {
	hintUsed: boolean;
	ghostReferenceUsed: boolean;
	referenceActivations: number;
}

export function classifyPieceCountBucket(pieceCount: number): AnalyticsPieceCountBucket | null {
	if (!Number.isInteger(pieceCount) || pieceCount < 1 || pieceCount > MAX_PIECES) return null;
	if (pieceCount <= 24) return '1-24';
	if (pieceCount <= 49) return '25-49';
	if (pieceCount <= 99) return '50-99';
	if (pieceCount <= 149) return '100-149';
	if (pieceCount <= 225) return '150-225';
	return '226+';
}

export function classifyAspectBucket(input: {
	declaredAspect?: AnalyticsAspectBucket;
	width: number;
	height: number;
}): AnalyticsAspectBucket | null {
	if (input.declaredAspect !== undefined) {
		return VALID_ASPECTS.has(input.declaredAspect) ? input.declaredAspect : null;
	}
	if (
		!Number.isFinite(input.width) ||
		!Number.isFinite(input.height) ||
		input.width <= 0 ||
		input.height <= 0
	) {
		return null;
	}
	if (input.width === input.height) return 'square';
	return input.width > input.height ? 'landscape' : 'portrait';
}

export function classifyViewportClass(width: number): AnalyticsViewportClass | null {
	if (!Number.isFinite(width) || width < 0) return null;
	if (width < 768) return 'mobile';
	if (width < 1024) return 'tablet';
	return 'desktop';
}

// classifyProgressBucket is re-exported from @perseus/types (the contract-level
// single source of truth) so the client context projection and the server-side
// incomplete-exit validator share one implementation. The re-export below keeps
// this module's public surface stable for existing importers.
export { classifyProgressBucket };

export function classifyPrimaryInput(snapshot: PrimaryInputSnapshot): AnalyticsPrimaryInput {
	if (snapshot.lastInteraction === 'keyboard') return 'keyboard';
	if (snapshot.lastInteraction === 'pointer') {
		if (snapshot.pointerType === 'touch') return 'coarse_pointer';
		if (snapshot.pointerType === 'mouse' || snapshot.pointerType === 'pen') {
			return 'fine_pointer';
		}
	}
	if (snapshot.coarsePointer === true) return 'coarse_pointer';
	if (snapshot.coarsePointer === false) return 'fine_pointer';
	return 'unknown';
}

export function classifyAssistanceMode(
	snapshot: AssistanceUsageSnapshot
): AnalyticsAssistanceMode | null {
	if (!Number.isInteger(snapshot.referenceActivations) || snapshot.referenceActivations < 0) {
		return null;
	}
	if (snapshot.hintUsed && snapshot.referenceActivations > 0) return 'mixed';
	if (snapshot.hintUsed) return 'hint';
	if (snapshot.ghostReferenceUsed) return 'ghost_reference';
	if (snapshot.referenceActivations > 0) return 'reference';
	return 'none';
}

export function resolveAuthenticationClass(
	status: AnalyticsAuthStatus
): AnalyticsAuthenticationClass {
	if (status === 'loading') return 'unknown';
	return status;
}

export function resolveContentOrigin(input: {
	puzzleSource: AnalyticsPuzzleSource;
	apiOrigin?: 'system' | 'player_uploaded';
}): AnalyticsContentOrigin {
	if (input.puzzleSource === 'local') return 'player_uploaded';
	return input.apiOrigin ?? 'unknown';
}

export function buildAnalyticsClientContextV1(input: {
	authStatus: AnalyticsAuthStatus;
	viewportWidth: number;
	primaryInput: PrimaryInputSnapshot;
}): AnalyticsClientContextV1 | null {
	const viewportClass = classifyViewportClass(input.viewportWidth);
	if (viewportClass === null) return null;
	return {
		authentication: resolveAuthenticationClass(input.authStatus),
		viewportClass,
		primaryInput: classifyPrimaryInput(input.primaryInput)
	};
}

export function buildAnalyticsPuzzleContextV1(input: {
	client: AnalyticsClientContextV1;
	puzzleSource: AnalyticsPuzzleSource;
	apiOrigin?: 'system' | 'player_uploaded';
	declaredAspect?: AnalyticsAspectBucket;
	pieceCount: number;
	imageWidth: number;
	imageHeight: number;
	sessionMode: AnalyticsSessionMode;
	resultClass: ResultClass;
	timingQuality: TimingQuality;
	sessionOrigin: AnalyticsSessionOrigin;
	rotationUsed: boolean;
	placedPieceCount: number;
	assistance: AssistanceUsageSnapshot;
}): AnalyticsPuzzleContextV1 | null {
	const pieceCountBucket = classifyPieceCountBucket(input.pieceCount);
	const aspectBucket = classifyAspectBucket({
		declaredAspect: input.declaredAspect,
		width: input.imageWidth,
		height: input.imageHeight
	});
	const progressBucket = classifyProgressBucket(input.placedPieceCount, input.pieceCount);
	const assistanceMode = classifyAssistanceMode(input.assistance);
	if (
		pieceCountBucket === null ||
		aspectBucket === null ||
		progressBucket === null ||
		assistanceMode === null
	) {
		return null;
	}

	const context: AnalyticsPuzzleContextV1 = {
		...input.client,
		puzzleSource: input.puzzleSource,
		contentOrigin: resolveContentOrigin(input),
		pieceCountBucket,
		aspectBucket,
		sessionMode: input.sessionMode,
		resultClass: input.resultClass,
		timingQuality: input.timingQuality,
		sessionOrigin: input.sessionOrigin,
		rotationUsed: input.rotationUsed,
		progressBucket,
		assistanceMode
	};

	return isAnalyticsEventInputV1({
		eventName: 'puzzle_opened',
		runId: CONTEXT_VALIDATION_RUN_ID,
		context,
		data: null
	})
		? context
		: null;
}
