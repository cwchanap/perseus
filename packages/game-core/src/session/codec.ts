// Portable PuzzleSession codec: serialization, validation, and resumability.
//
// Framework-independent. Imports no Svelte, DOM, storage, fetch, or analytics.
// Storage keys, enumeration, and the browser crypto resolution stay with the
// app-specific adapters; this module only knows the persisted schema.
import type {
	PuzzleSessionState,
	PersistedPuzzleSessionV1,
	PersistedTrayOrganization,
	SessionValidationContext,
	SessionLoadResult,
	PlacedPiece,
	Rotation,
	RestorableLifecycle,
	SessionMode,
	SessionOrigin,
	PuzzleSourceType,
	ResultClass,
	CompletionEffectState,
	CompletionFailureCode,
	SealedCompletion,
	PersistedViewport
} from './types';
import { CURRENT_SESSION_SCHEMA_VERSION } from './types';
import {
	isPuzzleRunId,
	isRecordPuzzleCompletionV1,
	MAX_COMPLETION_TIME_SECONDS,
	RESULT_CLASSES
} from '@perseus/types';

const RESTORABLE_LIFECYCLES = new Set(['setup', 'active', 'paused', 'completed']);
const VALID_MODES = new Set<SessionMode>(['timed', 'relaxed']);
const VALID_ORIGINS = new Set<SessionOrigin>(['new', 'resumed']);
const VALID_SOURCES = new Set<PuzzleSourceType>(['api', 'local']);
const VALID_ROTATIONS = new Set<Rotation>([0, 90, 180, 270]);
const RESULT_CLASS_SET = new Set<string>(RESULT_CLASSES);
const COMPLETION_FAILURE_CODE_SET = new Set<string>([
	'storage_error',
	'network_error',
	'bad_request',
	'unauthorized',
	'not_found',
	'run_id_conflict',
	'completion_quota_exceeded',
	'internal_error'
]);
const VALID_ORG_FILTERS = new Set(['all', 'corners', 'edges', 'center']);

/**
 * Whether a completion failure code is retryable. Mirrors the route's
 * mapCompletionError policy: storage/network/internal/unauthorized are
 * retryable; bad_request/not_found/run_id_conflict/quota are terminal.
 * `unauthorized` is retryable so the engine's includeUnauthorized gate (not
 * the persisted flag) controls actual re-submission.
 *
 * Exported so the route's mapCompletionError derives `retryable` from the
 * same source as this validator, keeping the producer and consumer of the
 * persisted flag in lockstep.
 */
export function isFailureRetryable(code: CompletionFailureCode): boolean {
	return (
		code === 'storage_error' ||
		code === 'network_error' ||
		code === 'internal_error' ||
		code === 'unauthorized'
	);
}

/**
 * Allowlisted projection of runtime state to the persisted schema. Fields are
 * constructed explicitly — runtime state is never spread. Returns null for a
 * disposed session (the serializer never writes a restorable `disposed`).
 */
export function serializeSession(
	state: PuzzleSessionState,
	now: number = Date.now()
): PersistedPuzzleSessionV1 | null {
	if (state.lifecycle === 'disposed') return null;
	const snapshot: PersistedPuzzleSessionV1 = {
		schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
		puzzleId: state.puzzleId,
		source: state.source,
		lifecycle: state.lifecycle as RestorableLifecycle,
		mode: state.mode,
		runId: state.runId,
		origin: state.origin,
		elapsedActiveSeconds: state.elapsedActiveSeconds,
		timerStarted: state.timerStarted,
		placedPieces: state.placedPieces.map((piece) => ({
			pieceId: piece.pieceId,
			x: piece.x,
			y: piece.y
		})),
		trayOrder: state.trayOrder.slice(),
		rotationEnabled: state.rotationEnabled,
		pieceRotations: { ...state.pieceRotations },
		counters: { ...state.counters },
		facts: { ...state.facts },
		hasUserActivity: state.hasUserActivity,
		resultClass: state.resultClass,
		sealedCompletion: state.sealedCompletion ? cloneSeal(state.sealedCompletion) : null,
		lastUpdated: now
	};
	if (state.organization) {
		snapshot.organization = cloneOrganization(state.organization);
	}
	if (state.viewport) {
		snapshot.viewport = { ...state.viewport };
	}
	return snapshot;
}

