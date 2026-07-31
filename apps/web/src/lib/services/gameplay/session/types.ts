// PuzzleSession bounded contract surface.
//
// The pure transition engine imports nothing from Svelte, the DOM, local
// storage, fetch, or analytics. Cross-runtime completion types come from
// @perseus/types so the client shares one contract with both API runtimes.

import type { ResultClass, TimingQuality, RecordPuzzleCompletionV1 } from '@perseus/types';
import type { Rotation } from '$lib/types/gameplay';
import type { PlacedPiece } from '$lib/types/puzzle';

export type { Rotation, PlacedPiece };
export type { ResultClass, TimingQuality, RecordPuzzleCompletionV1 };

// --- Primitive lifecycle / mode / origin types --------------------------------

export type SessionLifecycle = 'setup' | 'active' | 'paused' | 'completed' | 'disposed';
export type SessionMode = 'timed' | 'relaxed';
export type PuzzleSourceType = 'api' | 'local';
export type SessionOrigin = 'new' | 'resumed';
export type ReferenceMode = 'hold' | 'toggle' | 'ghost';
export type InventoryFilter = 'all' | 'corners' | 'edges' | 'center';

// A restorable lifecycle is any except the terminal in-memory `disposed`.
export type RestorableLifecycle = Exclude<SessionLifecycle, 'disposed'>;

// --- Completion effects -------------------------------------------------------

export type CompletionEffect = 'local_stats' | 'server_submission';

export type CompletionFailureCode =
	| 'storage_error'
	| 'network_error'
	| 'bad_request'
	| 'unauthorized'
	| 'not_found'
	| 'run_id_conflict'
	| 'completion_quota_exceeded'
	| 'internal_error'
	| 'incompatible_schema';

export type CompletionEffectState =
	| { status: 'pending' }
	| { status: 'succeeded' }
	| { status: 'failed'; code: CompletionFailureCode; retryable: boolean }
	| { status: 'not_applicable' };

/**
 * Immutable, once-per-run completion facts. Every completion request or retry
 * is projected from this seal; mutable post-completion state is never consulted.
 */
export interface SealedCompletion {
	readonly runId: string;
	readonly resultClass: ResultClass;
	readonly timingQuality: TimingQuality;
	readonly elapsedActiveSeconds: number | null;
	readonly completedAt: number;
	readonly localStats: CompletionEffectState;
	readonly serverSubmission: CompletionEffectState;
}

// --- Run IDs and clocks -------------------------------------------------------

export interface RunIdFactory {
	create(): string;
}

/**
 * Single injected time/scheduler surface shared by the engine and timer
 * presentation. Tests inject a deterministic implementation; production wires
 * one based on performance.now(), Date.now(), and setInterval/clearInterval.
 */
export interface Clock {
	monotonicNow(): number;
	wallNow(): number;
	setInterval(callback: () => void, milliseconds: number): unknown;
	clearInterval(handle: unknown): void;
}

// --- Counters, monotonic eligibility facts, organization ----------------------

export interface SessionCounters {
	incorrectAttempts: number;
	hintsUsed: number;
	referenceActivations: number;
}

/**
 * Monotonic eligibility facts. They only ever flip toward less-competitive and
 * are deliberately excluded from undo/redo history snapshots.
 */
export interface SessionFacts {
	rotationUsed: boolean;
	hintUsed: boolean;
	ghostReferenceUsed: boolean;
}

export type TrayOrganizationUpdate =
	| { type: 'reorder'; trayId: string; pieceIds: number[] }
	| { type: 'set_filter'; filter: InventoryFilter }
	| { type: 'set_active_tray'; trayId: string }
	| { type: 'move_piece'; pieceId: number; toTrayId: string }
	| { type: 'rename_tray'; trayId: string; name: string }
	| { type: 'remove_tray'; trayId: string };

