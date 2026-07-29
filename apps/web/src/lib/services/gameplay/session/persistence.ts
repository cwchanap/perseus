// Synchronous, browser-compatible run-ID and canonical-JSON helpers.
//
// The codec must remain synchronous and must not depend on the secure-context
// only `crypto.subtle`. SHA-256 uses the audited `@noble/hashes` WASM-free
// implementation over UTF-8 bytes.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type {
	RunIdFactory,
	PuzzleSessionState,
	PersistedPuzzleSessionV1,
	PersistedTrayOrganization,
	SessionValidationContext,
	SessionLoadResult,
	SessionStorageAdapter,
	SessionPersistenceError,
	PlacedPiece,
	Rotation,
	RestorableLifecycle,
	SessionMode,
	SessionOrigin,
	PuzzleSourceType,
	TimingQuality,
	ResultClass,
	CompletionEffectState,
	CompletionFailureCode,
	SealedCompletion
} from './types';
import { CURRENT_SESSION_SCHEMA_VERSION } from './types';
import { isPuzzleRunId, RESULT_CLASSES, TIMING_QUALITIES } from '@perseus/types';

/**
 * SHA-256 over the UTF-8 bytes of `value`, returned as 64 lowercase hex chars.
 */
export function sha256Hex(value: string): string {
	return bytesToHex(sha256(utf8ToBytes(value)));
}

/**
 * Canonical JSON form: object keys sorted recursively (arrays preserve order,
 * undefined object properties omitted). Used to produce a stable hash input so
 * the same logical payload yields the same run id regardless of insertion order.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (value === null || typeof value !== 'object') {
		return value;
	}
	const input = value as Record<string, unknown>;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		const child = input[key];
		if (child !== undefined) {
			sorted[key] = canonicalize(child);
		}
	}
	return sorted;
}

/**
 * Deterministic legacy run id: `legacy-` + SHA-256 of the canonical JSON of the
 * raw legacy payload. The raw value is canonicalized as-is — before any
 * migration normalization — so a failed migration write produces the same id on
 * retry. The original `lastUpdated` is part of the hashed payload.
 */
export function legacyRunId(rawLegacyValue: unknown): string {
	return `legacy-${sha256Hex(canonicalJson(rawLegacyValue))}`;
}

/**
 * Factory for fresh canonical lowercase UUID v4 run ids. Uses `crypto.randomUUID`
 * when present, and otherwise formats 16 bytes from `crypto.getRandomValues`,
 * setting the version (4) and variant (8-b) nibbles. Never falls back to
 * `Math.random`. The optional crypto surface lets tests inject deterministic
 * bytes; production passes the global `crypto` (or omits it).
 */
export function createBrowserRunIdFactory(cryptoSource?: Crypto): RunIdFactory {
	const source =
		cryptoSource ??
		(typeof crypto !== 'undefined'
			? (globalThis as unknown as { crypto: Crypto }).crypto
			: undefined);
	if (source && typeof source.randomUUID === 'function') {
		return { create: () => source.randomUUID() };
	}
	return { create: () => fallbackUuidV4(source) };
}