/**
 * Load, version-check, and validate a persisted session. The codec
 * never partially hydrates invalid data.
 */
export function loadPersistedSession(
	raw: string | null,
	context: SessionValidationContext
): SessionLoadResult {
	if (raw === null) return { status: 'missing' };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { status: 'invalid', reason: 'malformed_json' };
	}

	if (!parsed || typeof parsed !== 'object') {
		return { status: 'invalid', reason: 'not_object' };
	}

	const record = parsed as Record<string, unknown>;
	if (record.schemaVersion !== CURRENT_SESSION_SCHEMA_VERSION) {
		return { status: 'invalid', reason: 'unsupported_schema_version' };
	}

	const snapshot = validateV1(record, context);
	return snapshot
		? { status: 'loaded', snapshot }
		: { status: 'invalid', reason: 'cross_field_violation' };
}

/**
 * Resumable only when there is real progress to continue: active or paused,
 * the player has begun interacting, and the run has not sealed completion.
 */
function hasResumableSessionState(record: Record<string, unknown>): boolean {
	return (
		(record.lifecycle === 'active' || record.lifecycle === 'paused') &&
		record.sealedCompletion === null &&
		record.hasUserActivity === true
	);
}

export function isResumable(snapshot: PersistedPuzzleSessionV1): boolean {
	return hasResumableSessionState(snapshot as unknown as Record<string, unknown>);
}

// --- V1 validation ------------------------------------------------------------