export interface PersistedTrayOrganization {
	filter: InventoryFilter;
	activeTray: string;
	/** Piece-id -> tray-id membership. */
	membership: Record<number, string>;
	/** Tray-id -> display name. */
	names: Record<string, string>;
}

/**
 * Optional persisted viewport (zoom/pan) state. Reserved for a consuming
 * feature that explicitly opts into persisting it; absent until then. The
 * codec validates and preserves it across a round-trip even when the current
 * route does not populate it, per the approved persistence contract.
 */
export interface PersistedViewport {
	zoom: number;
	panX: number;
	panY: number;
}

// --- Runtime state ------------------------------------------------------------

export interface PuzzleSessionState {
	puzzleId: string;
	source: PuzzleSourceType;
	runId: string;
	origin: SessionOrigin;
	lifecycle: SessionLifecycle;
	mode: SessionMode;
	timingQuality: TimingQuality;

	/** Accumulated active whole seconds. `null` for relaxed and legacy_unknown. */
	elapsedActiveSeconds: number | null;
	/** Whether the clock has begun accumulating for this run. */
	timerStarted: boolean;

	pieceCount: number;
	gridCols: number;
	gridRows: number;
	placedPieces: PlacedPiece[];
	/** Canonical, persisted tray order. */
	trayOrder: number[];

	rotationEnabled: boolean;
	pieceRotations: Record<number, Rotation>;

	selectedPieceId: number | null;
	/** Runtime-only active reference mode; never serialized. */
	activeReferenceMode: ReferenceMode | null;

	/** Optional persisted tray organization (HPA-220/237 own the UI). */
	organization: PersistedTrayOrganization | null;

	/** Optional persisted viewport state; null until a feature opts in. */
	viewport: PersistedViewport | null;

	counters: SessionCounters;
	facts: SessionFacts;
	hasUserActivity: boolean;

	/** Derived result class for the current run. */
	resultClass: ResultClass;

	/** Present once the run has sealed completion; immutable thereafter. */
	sealedCompletion: SealedCompletion | null;

	/** Undo/redo availability (history itself is runtime-only). */
	canUndo: boolean;
	canRedo: boolean;
}

// --- Persisted schema ---------------------------------------------------------

export interface PersistedPuzzleSessionV1 {
	schemaVersion: 1;
	puzzleId: string;
	source: PuzzleSourceType;
	lifecycle: RestorableLifecycle;
	mode: SessionMode;
	runId: string;
	origin: SessionOrigin;
	elapsedActiveSeconds: number | null;
	timingQuality: TimingQuality;
	timerStarted: boolean;
	placedPieces: PlacedPiece[];
	trayOrder: number[];
	rotationEnabled: boolean;
	pieceRotations: Record<number, Rotation>;
	counters: SessionCounters;
	facts: SessionFacts;
	hasUserActivity: boolean;
	resultClass: ResultClass;
	sealedCompletion: SealedCompletion | null;
	organization?: PersistedTrayOrganization;
	viewport?: PersistedViewport;
	lastUpdated: number;
}

export const CURRENT_SESSION_SCHEMA_VERSION = 1;

export type SessionLoadResult =
	| { status: 'missing' }
	| { status: 'loaded'; snapshot: PersistedPuzzleSessionV1 }
	| { status: 'migrated'; snapshot: PersistedPuzzleSessionV1 }
	| { status: 'invalid'; reason: string }
	| { status: 'incompatible'; schemaVersion: number };

export interface SessionPersistenceError {
	kind: 'read_error' | 'write_error' | 'remove_error';
	puzzleId: string;
	cause: unknown;
}

export interface SessionStorageAdapter {
	loadSession(puzzleId: string, context: SessionValidationContext): SessionLoadResult;
	saveSession(puzzleId: string, snapshot: PersistedPuzzleSessionV1): void;
	clearSession(puzzleId: string): void;
	isResumable(snapshot: PersistedPuzzleSessionV1): boolean;
}