function fallbackUuidV4(source: Crypto | undefined): string {
	const cryptoObj = source ?? (globalThis as unknown as { crypto: Crypto }).crypto;
	const bytes = new Uint8Array(16);
	cryptoObj.getRandomValues(bytes);
	// RFC 4122 v4: version nibble (byte 6 high) = 0100, variant (byte 8 high) = 10.
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytesToHex(bytes);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const PROGRESS_KEY_PREFIX = 'puzzle-progress-';
const RESTORABLE_LIFECYCLES = new Set(['setup', 'active', 'paused', 'completed']);
const VALID_MODES = new Set<SessionMode>(['timed', 'relaxed']);
const VALID_ORIGINS = new Set<SessionOrigin>(['new', 'resumed']);
const VALID_SOURCES = new Set<PuzzleSourceType>(['api', 'local']);
const VALID_ROTATIONS = new Set<Rotation>([0, 90, 180, 270]);
const RESULT_CLASS_SET = new Set<string>(RESULT_CLASSES);
const TIMING_QUALITY_SET = new Set<string>(TIMING_QUALITIES);

function progressKey(puzzleId: string): string {
	return `${PROGRESS_KEY_PREFIX}${puzzleId}`;
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
		timingQuality: state.timingQuality,
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
	return snapshot;
}

/**
 * Load, version-check, and validate/migrate a persisted session. The codec
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
	if (Object.hasOwn(record, 'schemaVersion')) {
		const version = record.schemaVersion;
		if (typeof version !== 'number' || !Number.isInteger(version)) {
			return { status: 'invalid', reason: 'bad_schema_version' };
		}
		if (version > CURRENT_SESSION_SCHEMA_VERSION) {
			return { status: 'incompatible', schemaVersion: version };
		}
		if (version === CURRENT_SESSION_SCHEMA_VERSION) {
			const result = validateV1(record, context);
			return result === null
				? { status: 'invalid', reason: 'cross_field_violation' }
				: { status: 'loaded', snapshot: result };
		}
		return { status: 'invalid', reason: 'unsupported_schema_version' };
	}

	// Legacy v0 (no schemaVersion).
	const migrated = migrateV0toV1(record, context);
	if (migrated === null) {
		return { status: 'invalid', reason: 'legacy_migration_failed' };
	}
	return { status: 'migrated', snapshot: migrated };
}

/**
 * Resumable only when there is real progress to continue: active or paused,
 * the player has begun interacting, and the run has not sealed completion.
 */
export function isResumable(snapshot: PersistedPuzzleSessionV1): boolean {
	if (snapshot.lifecycle !== 'active' && snapshot.lifecycle !== 'paused') return false;
	if (snapshot.sealedCompletion !== null) return false;
	return snapshot.hasUserActivity;
}

// --- Deterministic legacy tray order ------------------------------------------

export function fnv1aUtf8(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function deterministicLegacyTrayOrder(pieceIds: number[], puzzleId: string): number[] {
	const sorted = pieceIds.slice().sort((a, b) => a - b);
	const rng = mulberry32(fnv1aUtf8(puzzleId));
	const out = sorted.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
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
	const timingQuality = record.timingQuality;
	const resultClass = record.resultClass;
	if (!VALID_MODES.has(mode as SessionMode)) return null;
	if (!VALID_ORIGINS.has(origin as SessionOrigin)) return null;
	if (!TIMING_QUALITY_SET.has(timingQuality as string)) return null;
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
	if (timingQuality === 'legacy_unknown' && elapsed !== null) return null;

	const timerStarted = record.timerStarted;
	if (typeof timerStarted !== 'boolean') return null;
	if (timingQuality === 'legacy_unknown' && timerStarted) return null;

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

	const hasUserActivity = record.hasUserActivity;
	if (typeof hasUserActivity !== 'boolean') return null;

	const sealedCompletion = validateSeal(record.sealedCompletion, runId as string);
	if (sealedCompletion === false) return null;
	const seal = sealedCompletion === null ? null : (sealedCompletion as unknown as SealedCompletion);

	if (lifecycle === 'completed' && seal === null) return null;

	const organization = validateOrganization(record.organization);
	if (organization === false) return null;

	const snapshot: PersistedPuzzleSessionV1 = {
		schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
		puzzleId: puzzleId as string,
		source: source as PuzzleSourceType,
		lifecycle: lifecycle as RestorableLifecycle,
		mode: mode as SessionMode,
		runId: runId as string,
		origin: origin as SessionOrigin,
		elapsedActiveSeconds: elapsed as number | null,
		timingQuality: timingQuality as TimingQuality,
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
	return snapshot;
}

function validatePlacements(
	raw: unknown,
	knownPieceIds: Set<number>,
	context: SessionValidationContext
): PlacedPiece[] | null {
	if (!Array.isArray(raw)) return null;
	const seen = new Set<number>();
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
	if (raw === null) return null; // absent state: caller uses not_applicable, never pending
	if (typeof raw !== 'object') return false;
	const state = (raw as Record<string, unknown>).status;
	if (state === 'pending' || state === 'succeeded' || state === 'not_applicable') {
		return { status: state };
	}
	if (state === 'failed') {
		const code = (raw as Record<string, unknown>).code;
		const retryable = (raw as Record<string, unknown>).retryable;
		if (typeof code !== 'string' || typeof retryable !== 'boolean') return false;
		return { status: 'failed', code: code as CompletionFailureCode, retryable };
	}
	return false;
}

function validateSeal(raw: unknown, expectedRunId: string): SealedCompletion | null | false {
	if (raw === null) return null;
	if (!raw || typeof raw !== 'object') return false;
	const s = raw as Record<string, unknown>;
	if (s.runId !== expectedRunId) return false;
	if (!RESULT_CLASS_SET.has(s.resultClass as string)) return false;
	if (!TIMING_QUALITY_SET.has(s.timingQuality as string)) return false;
	if (typeof s.completedAt !== 'number' || !Number.isFinite(s.completedAt)) return false;
	const elapsed = s.elapsedActiveSeconds;
	if (
		elapsed !== null &&
		(typeof elapsed !== 'number' || !Number.isFinite(elapsed) || elapsed < 0)
	) {
		return false;
	}
	const localStats = validateEffectState(s.localStats);
	if (localStats === false) return false;
	const serverSubmission = validateEffectState(s.serverSubmission);
	if (serverSubmission === false) return false;
	return {
		runId: s.runId as string,
		resultClass: s.resultClass as ResultClass,
		timingQuality: s.timingQuality as TimingQuality,
		elapsedActiveSeconds: (elapsed as number | null) ?? null,
		completedAt: s.completedAt as number,
		localStats: (localStats as CompletionEffectState) ?? { status: 'not_applicable' },
		serverSubmission: (serverSubmission as CompletionEffectState) ?? { status: 'not_applicable' }
	};
}

function validateOrganization(raw: unknown): PersistedTrayOrganization | false | undefined {
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== 'object') return false;
	const o = raw as Record<string, unknown>;
	if (
		o.filter !== undefined &&
		!['all', 'corners', 'edges', 'center'].includes(o.filter as string)
	) {
		return false;
	}
	if (o.activeTray !== undefined && typeof o.activeTray !== 'string') return false;
	if (
		o.membership !== undefined &&
		(typeof o.membership !== 'object' || o.membership === null || Array.isArray(o.membership))
	)
		return false;
	if (
		o.names !== undefined &&
		(typeof o.names !== 'object' || o.names === null || Array.isArray(o.names))
	)
		return false;
	return {
		filter: (o.filter as PersistedTrayOrganization['filter']) ?? 'all',
		activeTray: (o.activeTray as string) ?? 'main',
		membership: { ...((o.membership as Record<string, unknown>) ?? {}) } as Record<number, string>,
		names: { ...((o.names as Record<string, unknown>) ?? {}) } as Record<string, string>
	};
}

// --- Legacy migration ---------------------------------------------------------

function migrateV0toV1(
	record: Record<string, unknown>,
	context: SessionValidationContext
): PersistedPuzzleSessionV1 | null {
	if (record.puzzleId !== undefined && record.puzzleId !== context.puzzleId) return null;

	const placedPieces = validatePlacements(record.placedPieces, new Set(context.pieceIds), context);
	if (placedPieces === null) return null;

	const rotationEnabled =
		typeof record.rotationEnabled === 'boolean' ? record.rotationEnabled : false;
	const pieceRotations =
		record.pieceRotations && typeof record.pieceRotations === 'object'
			? validateRotations(record.pieceRotations, new Set(context.pieceIds))
			: {};
	if (pieceRotations === null) return null;

	const hasRotation = rotationEnabled || Object.keys(pieceRotations).length > 0;
	const hasUserActivity = placedPieces.length > 0 || hasRotation;
	const allPlaced =
		context.pieceIds.length > 0 &&
		context.pieceIds.every((id) => placedPieces.some((placement) => placement.pieceId === id));

	const lastUpdatedMs = parseLegacyLastUpdated(record.lastUpdated);
	const runId = legacyRunId(record);
	const trayOrder = deterministicLegacyTrayOrder(context.pieceIds, context.puzzleId);

	const resultClass: ResultClass = hasRotation ? 'rotation_timed' : 'standard_timed';

	let seal: SealedCompletion | null = null;
	if (allPlaced) {
		seal = {
			runId,
			resultClass,
			timingQuality: 'legacy_unknown',
			elapsedActiveSeconds: null,
			completedAt: lastUpdatedMs,
			// Terminal effect states prevent re-submission of historical solves.
			localStats: { status: 'succeeded' },
			serverSubmission:
				context.source === 'api' ? { status: 'succeeded' } : { status: 'not_applicable' }
		};
	}

	return {
		schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
		puzzleId: context.puzzleId,
		source: context.source,
		lifecycle: allPlaced ? 'completed' : 'active',
		mode: 'timed',
		runId,
		origin: 'resumed',
		elapsedActiveSeconds: null,
		timingQuality: 'legacy_unknown',
		timerStarted: false,
		placedPieces,
		trayOrder,
		rotationEnabled,
		pieceRotations,
		counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
		facts: { rotationUsed: hasRotation, hintUsed: false, ghostReferenceUsed: false },
		hasUserActivity,
		resultClass,
		sealedCompletion: seal,
		lastUpdated: lastUpdatedMs
	};
}

function parseLegacyLastUpdated(value: unknown): number {
	if (typeof value === 'string' && value.length > 0) {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
	return 0;
}

// --- Storage adapter ----------------------------------------------------------

export function createSessionStorageAdapter(options?: {
	storage?: Storage;
	onError?: (error: SessionPersistenceError) => void;
}): SessionStorageAdapter {
	const storage =
		options?.storage ??
		(typeof localStorage !== 'undefined' ? localStorage : undefined) ??
		noopThrowingStorage;
	const onError = options?.onError;

	function loadSession(puzzleId: string, context: SessionValidationContext): SessionLoadResult {
		let raw: string | null;
		try {
			raw = storage.getItem(progressKey(puzzleId));
		} catch (cause) {
			if (onError) onError({ kind: 'read_error', puzzleId, cause });
			return { status: 'missing' };
		}
		return loadPersistedSession(raw, context);
	}

	function saveSession(puzzleId: string, snapshot: PersistedPuzzleSessionV1): void {
		try {
			storage.setItem(progressKey(puzzleId), JSON.stringify(snapshot));
		} catch (cause) {
			if (onError) onError({ kind: 'write_error', puzzleId, cause });
		}
	}

	function clearSession(puzzleId: string): void {
		try {
			storage.removeItem(progressKey(puzzleId));
		} catch (cause) {
			if (onError) onError({ kind: 'remove_error', puzzleId, cause });
		}
	}

	return {
		loadSession,
		saveSession,
		clearSession,
		isResumable
	};
}

const noopThrowingStorage: Storage = {
	get length() {
		return 0;
	},
	key: () => null,
	getItem: () => null,
	setItem: () => {
		throw new Error('storage_unavailable');
	},
	removeItem: () => {},
	clear: () => {}
};

function cloneSeal(seal: SealedCompletion): SealedCompletion {
	return {
		runId: seal.runId,
		resultClass: seal.resultClass,
		timingQuality: seal.timingQuality,
		elapsedActiveSeconds: seal.elapsedActiveSeconds,
		completedAt: seal.completedAt,
		localStats: { ...seal.localStats },
		serverSubmission: { ...seal.serverSubmission }
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