function validateV1(
	record: Record<string, unknown>,
	context: SessionValidationContext
): PersistedPuzzleSessionV1 | null {
	const knownPieceIds = new Set(context.pieceIds);

	const puzzleId = record.puzzleId;
	const source = record.source;
	if (puzzleId !== context.puzzleId) return null;
	if (!VALID_SOURCES.has(source as PuzzleSourceType)) return null;
	if (source !== context.source) return null;

	const lifecycle = record.lifecycle;
	if (typeof lifecycle !== 'string' || !RESTORABLE_LIFECYCLES.has(lifecycle)) return null;

	const mode = record.mode;
	const origin = record.origin;
	const resultClass = record.resultClass;
	if (!VALID_MODES.has(mode as SessionMode)) return null;
	if (!VALID_ORIGINS.has(origin as SessionOrigin)) return null;
	if (!RESULT_CLASS_SET.has(resultClass as string)) return null;

	const runId = record.runId;
	if (typeof runId !== 'string' || !isPuzzleRunId(runId)) return null;

	const elapsed = record.elapsedActiveSeconds;
	if (
		elapsed !== null &&
		(typeof elapsed !== 'number' ||
			!Number.isFinite(elapsed) ||
			elapsed < 0 ||
			!Number.isInteger(elapsed))
	) {
		return null;
	}
	if (mode === 'relaxed' && elapsed !== null) return null;
	// Inverse: a timed session must carry a whole-number elapsed
	// value. Without this, checkpointTime coalesces null to 0 and the
	// clock silently resumes from zero.
	if (mode === 'timed' && elapsed === null) return null;

	const timerStarted = record.timerStarted;
	if (typeof timerStarted !== 'boolean') return null;
	// Inverse: a relaxed session must not present a running timer — it
	// can never accumulate and would display a stuck clock.
	if (mode === 'relaxed' && timerStarted) return null;

	const lastUpdated = record.lastUpdated;
	if (
		typeof lastUpdated !== 'number' ||
		!Number.isFinite(lastUpdated) ||
		lastUpdated < 0 ||
		!Number.isInteger(lastUpdated)
	) {
		return null;
	}

	const placedPieces = validatePlacements(record.placedPieces, knownPieceIds, context);
	if (placedPieces === null) return null;

	const trayOrder = validateTrayOrder(record.trayOrder, knownPieceIds);
	if (trayOrder === null) return null;

	const rotationEnabled = record.rotationEnabled;
	if (typeof rotationEnabled !== 'boolean') return null;

	const pieceRotations = validateRotations(record.pieceRotations, knownPieceIds);
	if (pieceRotations === null) return null;

	const counters = validateCounters(record.counters);
	if (counters === null) return null;

	const facts = record.facts;
	if (
		!facts ||
		typeof facts !== 'object' ||
		typeof (facts as Record<string, unknown>).rotationUsed !== 'boolean' ||
		typeof (facts as Record<string, unknown>).hintUsed !== 'boolean' ||
		typeof (facts as Record<string, unknown>).ghostReferenceUsed !== 'boolean'
	) {
		return null;
	}

	// Cross-field consistency: resultClass must match the class derived from
	// mode and monotonic facts. The engine's recomputeResultClass uses the
	// same precedence. Without this check, a corrupted snapshot with
	// hintUsed: true and resultClass: standard_timed would be accepted and
	// sealed with standard_timed, making an assisted solve eligible for
	// standard-best accounting.
	const derivedFacts = facts as Record<string, boolean>;
	const expectedClass: ResultClass =
		mode === 'relaxed'
			? 'relaxed'
			: derivedFacts.hintUsed || derivedFacts.ghostReferenceUsed
				? 'assisted_timed'
				: derivedFacts.rotationUsed
					? 'rotation_timed'
					: 'standard_timed';
	if (resultClass !== expectedClass) return null;

	// Cross-field consistency between monotonic facts and the persisted
	// counters/state that produced them. resultClass alone does not catch a
	// snapshot whose facts disagree with the rest of the record: e.g.
	// rotationEnabled: true with rotationUsed: false, or hintsUsed: 5 with
	// hintUsed: false. Such a record could load and later complete with the
	// wrong eligibility.
	const hasRotations = rotationEnabled || Object.keys(pieceRotations).length > 0;
	if (hasRotations && !derivedFacts.rotationUsed) return null;
	if (counters.hintsUsed > 0 && !derivedFacts.hintUsed) return null;
	if (derivedFacts.hintUsed && counters.hintsUsed <= 0) return null;
	if (derivedFacts.ghostReferenceUsed && counters.referenceActivations <= 0) return null;

	const hasUserActivity = record.hasUserActivity;
	if (typeof hasUserActivity !== 'boolean') return null;
	// Placements, counted actions, or a monotonic rotation fact all imply the
	// player has interacted. A snapshot with any of these but hasUserActivity
	// false is corruption and would be hidden by resume discovery.
	const hasCountedAction =
		placedPieces.length > 0 ||
		counters.incorrectAttempts > 0 ||
		counters.hintsUsed > 0 ||
		counters.referenceActivations > 0;
	// Narrow exception: a setup-only configure_setup action may persist
	// pieceRotations + rotationUsed while the session still has no user
	// activity. Every activity signal must be absent — zero placements, zero
	// counters, timer not started, not completed, no sealed completion — so
	// this can never mask a genuinely active run. configure_setup clears both
	// the rotation map and the rotation fact when rotation is disabled, so a
	// snapshot with rotationEnabled: false plus residual rotations is
	// corruption: require rotationEnabled so a malformed record cannot
	// restore with rotation shown as disabled while retaining rotation_timed
	// eligibility.
	const isPreActivityConfiguredRotation =
		derivedFacts.rotationUsed &&
		rotationEnabled &&
		hasRotations &&
		!hasUserActivity &&
		placedPieces.length === 0 &&
		counters.incorrectAttempts === 0 &&
		counters.hintsUsed === 0 &&
		counters.referenceActivations === 0 &&
		timerStarted === false &&
		// A pre-activity run must sit at its mode's baseline clock: timed
		// starts at zero and relaxed never accumulates (see doConfigureSetup),
		// so any elapsed time contradicts "configured but genuinely unused"
		// and would let a fabricated snapshot resume timing from later.
		elapsed === (mode === 'timed' ? 0 : null) &&
		lifecycle !== 'completed' &&
		record.sealedCompletion === null;
	if (
		(hasCountedAction || derivedFacts.rotationUsed) &&
		!hasUserActivity &&
		!isPreActivityConfiguredRotation
	) {
		return null;
	}

	const sealedCompletion = validateSeal(
		record.sealedCompletion,
		runId as string,
		source as PuzzleSourceType,
		counters,
		{
			rotationUsed: derivedFacts.rotationUsed,
			ghostReferenceUsed: derivedFacts.ghostReferenceUsed
		}
	);
	if (sealedCompletion === false) return null;
	const seal = sealedCompletion === null ? null : (sealedCompletion as unknown as SealedCompletion);

	if (lifecycle === 'completed' && seal === null) return null;

	// The seal's result class and the outer session's derived result class
	// are validated independently (seal.resultClass against RESULT_CLASS_SET
	// in validateSeal; outer resultClass against RESULT_CLASS_SET and the
	// facts-derived class above). They are NOT required to match: after an
	// undo, hint use, and redo the engine retains the original seal (sealed
	// at the completion boundary under the then-current class) while the
	// outer result class recomputes from the now-mutated monotonic facts.
	// Requiring equality here would reject that valid retained-seal state on
	// reload. The seal records the class under which effects were submitted;
	// the outer class records the current live eligibility.

	// A completed run must have every piece placed. The engine seals
	// completion only on a full board; a completed snapshot with missing
	// placements is corruption.
	if (lifecycle === 'completed' && placedPieces.length !== knownPieceIds.size) return null;
	// Inverse: a full board implies the run completed. Restoring a full board
	// in an active/paused lifecycle leaves no inventory pieces to place and no
	// completion event to generate the missing seal or effects — a dead state.
	// The engine only ever reaches a full board through completion sealing, so
	// any other combination is corruption.
	if (placedPieces.length === knownPieceIds.size && lifecycle !== 'completed') return null;

	const organization = validateOrganization(record.organization, knownPieceIds);
	if (organization === false) return null;

	const viewport = validateViewport(record.viewport);
	if (viewport === false) return null;

	const snapshot: PersistedPuzzleSessionV1 = {
		schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
		puzzleId: puzzleId as string,
		source: source as PuzzleSourceType,
		lifecycle: lifecycle as RestorableLifecycle,
		mode: mode as SessionMode,
		runId: runId as string,
		origin: origin as SessionOrigin,
		elapsedActiveSeconds: elapsed as number | null,
		timerStarted: timerStarted as boolean,
		placedPieces,
		trayOrder,
		rotationEnabled: rotationEnabled as boolean,
		pieceRotations,
		counters,
		facts: {
			rotationUsed: (facts as Record<string, boolean>).rotationUsed,
			hintUsed: (facts as Record<string, boolean>).hintUsed,
			ghostReferenceUsed: (facts as Record<string, boolean>).ghostReferenceUsed
		},
		hasUserActivity: hasUserActivity as boolean,
		resultClass: resultClass as ResultClass,
		sealedCompletion: seal,
		lastUpdated: lastUpdated as number
	};
	if (organization) snapshot.organization = organization;
	if (viewport) snapshot.viewport = viewport;
	return snapshot;
}