/**
 * Validation context supplied by the loader: the resolved puzzle and source
 * provide the canonical piece IDs, grid, source type, and canonical placement
 * coordinates used to validate a persisted/migrated snapshot.
 */
export interface SessionValidationContext {
	puzzleId: string;
	source: PuzzleSourceType;
	pieceIds: number[];
	gridCols: number;
	gridRows: number;
	pieceCount: number;
	/**
	 * Canonical placement descriptor for every piece. Used to validate that
	 * persisted placements sit in each piece's own correct cell, matching the
	 * same invariant the engine enforces on live placement.
	 */
	pieces: ReadonlyArray<{ id: number; correctX: number; correctY: number }>;
}

// --- Action contract ----------------------------------------------------------

export type PuzzleSessionAction =
	| { type: 'start' }
	| { type: 'pause' }
	| { type: 'resume' }
	| { type: 'restart' }
	| { type: 'dispose' }
	| { type: 'select_piece'; pieceId: number }
	| { type: 'cancel_selection' }
	| { type: 'set_rotation_mode'; enabled: boolean }
	| { type: 'rotate_piece'; pieceId: number }
	| { type: 'attempt_placement'; pieceId: number; x: number; y: number }
	| { type: 'complete' }
	| { type: 'undo' }
	| { type: 'redo' }
	| { type: 'use_hint' }
	| { type: 'set_reference_mode'; mode: ReferenceMode | null }
	| { type: 'update_tray_organization'; update: TrayOrganizationUpdate }
	| {
			type: 'acknowledge_completion_effect';
			runId: string;
			effect: CompletionEffect;
			result:
				| { status: 'succeeded' }
				| { status: 'failed'; code: CompletionFailureCode; retryable: boolean };
	  }
	| {
			type: 'retry_completion_effects';
			/**
			 * When true, also reset `unauthorized` failures to pending. By
			 * default (false/absent) unauthorized failures are skipped so
			 * hydration auto-retry does not re-submit a guaranteed-to-fail
			 * request for an anonymous user. The route sets this to true only
			 * after a newly authenticated transition or an explicit user retry.
			 */
			includeUnauthorized?: boolean;
	  }
	| { type: 'resume_completion_effects' };

// --- Outcomes -----------------------------------------------------------------

export type PlacementRejectionReason = 'wrong_slot' | 'non_upright';

export type PlacementOutcome =
	| { status: 'accepted'; completed: boolean }
	| { status: 'rejected'; reason: PlacementRejectionReason; counted: true }
	| {
			status: 'noop';
			reason:
				| 'lifecycle_disallows_gameplay'
				| 'unknown_piece'
				| 'duplicate_piece'
				| 'invalid_coordinates';
	  };

export type LifecycleNoopReason =
	| 'invalid_transition'
	| 'lifecycle_disallows'
	| 'disposed'
	| 'nothing_to_restart';

export type RotationModeNoopReason = 'lifecycle_disables_rotation_toggle' | 'pieces_already_placed';

export type SelectionNoopReason =
	| 'lifecycle_disallows_gameplay'
	| 'unknown_piece'
	| 'already_placed';