function validatePlacements(
	raw: unknown,
	knownPieceIds: Set<number>,
	context: SessionValidationContext
): PlacedPiece[] | null {
	if (!Array.isArray(raw)) return null;
	// Canonical cell for each piece, mirroring the engine's correctX/correctY
	// invariant. A persisted placement must sit in its piece's own correct cell.
	const canonical = new Map(
		context.pieces.map((piece) => [piece.id, { x: piece.correctX, y: piece.correctY }])
	);
	const seen = new Set<number>();
	const occupied = new Set<string>();
	const out: PlacedPiece[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object') return null;
		const { pieceId, x, y } = entry as Record<string, unknown>;
		if (typeof pieceId !== 'number' || !Number.isInteger(pieceId)) return null;
		if (typeof x !== 'number' || !Number.isInteger(x)) return null;
		if (typeof y !== 'number' || !Number.isInteger(y)) return null;
		if (!knownPieceIds.has(pieceId)) return null;
		if (seen.has(pieceId)) return null;
		if (x < 0 || y < 0 || x >= context.gridCols || y >= context.gridRows) return null;
		// Each piece must occupy its canonical cell — the same invariant the
		// engine enforces on live placement. Without this, a corrupted
		// completed snapshot could restore and replay effects with pieces in
		// wrong cells.
		const expected = canonical.get(pieceId);
		if (!expected || expected.x !== x || expected.y !== y) return null;
		// Unique occupied cell. Canonical coordinates already guarantee this
		// when each piece has a distinct correct cell; this is defense in depth
		// against a context whose pieces share a cell.
		const cellKey = `${x},${y}`;
		if (occupied.has(cellKey)) return null;
		occupied.add(cellKey);
		seen.add(pieceId);
		out.push({ pieceId, x, y });
	}
	return out;
}