export type PuzzleSessionOutcome =
	| { type: 'lifecycle_transitioned'; from: SessionLifecycle; to: SessionLifecycle }
	| { type: 'lifecycle_noop'; reason: LifecycleNoopReason }
	| { type: 'selection_changed'; pieceId: number | null }
	| { type: 'selection_noop'; reason: SelectionNoopReason }
	| { type: 'placement'; outcome: PlacementOutcome }
	| { type: 'rotation_mode_changed'; enabled: boolean }
	| { type: 'rotation_mode_noop'; reason: RotationModeNoopReason }
	| { type: 'piece_rotated'; pieceId: number }
	| { type: 'rotation_noop'; reason: 'piece_not_rotatable' }
	| { type: 'history_restored'; direction: 'undo' | 'redo' }
	| { type: 'history_noop'; reason: 'empty' | 'at_start' | 'at_end' }
	| { type: 'hint_used'; pieceId: number | null }
	| { type: 'hint_noop'; reason: 'all_placed' | 'lifecycle_disallows_gameplay' }
	| { type: 'reference_mode_changed'; mode: ReferenceMode | null; activationCounted: boolean }
	| { type: 'reference_mode_noop'; reason: 'lifecycle_disallows_gameplay' }
	| { type: 'tray_organization_applied'; update: TrayOrganizationUpdate }
	| { type: 'tray_organization_noop'; reason: 'invalid_update' | 'not_implemented' }
	| { type: 'completion_sealed'; seal: SealedCompletion }
	| {
			type: 'completion_noop';
			reason:
				| 'already_sealed'
				| 'board_incomplete'
				| 'lifecycle_disallows'
				| 'no_retryable_effects'
				| 'no_pending_effects';
	  }
	| { type: 'effect_acknowledged'; effect: CompletionEffect }
	| { type: 'effect_acknowledgement_noop'; reason: 'run_id_mismatch' | 'effect_terminal' }
	| { type: 'disposed' };

// --- Events -------------------------------------------------------------------

export type PuzzleSessionEvent =
	| { type: 'state_changed' }
	| { type: 'placement_accepted'; pieceId: number; completed: boolean }
	| { type: 'placement_rejected'; pieceId: number; reason: PlacementRejectionReason }
	| { type: 'hint_target'; pieceId: number | null; target: { x: number; y: number } | null }
	| { type: 'completion_sealed'; seal: SealedCompletion }
	| {
			type: 'completion_effect_request';
			effect: CompletionEffect;
			seal: SealedCompletion;
	  }
	| { type: 'lifecycle'; from: SessionLifecycle; to: SessionLifecycle };

export type PuzzleSessionEventCallback = (event: PuzzleSessionEvent) => void;

// --- Construction -------------------------------------------------------------

export interface PuzzleMetadata {
	puzzleId: string;
	source: PuzzleSourceType;
	pieceCount: number;
	gridCols: number;
	gridRows: number;
	/** Canonical piece descriptors used to validate placements. */
	pieces: ReadonlyArray<{ id: number; correctX: number; correctY: number }>;
}

export interface CreatePuzzleSessionOptions {
	metadata: PuzzleMetadata;
	mode?: SessionMode;
	runIdFactory: RunIdFactory;
	clock: Clock;
	onEvent?: PuzzleSessionEventCallback;
	/** Restored snapshot (loaded or migrated). When absent, a fresh run is created. */
	restored?: PersistedPuzzleSessionV1;
	/**
	 * Canonical tray order for a fresh run. The route supplies its shuffled
	 * order; when omitted the engine falls back to ascending piece ids.
	 * Restored snapshots carry their own `trayOrder`.
	 */
	initialTrayOrder?: number[];
	/**
	 * Deterministic per-piece rotation generator used when rotation mode is
	 * enabled. Defaults to a seeded implementation derived from the puzzle id.
	 * Tests inject a fixed mapping.
	 */
	createRotations?: (pieceIds: number[]) => Record<number, Rotation>;
	/**
	 * Canonical tray-order factory used for fresh construction and restart.
	 * The route supplies a shuffle; the engine defaults to ascending piece ids.
	 */
	createTrayOrder?: () => number[];
}

// --- Seal projection ----------------------------------------------------------

/**
 * Project an immutable sealed completion into the v1 API request shape.
 * Excludes client-only fields like `completedAt`.
 */
export function completionRequestFromSeal(seal: SealedCompletion): RecordPuzzleCompletionV1 {
	return {
		version: 1,
		runId: seal.runId,
		resultClass: seal.resultClass,
		timingQuality: seal.timingQuality,
		elapsedActiveSeconds: seal.elapsedActiveSeconds
	};
}