function validateTrayOrder(raw: unknown, knownPieceIds: Set<number>): number[] | null {
	if (!Array.isArray(raw)) return null;
	if (raw.length !== knownPieceIds.size) return null;
	const seen = new Set<number>();
	for (const id of raw) {
		if (typeof id !== 'number' || !Number.isInteger(id) || !knownPieceIds.has(id)) return null;
		if (seen.has(id)) return null;
		seen.add(id);
	}
	return raw.slice();
}

function validateRotations(
	raw: unknown,
	knownPieceIds: Set<number>
): Record<number, Rotation> | null {
	if (!raw || typeof raw !== 'object') return null;
	const out: Record<number, Rotation> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const id = Number(key);
		if (!Number.isInteger(id) || !knownPieceIds.has(id)) return null;
		if (!VALID_ROTATIONS.has(value as Rotation)) return null;
		out[id] = value as Rotation;
	}
	return out;
}

function validateCounters(raw: unknown): PuzzleSessionState['counters'] | null {
	if (!raw || typeof raw !== 'object') return null;
	const c = raw as Record<string, unknown>;
	if (
		typeof c.incorrectAttempts !== 'number' ||
		!Number.isInteger(c.incorrectAttempts) ||
		c.incorrectAttempts < 0
	)
		return null;
	if (typeof c.hintsUsed !== 'number' || !Number.isInteger(c.hintsUsed) || c.hintsUsed < 0)
		return null;
	if (
		typeof c.referenceActivations !== 'number' ||
		!Number.isInteger(c.referenceActivations) ||
		c.referenceActivations < 0
	)
		return null;
	return {
		incorrectAttempts: c.incorrectAttempts,
		hintsUsed: c.hintsUsed,
		referenceActivations: c.referenceActivations
	};
}

function validateEffectState(raw: unknown): CompletionEffectState | false | null {
	if (raw === null) return null; // absent state: caller decides applicability
	if (typeof raw !== 'object') return false;
	const state = (raw as Record<string, unknown>).status;
	if (state === 'pending' || state === 'succeeded' || state === 'not_applicable') {
		return { status: state };
	}
	if (state === 'failed') {
		const code = (raw as Record<string, unknown>).code;
		const retryable = (raw as Record<string, unknown>).retryable;
		if (typeof code !== 'string' || typeof retryable !== 'boolean') return false;
		if (!COMPLETION_FAILURE_CODE_SET.has(code)) return false;
		// Retryability must agree with the failure code, matching the policy
		// the route uses when producing failures. A corrupted snapshot with a
		// terminal code marked retryable would be re-driven forever, and a
		// retryable code marked terminal would permanently lose the completion.
		if (retryable !== isFailureRetryable(code as CompletionFailureCode)) return false;
		return { status: 'failed', code: code as CompletionFailureCode, retryable };
	}
	return false;
}

function validateSealCounter(raw: unknown, outerCounter: number): number | null {
	// The field is required: snapshots persisted before the summary facts
	// were added to SealedCompletion cannot be safely back-filled from outer
	// state, because the outer counters may have diverged from the completion
	// boundary via complete → dismiss → undo → hint → redo before the snapshot
	// was ever loaded by this version. Rejecting the absent field invalidates
	// those old snapshots cleanly rather than reconstructing contradictory facts.
	if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > outerCounter) {
		return null;
	}
	return raw;
}

function validateSeal(
	raw: unknown,
	expectedRunId: string,
	source: PuzzleSourceType,
	outerCounters: { incorrectAttempts: number; hintsUsed: number; referenceActivations: number },
	outerFacts: { rotationUsed: boolean; ghostReferenceUsed: boolean }
): SealedCompletion | null | false {
	if (raw === null) return null;
	if (!raw || typeof raw !== 'object') return false;
	const s = raw as Record<string, unknown>;
	if (s.runId !== expectedRunId) return false;
	if (!RESULT_CLASS_SET.has(s.resultClass as string)) return false;
	if (typeof s.completedAt !== 'number' || !Number.isFinite(s.completedAt) || s.completedAt < 0) {
		return false;
	}
	const elapsed = s.elapsedActiveSeconds;
	if (
		elapsed !== null &&
		(typeof elapsed !== 'number' || !Number.isFinite(elapsed) || elapsed < 0)
	) {
		return false;
	}
	// Validate the projected completion request against the same contract the
	// server enforces (isRecordPuzzleCompletionV1). Without this, a persisted
	// seal with e.g. elapsed 0, a fractional value, or a null-for-timed
	// value would pass local validation but be rejected by the server when
	// hydration replays the pending submission — permanently losing it as a
	// terminal bad_request.
	const projectedRequest = {
		version: 1,
		runId: s.runId,
		resultClass: s.resultClass,
		elapsedActiveSeconds: elapsed
	};
	if (!isRecordPuzzleCompletionV1(projectedRequest, MAX_COMPLETION_TIME_SECONDS)) {
		return false;
	}
	// Completion effects must be present and applicable. A missing/null
	// effect is corruption (the engine always emits a
	// concrete state), so reject rather than silently defaulting to
	// not_applicable — otherwise a corrupted API snapshot with null effects
	// would load and permanently suppress both local stats and the server
	// submission.
	const localStats = validateEffectState(s.localStats);
	if (localStats === null || localStats === false) return false;
	// Local stats apply to every completion; not_applicable is never valid.
	if ((localStats as CompletionEffectState).status === 'not_applicable') return false;
	// local_stats only ever fails with storage_error (a transient localStorage
	// write failure in recordLocalCompletion). Any other code is corruption.
	if (
		(localStats as CompletionEffectState).status === 'failed' &&
		(localStats as { code?: string }).code !== 'storage_error'
	)
		return false;
	const serverSubmission = validateEffectState(s.serverSubmission);
	if (serverSubmission === null || serverSubmission === false) return false;
	// Server submission is not_applicable only for local puzzles. For an API
	// puzzle it must be a concrete pending/succeeded/failed state; for a local
	// puzzle it must always be not_applicable (there is no server to submit to).
	if (source === 'api') {
		if ((serverSubmission as CompletionEffectState).status === 'not_applicable') return false;
	} else {
		if ((serverSubmission as CompletionEffectState).status !== 'not_applicable') return false;
	}
	// server_submission never fails with the local-stats-only storage_error
	// code, which belongs only to the localStats localStorage write path.
	if (
		(serverSubmission as CompletionEffectState).status === 'failed' &&
		(serverSubmission as { code?: string }).code === 'storage_error'
	)
		return false;
	// Summary facts are required on the seal. They are captured at the
	// completion boundary and must not be inferred from outer state: a
	// pre-upgrade snapshot can already have diverged via complete → dismiss
	// → undo → hint → redo before it is loaded by this version, so the outer
	// counters/facts no longer equal the sealed values. Counters must also
	// not exceed the monotonic outer counters that produced the seal — a
	// stale or corrupted value would let the completion dialog present facts
	// that contradict the recorded run.
	const hintsUsed = validateSealCounter(s.hintsUsed, outerCounters.hintsUsed);
	if (hintsUsed === null) return false;
	const incorrectAttempts = validateSealCounter(
		s.incorrectAttempts,
		outerCounters.incorrectAttempts
	);
	if (incorrectAttempts === null) return false;
	if (typeof s.rotationEnabled !== 'boolean') return false;
	if (typeof s.rotationUsed !== 'boolean') return false;

	const sealClass = s.resultClass as ResultClass;
	const rotationUsed = s.rotationUsed as boolean;

	// Monotonic outer fact: rotationUsed only goes false → true (enabling
	// rotation sets it true; disabling preserves it; undo/redo never
	// restores facts; configure_setup is blocked once a seal exists). A
	// seal capturing rotationUsed: true while the outer monotonic fact is
	// still false is impossible — the outer fact could only have been true
	// at seal time and must remain true.
	if (rotationUsed && !outerFacts.rotationUsed) return false;

	// Internal consistency: the sealed summary facts must explain the
	// seal's own resultClass. The seal captures hintsUsed and rotationUsed
	// at the completion boundary, so standard_timed and rotation_timed are
	// validated against those captured facts alone. The seal does NOT
	// capture ghostReferenceUsed, so the monotonic outer ghostReferenceUsed
	// can only be used in the direction monotonicity guarantees: false now
	// ⇒ false at seal time. The converse is unsound — true now could have
	// become true after the seal was retained, via the legitimate sequence
	// complete → undo → set_reference_mode('ghost') → redo (undo/redo
	// restore only placements/rotations, never facts; the seal is retained
	// without resealing). That produces a standard_timed or rotation_timed
	// retained seal alongside an outer ghostReferenceUsed=true live state,
	// and must not be rejected.
	//
	// For assisted_timed with hintsUsed=0, the seal's class requires
	// ghost-reference assistance was active at seal time. Monotonicity
	// gives the needed implication: if outer ghostReferenceUsed is false
	// now, it was false at seal time, so a zero-hint assisted seal could
	// not have been assisted — corruption. True now is consistent (it was
	// true at seal time, or became true later; both are compatible with an
	// assisted seal that already had ghost assistance at seal time).
	if (sealClass === 'standard_timed') {
		if (hintsUsed > 0 || rotationUsed) return false;
	} else if (sealClass === 'rotation_timed') {
		if (!rotationUsed || hintsUsed > 0) return false;
	} else if (sealClass === 'assisted_timed') {
		// assisted_timed arises from hint use OR ghost-reference use. The
		// seal does not capture ghostReferenceUsed, so a zero-hint assisted
		// seal is valid only when the monotonic outer ghostReferenceUsed
		// confirms ghost-reference assistance was active at seal time
		// (false now ⇒ false at seal ⇒ could not be assisted). Requiring
		// hintsUsed > 0 would reject legitimate ghost-reference assisted
		// completions.
		if (hintsUsed === 0 && !outerFacts.ghostReferenceUsed) return false;
	}
	// 'relaxed' is unconstrained: relaxed mode allows any combination of
	// hints/rotation/ghost-reference; the class is solely mode-derived.

	return {
		runId: s.runId as string,
		resultClass: s.resultClass as ResultClass,
		elapsedActiveSeconds: (elapsed as number | null) ?? null,
		completedAt: s.completedAt as number,
		localStats: localStats as CompletionEffectState,
		serverSubmission: serverSubmission as CompletionEffectState,
		hintsUsed,
		incorrectAttempts,
		rotationEnabled: s.rotationEnabled,
		rotationUsed: s.rotationUsed
	};
}

function validateOrganization(
	raw: unknown,
	knownPieceIds: Set<number>
): PersistedTrayOrganization | false | undefined {
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== 'object') return false;
	const o = raw as Record<string, unknown>;
	if (o.filter !== undefined && !VALID_ORG_FILTERS.has(o.filter as string)) {
		return false;
	}
	if (o.activeTray !== undefined && typeof o.activeTray !== 'string') return false;

	// membership: piece-id (numeric key) -> tray-id (string value).
	// Reject any piece ID not in the puzzle's known set — the runtime
	// (doSelect, doAttemptPlacement) rejects unknown pieces via pieceById,
	// and a persisted membership entry for an unknown piece is corruption.
	const membership: Record<number, string> = {};
	if (o.membership !== undefined) {
		if (typeof o.membership !== 'object' || o.membership === null || Array.isArray(o.membership))
			return false;
		for (const [key, value] of Object.entries(o.membership as Record<string, unknown>)) {
			const id = Number(key);
			if (!Number.isInteger(id) || id < 0) return false;
			if (!knownPieceIds.has(id)) return false;
			if (typeof value !== 'string') return false;
			membership[id] = value;
		}
	}

	// names: tray-id (string key) -> display name (string value).
	const names: Record<string, string> = {};
	if (o.names !== undefined) {
		if (typeof o.names !== 'object' || o.names === null || Array.isArray(o.names)) return false;
		for (const [key, value] of Object.entries(o.names as Record<string, unknown>)) {
			if (typeof value !== 'string') return false;
			names[key] = value;
		}
	}

	return {
		filter: (o.filter as PersistedTrayOrganization['filter']) ?? 'all',
		activeTray: (o.activeTray as string) ?? 'main',
		membership,
		names
	};
}

/**
 * Validate an optional persisted viewport. Returns `undefined` when absent
 * (the current route does not populate it), the validated value when present,
 * or `false` on a malformed shape. A recognized viewport must survive a
 * round-trip per the approved persistence contract.
 */
function validateViewport(raw: unknown): PersistedViewport | false | undefined {
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== 'object') return false;
	const v = raw as Record<string, unknown>;
	const { zoom, panX, panY } = v;
	if (
		typeof zoom !== 'number' ||
		!Number.isFinite(zoom) ||
		zoom <= 0 ||
		typeof panX !== 'number' ||
		!Number.isFinite(panX) ||
		typeof panY !== 'number' ||
		!Number.isFinite(panY)
	) {
		return false;
	}
	return { zoom, panX, panY };
}

function cloneSeal(seal: SealedCompletion): SealedCompletion {
	return {
		runId: seal.runId,
		resultClass: seal.resultClass,
		elapsedActiveSeconds: seal.elapsedActiveSeconds,
		completedAt: seal.completedAt,
		localStats: { ...seal.localStats },
		serverSubmission: { ...seal.serverSubmission },
		hintsUsed: seal.hintsUsed,
		incorrectAttempts: seal.incorrectAttempts,
		rotationEnabled: seal.rotationEnabled,
		rotationUsed: seal.rotationUsed
	};
}

function cloneOrganization(org: PersistedTrayOrganization): PersistedTrayOrganization {
	return {
		filter: org.filter,
		activeTray: org.activeTray,
		membership: { ...org.membership },
		names: { ...org.names }
	};
}
