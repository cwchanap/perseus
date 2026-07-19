// Perseus Workflows Worker
// Handles async puzzle generation via Cloudflare Workflows

import { DurableObject, WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type {
	WorkflowParams,
	PuzzleMetadata,
	PuzzlePiece,
	EdgeConfig,
	ReadyPuzzle,
	FailedPuzzle
} from './types';
import {
	TAB_RATIO,
	THUMBNAIL_SIZE,
	MAX_IMAGE_DIMENSION,
	validateWorkflowParams,
	createPuzzleProgress
} from './types';
import {
	generateJigsawSvgMask,
	getGridDimensions,
	getGridDimensionsForAspectRatio,
	getTopEdge,
	getRightEdge,
	getBottomEdge,
	getLeftEdge
} from '@perseus/types';
import { createD1Db } from '@perseus/shared/d1';
import { setPuzzleStatus } from '@perseus/shared';
import type { AppDb } from '@perseus/shared';
import {
	MAX_IMAGE_BYTES,
	getMetadata,
	updateMetadata,
	padPixelsToTarget,
	applyMaskAlpha
} from './helpers';

// Cache the drizzle instance per-env, mirroring apps/api/src/db.worker.ts.
// createD1Db only captures the env.DB binding reference, which is stable for
// the lifetime of the worker isolate, so reusing one instance avoids
// per-step allocation overhead across the workflow's multiple step.do calls.
const dbCache = new WeakMap<Env, AppDb>();

function getDb(env: Env): AppDb {
	let db = dbCache.get(env);
	if (!db) {
		db = createD1Db(env);
		dbCache.set(env, db);
	}
	return db;
}

export interface Env {
	PUZZLES_BUCKET: R2Bucket;
	PUZZLE_METADATA: KVNamespace;
	PUZZLE_METADATA_DO: DurableObjectNamespace;
	PUZZLE_WORKFLOW: Workflow;
	DB: D1Database;
}

/** Max age for a pending idempotency reservation before a later /reserve may reclaim it. */
export const RESERVATION_PENDING_TTL_MS = 5 * 60 * 1000;

type ReservationRecord = {
	puzzleId: string;
	status: 'pending' | 'committed' | 'failed';
	/** Epoch ms when the pending claim was created. Absent on legacy records. */
	reservedAt?: number;
};

function isStalePending(reservation: ReservationRecord, now = Date.now()): boolean {
	if (reservation.status !== 'pending') return false;
	// Missing reservedAt is treated as epoch 0 so pre-TTL stuck pendings can be reclaimed.
	const reservedAt = reservation.reservedAt ?? 0;
	return now - reservedAt >= RESERVATION_PENDING_TTL_MS;
}

export class PuzzleMetadataDO extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== 'POST') {
			return new Response('Method not allowed', { status: 405 });
		}

		if (url.pathname === '/reserve') {
			return this.handleReserve(request);
		}
		if (url.pathname === '/commit') {
			return this.handleReservationTransition(request, 'committed');
		}
		if (url.pathname === '/fail') {
			return this.handleReservationTransition(request, 'failed');
		}
		if (url.pathname === '/release') {
			return this.handleReservationTransition(request, 'released');
		}

		if (url.pathname !== '/update') {
			return new Response('Not found', { status: 404 });
		}

		const body = (await request.json().catch(() => null)) as {
			puzzleId?: string;
			updates?: Partial<PuzzleMetadata>;
		} | null;
		if (
			!body ||
			typeof body.puzzleId !== 'string' ||
			typeof body.updates !== 'object' ||
			body.updates === null ||
			Array.isArray(body.updates)
		) {
			return Response.json({ message: 'Invalid update payload' }, { status: 400 });
		}

		const { puzzleId, updates } = body;

		// Get or initialize this DO's puzzleId from storage
		let doPuzzleId = await this.ctx.storage.get<string>('puzzleId');
		if (!doPuzzleId) {
			// First call: store the puzzleId for future validation
			doPuzzleId = puzzleId;
			await this.ctx.storage.put('puzzleId', doPuzzleId);
		} else if (doPuzzleId !== puzzleId) {
			// Reject requests where puzzleId doesn't match this DO's identity
			return Response.json(
				{ message: 'Puzzle ID mismatch: request puzzleId does not match DO identity' },
				{ status: 403 }
			);
		}

		const stored = await this.ctx.storage.get<PuzzleMetadata>('metadata');
		const existing = stored ?? (await getMetadata(this.env.PUZZLE_METADATA, puzzleId));
		if (!existing) {
			return Response.json(
				{ message: `Puzzle ${puzzleId} not found in PUZZLE_METADATA` },
				{ status: 404 }
			);
		}

		// A 'ready' puzzle is terminal-good: all pieces are generated and in
		// R2, so no remaining processing can legitimately fail. Refusing
		// ready → failed prevents the workflow's mark-failed step from
		// clobbering a good 'ready' state when its updateMetadata call races
		// with a successful finalize — e.g. finalize committed the DO write
		// but the step's retry budget then exhausted, dropping control into
		// the catch block. The only writer of 'failed' here is mark-failed;
		// no admin path ever transitions ready → failed (verified across
		// admin.worker.ts). Idempotent re-writes of the same status (ready →
		// ready, failed → failed) and the forward transition processing →
		// failed remain allowed.
		if (updates.status === 'failed' && existing.status === 'ready') {
			return Response.json(
				{ message: `Puzzle ${puzzleId} is already ready; refusing transition to failed` },
				{ status: 409 }
			);
		}

		const currentVersion = existing.version ?? 0;

		// Merge pieces arrays to avoid overwriting with stale data
		// This handles the case where workflow sends only new row pieces
		let mergedPieces = existing.pieces || [];
		if (updates.pieces && Array.isArray(updates.pieces) && updates.pieces.length > 0) {
			const existingIds = new Set(mergedPieces.map((p: PuzzlePiece) => p.id));
			const newPieces = updates.pieces.filter((p: PuzzlePiece) => !existingIds.has(p.id));
			if (newPieces.length > 0) {
				mergedPieces = [...mergedPieces, ...newPieces];
			}
		}

		// Apply updates while maintaining discriminated union invariants
		let updated: PuzzleMetadata;
		if (updates.status === 'ready') {
			// ReadyPuzzle has progress?: never, error?: never
			updated = {
				...existing,
				...updates,
				id: existing.id,
				status: 'ready',
				version: currentVersion + 1,
				pieces: mergedPieces,
				progress: undefined,
				error: undefined
			} as ReadyPuzzle;
		} else if (updates.status === 'failed') {
			// FailedPuzzle has progress?: never
			updated = {
				...existing,
				...updates,
				id: existing.id,
				status: 'failed',
				version: currentVersion + 1,
				pieces: mergedPieces,
				progress: undefined
			} as FailedPuzzle;
		} else {
			// ProcessingPuzzle or no status change - merge pieces
			updated = {
				...existing,
				...updates,
				id: existing.id,
				version: currentVersion + 1,
				pieces: mergedPieces
			} as PuzzleMetadata;
		}

		// DO is the source of truth — its failure is fatal
		try {
			await this.ctx.storage.transaction(async () => {
				await this.ctx.storage.put('metadata', updated);
			});
		} catch (error) {
			console.error(`Failed to persist metadata in DO for puzzle ${puzzleId}:`, error);
			return Response.json(
				{ message: 'Failed to persist puzzle metadata', error: String(error) },
				{ status: 500 }
			);
		}

		// KV is eventually consistent — retry with backoff, but don't fail the request
		const kvMaxRetries = 3;
		for (let attempt = 0; attempt < kvMaxRetries; attempt++) {
			try {
				await this.env.PUZZLE_METADATA.put(`puzzle:${puzzleId}`, JSON.stringify(updated));
				break; // Success
			} catch (kvError) {
				if (attempt < kvMaxRetries - 1) {
					const delay = 100 * Math.pow(2, attempt);
					await new Promise((resolve) => setTimeout(resolve, delay));
				} else {
					console.error(
						`KV write failed for puzzle ${puzzleId} after ${kvMaxRetries} attempts, DO is authoritative:`,
						kvError
					);
				}
			}
		}

		// Invalidate gallery index cache when visibility-affecting mutations occur
		// (status transitions to ready/failed) so the gallery reflects changes
		// immediately instead of waiting for TTL expiry.
		if (updates.status === 'ready' || updates.status === 'failed') {
			try {
				await this.env.PUZZLE_METADATA.delete('gallery:sorted-index');
			} catch (cacheError) {
				console.error('Failed to invalidate gallery index cache:', cacheError);
			}
		}

		return Response.json({ success: true, version: updated.version });
	}

	/**
	 * Reserve an idempotency key → puzzleId mapping with recoverable lifecycle.
	 * This DO instance is keyed by idFromName(idempotencyKey), so each key gets
	 * its own strongly-consistent DO instance.
	 *
	 * State machine:
	 *   (none|failed|stale-pending) --reserve--> pending --commit--> committed
	 *                                    \--fail--> failed
	 *                                    \--release--> (none)
	 *   committed --fail--> failed      (reclaim after workflow marked puzzle failed)
	 *   committed --release--> (none)   (cleanup after puzzle deletion)
	 *
	 * Owner-checked transitions prevent a concurrent loser from releasing or
	 * committing a winner's reservation. A failed reservation may be reclaimed
	 * by a later reserve so retries after create failure can proceed. Pending
	 * reservations older than RESERVATION_PENDING_TTL_MS are also reclaimable
	 * so a crashed isolate between reserve and commit cannot brick the key.
	 * A committed reservation may be demoted to failed (so a retry can reclaim
	 * the key after the workflow marked the puzzle failed) or released (so the
	 * key is freed after an admin deletes the puzzle). Both are owner-checked.
	 *
	 * This instance is separate from the metadata DO instance (keyed by
	 * idFromName(puzzleId)) — they never share storage.
	 */
	async handleReserve(request: Request): Promise<Response> {
		const body = (await request.json().catch(() => null)) as {
			idempotencyKey?: string;
			puzzleId?: string;
		} | null;
		if (
			!body ||
			typeof body.idempotencyKey !== 'string' ||
			typeof body.puzzleId !== 'string' ||
			!body.idempotencyKey.trim() ||
			!body.puzzleId.trim()
		) {
			return Response.json({ message: 'Invalid reserve payload' }, { status: 400 });
		}

		const { puzzleId } = body;
		// idempotencyKey is not used directly — this DO instance is already
		// keyed by it via idFromName(idempotencyKey) in the caller.
		//
		// Atomically read-and-claim the reservation inside a storage transaction
		// so concurrent /reserve calls for the same key serialize: the
		// transaction provides snapshot isolation + atomic commit, guaranteeing
		// exactly one caller wins the claim. Consistent with handleUpdate,
		// which also persists via storage.transaction. On a real Durable Object
		// the input gate already serializes input delivery, but the transaction
		// is the documented atomicity primitive and removes any ordering doubt.
		// Stale-pending reclaim guard: if the prior create wrote metadata but
		// failed to commit, the reservation sits pending until TTL. Blindly
		// reclaiming would mint a second live puzzle. Promote to committed
		// when the reserved puzzle still exists and is not failed. KV read
		// is outside the storage transaction (external I/O is not allowed
		// inside DO storage transactions).
		const preReserve = await this.readReservation();
		if (preReserve && isStalePending(preReserve)) {
			// KV errors and corrupt metadata must NOT be collapsed to null —
			// that would fall through to the reclaim path and mint a duplicate
			// of a live puzzle whose metadata was momentarily unreadable. Let
			// getMetadata throw (it returns null only for truly missing keys)
			// and fail closed with 409 so the client retries. This covers both
			// transient KV failures and validatePuzzleMetadata rejections (the
			// helper throws on corrupt data); for corrupt data the 409 persists
			// until an operator force-deletes the puzzle, which is safer than
			// silently minting a replacement.
			let live: Awaited<ReturnType<typeof getMetadata>>;
			try {
				live = await getMetadata(this.env.PUZZLE_METADATA, preReserve.puzzleId);
			} catch (err) {
				console.error(
					`Stale-pending metadata lookup failed for puzzle ${preReserve.puzzleId}:`,
					err
				);
				return Response.json(
					{ message: 'Idempotency reservation lookup failed; retry' },
					{ status: 409 }
				);
			}
			if (live && live.status !== 'failed') {
				// Verify the workflow is actually live before promoting. Metadata
				// can exist (status=processing) without a running workflow if the
				// original create died between createPuzzleMetadata and
				// PUZZLE_WORKFLOW.create — promoting would return the stuck
				// processing puzzle as 200 on every retry without ever resuming
				// work. Per the fail-the-reservation policy, mark the reservation
				// failed so a retry reclaims the key and creates a fresh puzzle;
				// the stuck puzzle's metadata and image remain for operator
				// cleanup via force-delete. Statuses that mean "not going to
				// process": errored, terminated, unknown (incl. never created).
				//
				// DESIGN NOTE: This liveness check is intentionally OUTSIDE the
				// promotion transaction below. DO storage.transactions must stay
				// fast and local (SQLite-only) — an external `await` on
				// PUZZLE_WORKFLOW.get().status() inside the transaction would
				// hold the DO's storage lock for the duration of a network call,
				// blocking all other input to this DO (including concurrent
				// reserve/commit/fail/release) and risking indefinite hangs on
				// transient Workflow API failures. Instead, we check liveness
				// first, then re-validate the reservation state INSIDE both the
				// fail-transaction (line 365: re-check puzzleId + staleness) and
				// the promote-transaction (line 402: re-check puzzleId +
				// staleness). If the reservation changed between the liveness
				// check and the transaction (e.g. another caller committed or
				// reclaimed), the inner re-check sees the new state and the
				// transaction is a no-op. The only residual race — workflow
				// alive at check time, dies immediately after promotion — is
				// acceptable: the puzzle metadata exists, a future retry finds
				// the committed reservation and returns 200, and if the workflow
				// truly died without completing, the puzzle stays in
				// "processing" for operator force-delete cleanup.
				let workflowStatus: InstanceStatus['status'];
				try {
					const instance = await this.env.PUZZLE_WORKFLOW.get(preReserve.puzzleId);
					workflowStatus = (await instance.status()).status;
				} catch (wfErr) {
					console.error(`Workflow liveness check failed for puzzle ${preReserve.puzzleId}:`, wfErr);
					return Response.json(
						{ message: 'Workflow liveness check failed; retry' },
						{ status: 409 }
					);
				}
				if (
					workflowStatus === 'errored' ||
					workflowStatus === 'terminated' ||
					workflowStatus === 'unknown'
				) {
					try {
						await this.ctx.storage.transaction(async () => {
							const reservation = await this.readReservation();
							if (
								!reservation ||
								reservation.puzzleId !== preReserve.puzzleId ||
								!isStalePending(reservation)
							) {
								return;
							}
							const next: ReservationRecord = {
								puzzleId: reservation.puzzleId,
								status: 'failed'
							};
							await this.ctx.storage.put('reservation', next);
							await this.ctx.storage.put('reservedPuzzleId', reservation.puzzleId);
						});
					} catch (failErr) {
						console.error(
							`Failed to mark stale-pending reservation failed for puzzle ${preReserve.puzzleId}:`,
							failErr
						);
						return Response.json(
							{ message: 'Failed to reconcile stale reservation; retry' },
							{ status: 500 }
						);
					}
					return Response.json(
						{
							message:
								'Stale-pending reservation had no running workflow; marked failed, retry to reclaim'
						},
						{ status: 409 }
					);
				}
				const promoted = await this.ctx.storage.transaction(async () => {
					const reservation = await this.readReservation();
					// Re-check under the transaction — another caller may have
					// already promoted or reclaimed.
					if (
						!reservation ||
						reservation.puzzleId !== preReserve.puzzleId ||
						!isStalePending(reservation)
					) {
						return reservation && reservation.status !== 'failed'
							? {
									existing: true as const,
									puzzleId: reservation.puzzleId,
									status: reservation.status
								}
							: null;
					}
					const next: ReservationRecord = {
						puzzleId: reservation.puzzleId,
						status: 'committed',
						...(reservation.reservedAt !== undefined ? { reservedAt: reservation.reservedAt } : {})
					};
					await this.ctx.storage.put('reservation', next);
					await this.ctx.storage.put('reservedPuzzleId', reservation.puzzleId);
					return {
						existing: true as const,
						puzzleId: reservation.puzzleId,
						status: 'committed' as const
					};
				});
				if (promoted) {
					return Response.json(promoted);
				}
			}
		}

		const result = await this.ctx.storage.transaction(async () => {
			const reservation = await this.readReservation();
			if (reservation && reservation.status !== 'failed' && !isStalePending(reservation)) {
				return {
					existing: true as const,
					puzzleId: reservation.puzzleId,
					status: reservation.status
				};
			}
			const next: ReservationRecord = {
				puzzleId,
				status: 'pending',
				reservedAt: Date.now()
			};
			await this.ctx.storage.put('reservation', next);
			// LEGACY: keep reservedPuzzleId (plain string) in sync for older
			// readers during rollout. TODO(legacy-cleanup): once all DO
			// instances have been restarted on code that reads the
			// 'reservation' object (readReservation at bottom of this file
			// falls back to reservedPuzzleId only when 'reservation' is
			// absent), remove every reservedPuzzleId put/delete below and
			// delete the legacy read fallback in readReservation. The
			// 'reservation' object is the source of truth; the plain-string
			// key exists solely so a DO instance running old code can still
			// resolve a reservation written by new code. Safe to drop after
			// one full DO restart cycle with no rollbacks to pre-reservation
			// code.
			await this.ctx.storage.put('reservedPuzzleId', puzzleId);
			return { existing: false as const, puzzleId, status: 'pending' as const };
		});
		return Response.json(result);
	}

	/**
	 * Owner-checked reservation transition. commit/fail/release only succeed
	 * when the stored puzzleId matches the caller and status is pending.
	 *
	 * The read-decide-write runs inside storage.transaction, mirroring
	 * handleReserve. The DO input gate already serializes input delivery, so
	 * this is safe today even without the transaction — but wrapping it
	 * removes any ordering doubt and protects against a future edit that
	 * inserts an `await` on an external call (which would release the input
	 * gate) between the read and the write. Symmetric with handleReserve,
	 * which is the documented atomicity primitive here.
	 */
	async handleReservationTransition(
		request: Request,
		action: 'committed' | 'failed' | 'released'
	): Promise<Response> {
		const body = (await request.json().catch(() => null)) as {
			puzzleId?: string;
		} | null;
		if (!body || typeof body.puzzleId !== 'string' || !body.puzzleId.trim()) {
			return Response.json({ message: 'Invalid reservation transition payload' }, { status: 400 });
		}

		const { puzzleId } = body;
		const result = await this.ctx.storage.transaction(async () => {
			const reservation = await this.readReservation();
			if (!reservation) {
				return { ok: false as const, status: 404, message: 'No reservation found' };
			}
			if (reservation.puzzleId !== puzzleId) {
				return { ok: false as const, status: 409, message: 'Reservation owned by another puzzle' };
			}
			// Allowed transitions:
			//   pending → {committed, failed, released}  — normal lifecycle
			//   committed → failed                       — reclaim after workflow failure
			//   committed → released                     — cleanup after puzzle deletion
			//   X → X (idempotent re-transition)         — retry safety
			const transitionAllowed =
				reservation.status === 'pending' ||
				reservation.status === action ||
				(reservation.status === 'committed' && (action === 'failed' || action === 'released'));
			if (!transitionAllowed) {
				return {
					ok: false as const,
					status: 409,
					message: `Cannot ${action} reservation in status ${reservation.status}`
				};
			}

			if (action === 'released') {
				await this.ctx.storage.delete('reservation');
				await this.ctx.storage.delete('reservedPuzzleId');
				return { ok: true as const, status: 'released' as const };
			}

			// Idempotent commit/fail when already in the target status.
			if (reservation.status === action) {
				return { ok: true as const, status: action };
			}

			const next: ReservationRecord = { puzzleId, status: action };
			await this.ctx.storage.put('reservation', next);
			await this.ctx.storage.put('reservedPuzzleId', puzzleId);
			return { ok: true as const, status: action };
		});

		if (!result.ok) {
			return Response.json({ message: result.message }, { status: result.status });
		}
		return Response.json({ success: true, status: result.status });
	}

	private async readReservation(): Promise<ReservationRecord | null> {
		const stored = await this.ctx.storage.get<{
			puzzleId?: string;
			status?: string;
			reservedAt?: number;
		}>('reservation');
		if (
			stored &&
			typeof stored.puzzleId === 'string' &&
			(stored.status === 'pending' || stored.status === 'committed' || stored.status === 'failed')
		) {
			return {
				puzzleId: stored.puzzleId,
				status: stored.status,
				...(typeof stored.reservedAt === 'number' ? { reservedAt: stored.reservedAt } : {})
			};
		}

		// LEGACY fallback: plain puzzleId string from the previous reserve
		// implementation. TODO(legacy-cleanup): remove this fallback (and
		// all reservedPuzzleId writes above) once no DO instance can be
		// running pre-reservation code — see the TODO at the first
		// reservedPuzzleId put above for the full removal plan.
		const legacy = await this.ctx.storage.get<string>('reservedPuzzleId');
		if (typeof legacy === 'string' && legacy.trim()) {
			return { puzzleId: legacy, status: 'committed' };
		}
		return null;
	}
}

async function loadOriginalImageBytes(env: Env, puzzleId: string): Promise<Uint8Array> {
	const imageObj = await env.PUZZLES_BUCKET.get(`puzzles/${puzzleId}/original`);
	if (!imageObj) {
		throw new Error(`Original image not found for puzzle ${puzzleId}`);
	}

	const bytes = await imageObj.arrayBuffer();
	if (bytes.byteLength > MAX_IMAGE_BYTES) {
		throw new Error(
			`Image size ${bytes.byteLength} bytes exceeds maximum ${MAX_IMAGE_BYTES} bytes. Please use a smaller image.`
		);
	}

	return new Uint8Array(bytes);
}

export class PerseusWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	// Test seam: allows tests to set environment without accessing private fields
	protected setEnvOnWorkflow(env: Env): void {
		this.env = env;
	}

	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<void> {
		// Validate workflow parameters
		if (!validateWorkflowParams(event.payload)) {
			throw new Error('Invalid workflow parameters: puzzleId must be a valid UUID');
		}

		const { puzzleId } = event.payload;

		try {
			// Step 1: Load metadata and original image
			const metadata = await step.do('load-image', async () => {
				const meta = await getMetadata(this.env.PUZZLE_METADATA, puzzleId);
				if (!meta) {
					throw new Error(`Puzzle ${puzzleId} not found`);
				}

				return meta;
			});

			// Step 2: Decode image and validate dimensions using Photon
			const { width, height } = await step.do('decode-validate', async () => {
				const { PhotonImage } = await import('@cf-wasm/photon');
				const bytes = await loadOriginalImageBytes(this.env, puzzleId);
				const image = PhotonImage.new_from_byteslice(bytes);

				const w = image.get_width();
				const h = image.get_height();
				image.free();

				if (w > MAX_IMAGE_DIMENSION || h > MAX_IMAGE_DIMENSION) {
					throw new Error(`Image dimensions ${w}x${h} exceed maximum ${MAX_IMAGE_DIMENSION}px`);
				}

				return { width: w, height: h };
			});

			// Update metadata with image dimensions
			await step.do('update-dimensions', async () => {
				await updateMetadata(this.env.PUZZLE_METADATA_DO, puzzleId, {
					imageWidth: width,
					imageHeight: height
				});
			});

			// Step 3: Generate thumbnail
			await step.do('generate-thumbnail', async () => {
				const { PhotonImage, resize, crop, SamplingFilter } = await import('@cf-wasm/photon');
				const bytes = await loadOriginalImageBytes(this.env, puzzleId);
				const image = PhotonImage.new_from_byteslice(bytes);

				let resized = null;
				try {
					// Calculate thumbnail dimensions (cover fit)
					const srcW = image.get_width();
					const srcH = image.get_height();
					const scale = Math.max(THUMBNAIL_SIZE / srcW, THUMBNAIL_SIZE / srcH);
					const newW = Math.round(srcW * scale);
					const newH = Math.round(srcH * scale);

					// Resize
					resized = resize(image, newW, newH, SamplingFilter.Lanczos3);

					try {
						// Center crop to exact thumbnail size
						const cropX = Math.floor((newW - THUMBNAIL_SIZE) / 2);
						const cropY = Math.floor((newH - THUMBNAIL_SIZE) / 2);
						const cropped = crop(
							resized,
							cropX,
							cropY,
							cropX + THUMBNAIL_SIZE,
							cropY + THUMBNAIL_SIZE
						);

						try {
							// Encode as JPEG
							const jpegBytes = cropped.get_bytes_jpeg(80);

							// Upload to R2
							await this.env.PUZZLES_BUCKET.put(`puzzles/${puzzleId}/thumbnail.jpg`, jpegBytes, {
								httpMetadata: { contentType: 'image/jpeg' }
							});
						} finally {
							if (cropped) cropped.free();
						}
					} finally {
						if (resized) resized.free();
					}
				} finally {
					// Always free the original image, even if resize() throws
					image.free();
				}
			});

			// Step 4: Generate pieces
			const { rows, cols } = metadata.aspectRatio
				? getGridDimensionsForAspectRatio(metadata.pieceCount, metadata.aspectRatio)
				: getGridDimensions(metadata.pieceCount);
			if (rows <= 0 || cols <= 0 || rows * cols !== metadata.pieceCount) {
				throw new Error(
					`Invalid grid dimensions for puzzle ${puzzleId}: pieceCount=${metadata.pieceCount}, aspectRatio=${metadata.aspectRatio ?? 'default'}, rows=${rows}, cols=${cols}`
				);
			}
			const totalPieces = metadata.pieceCount;

			// Process pieces in batches (rows) to checkpoint progress
			for (let row = 0; row < rows; row++) {
				await step.do(`generate-row-${row}`, async () => {
					const { PhotonImage, crop } = await import('@cf-wasm/photon');
					const { Resvg } = await import('@cf-wasm/resvg');
					const bytes = await loadOriginalImageBytes(this.env, puzzleId);
					const srcImage = PhotonImage.new_from_byteslice(bytes);

					const pieces: PuzzlePiece[] = [];

					try {
						const srcW = srcImage.get_width();
						const srcH = srcImage.get_height();

						const basePieceWidth = Math.floor(srcW / cols);
						const extraWidth = srcW % cols;
						const basePieceHeight = Math.floor(srcH / rows);
						const extraHeight = srcH % rows;

						for (let col = 0; col < cols; col++) {
							const pieceId = row * cols + col;
							if (pieceId >= totalPieces) {
								break;
							}

							// Calculate base piece dimensions
							const baseWidth = basePieceWidth + (col === cols - 1 ? extraWidth : 0);
							const baseHeight = basePieceHeight + (row === rows - 1 ? extraHeight : 0);

							// Calculate overlap for jigsaw tabs
							const overlapX = Math.floor(baseWidth * TAB_RATIO);
							const overlapY = Math.floor(baseHeight * TAB_RATIO);

							// Target size: base piece + overlap on all sides (140% of base)
							const targetWidth = baseWidth + 2 * overlapX;
							const targetHeight = baseHeight + 2 * overlapY;

							// Calculate extraction bounds
							const baseLeft = col * basePieceWidth;
							const baseTop = row * basePieceHeight;
							const idealLeft = baseLeft - overlapX;
							const idealTop = baseTop - overlapY;

							// Clamp extraction to image boundaries
							const extractLeft = Math.max(0, idealLeft);
							const extractTop = Math.max(0, idealTop);
							const extractRight = Math.min(srcW, idealLeft + targetWidth);
							const extractBottom = Math.min(srcH, idealTop + targetHeight);

							const extractWidth = extractRight - extractLeft;
							const extractHeight = extractBottom - extractTop;
							const offsetX = extractLeft - idealLeft;
							const offsetY = extractTop - idealTop;

							// Determine edge types using deterministic calculation
							// This ensures edges are consistent across workflow steps
							const edges: EdgeConfig = {
								top: getTopEdge(row, col, rows),
								right: getRightEdge(row, col, cols),
								bottom: getBottomEdge(row, col, rows),
								left: getLeftEdge(row, col, cols)
							};

							// Extract piece region from source image using crop function
							let pieceImage = null;
							let maskImage = null;
							let maskedPiece = null;

							try {
								pieceImage = crop(
									srcImage,
									extractLeft,
									extractTop,
									extractLeft + extractWidth,
									extractTop + extractHeight
								);

								// Generate jigsaw mask SVG using target dimensions
								const maskSvg = generateJigsawSvgMask(edges, targetWidth, targetHeight);

								// Render SVG mask to PNG using Resvg
								const resvg = new Resvg(maskSvg, {
									fitTo: { mode: 'width', value: targetWidth }
								});
								const maskPng = resvg.render().asPng();

								// Load mask as PhotonImage
								maskImage = PhotonImage.new_from_byteslice(maskPng);

								// Get raw RGBA pixel data for both images
								const maskPixels = maskImage.get_raw_pixels();
								const piecePixels = pieceImage.get_raw_pixels();
								const paddedPiecePixels = padPixelsToTarget(
									piecePixels,
									extractWidth,
									extractHeight,
									targetWidth,
									targetHeight,
									offsetX,
									offsetY
								);

								// Validate sizes match before copying alpha channel
								if (maskPixels.length !== paddedPiecePixels.length) {
									throw new Error(
										`Mask and piece image pixel count mismatch for piece ${pieceId}: ` +
											`mask=${maskPixels.length} pixels, piece=${paddedPiecePixels.length} pixels`
									);
								}

								// Copy alpha channel from mask to piece (4th byte in each RGBA pixel)
								applyMaskAlpha(paddedPiecePixels, maskPixels);

								// Create new PhotonImage from modified raw RGBA bytes
								maskedPiece = new PhotonImage(paddedPiecePixels, targetWidth, targetHeight);

								// Encode masked piece as PNG
								const pngBytes = maskedPiece.get_bytes();

								// Upload piece to R2
								await this.env.PUZZLES_BUCKET.put(
									`puzzles/${puzzleId}/pieces/${pieceId}.png`,
									pngBytes,
									{ httpMetadata: { contentType: 'image/png' } }
								);
							} finally {
								if (maskedPiece) maskedPiece.free();
								if (maskImage) maskImage.free();
								if (pieceImage) pieceImage.free();
							}

							pieces.push({
								id: pieceId,
								puzzleId,
								correctX: col,
								correctY: row,
								edges,
								imagePath: `pieces/${pieceId}.png`
							});
						}
					} finally {
						srcImage.free();
					}

					// Update progress in metadata
					const generatedPieces = Math.min((row + 1) * cols, totalPieces);
					const progress = createPuzzleProgress(totalPieces, generatedPieces);

					// Send new pieces to DO - DO merges with stored state to avoid stale KV issues
					await updateMetadata(this.env.PUZZLE_METADATA_DO, puzzleId, {
						progress,
						pieces
					});
				});
			}

			// Step 5: Mark puzzle as ready in the authoritative DO store. Only the
			// DO write lives in this step so a failure here (genuine processing
			// failure) correctly triggers mark-failed below. The D1 mirror is a
			// separate best-effort step after the try/catch — a D1 outage must not
			// overwrite a successful 'ready' DO write with 'failed'.
			await step.do('finalize', async () => {
				await updateMetadata(this.env.PUZZLE_METADATA_DO, puzzleId, {
					status: 'ready'
				});
			});
		} catch (error) {
			// Mark puzzle as failed with retry logic
			const originalError = error;
			await step.do('mark-failed', async () => {
				const maxRetries = 3;
				let lastError: unknown;
				let doSucceeded = false;
				// Set when the DO refuses ready → failed (see PuzzleMetadataDO
				// /update): finalize already committed 'ready', so the puzzle is
				// in the desired terminal state and must NOT be overwritten with
				// 'failed'. We reconcile D1 to 'ready' and skip the CRITICAL log.
				let alreadyReady = false;

				for (let attempt = 0; attempt < maxRetries; attempt++) {
					try {
						const message =
							originalError instanceof Error ? originalError.message : 'Unknown error';
						await updateMetadata(this.env.PUZZLE_METADATA_DO, puzzleId, {
							status: 'failed',
							error: { message }
						});
						doSucceeded = true;
						break;
					} catch (markErr) {
						// A 409 from the metadata DO with an "already ready"
						// message means finalize committed before this catch
						// ran (e.g. its step retry budget exhausted after a
						// successful DO write). That is the desired terminal
						// state; do not retry, do not log CRITICAL, and do not
						// mirror 'failed' to D1. Reconcile D1 to 'ready' so the
						// owner's list doesn't stay stuck at 'processing'.
						// Match on the message (not status alone) so a future
						// unrelated 409 cannot be misread as already-ready.
						const markStatus = (markErr as { status?: number })?.status;
						const markMessage = markErr instanceof Error ? markErr.message : String(markErr ?? '');
						if (markStatus === 409 && /already ready/i.test(markMessage)) {
							console.warn(
								`Puzzle ${puzzleId} is already ready; skipping mark-failed ` +
									'(finalize committed before the error path).'
							);
							alreadyReady = true;
							break;
						}
						lastError = markErr;
						console.error(
							`Failed to mark puzzle ${puzzleId} as failed (attempt ${attempt + 1}/${maxRetries}):`,
							markErr
						);

						if (attempt < maxRetries - 1) {
							// Exponential backoff
							const delay = 100 * Math.pow(2, attempt);
							await new Promise((resolve) => setTimeout(resolve, delay));
						}
					}
				}

				if (alreadyReady) {
					// Best-effort D1 reconciliation to 'ready' (matches the
					// success-path mirror-ready-status-to-d1 step, which won't
					// run because the catch block re-throws originalError).
					try {
						await setPuzzleStatus(getDb(this.env), puzzleId, 'ready');
					} catch (d1Error) {
						console.error('Failed to reconcile already-ready status in D1:', d1Error);
					}
					return;
				}

				if (doSucceeded) {
					// Mirror the finalize step: keep D1 in sync with the public
					// status so the puzzle doesn't stay stuck at 'processing' in
					// the ownership/stats store. Best-effort and independent of the
					// DO retry loop — a D1/DB failure must not re-run the DO update.
					try {
						await setPuzzleStatus(getDb(this.env), puzzleId, 'failed');
					} catch (d1Error) {
						console.error('Failed to update puzzle status in D1:', d1Error);
					}
					return;
				}

				// All retries failed - log extensively
				console.error(
					`CRITICAL: Failed to mark puzzle ${puzzleId} as failed after ${maxRetries} retries`
				);
				console.error('Last error:', lastError);
				console.error('Original workflow error:', originalError);
				// Note: Puzzle will remain in 'processing' state - manual cleanup required
			});
			throw originalError;
		}

		// Best-effort D1 mirror of the ready status. Placed after the try/catch
		// so a D1 failure can never trigger mark-failed (the DO already says
		// 'ready'). The D1 mirror is idempotent; on failure we log and move on —
		// the gallery reads from KV/DO, and a later successful mirror or direct
		// D1 read will reconcile. This only runs on the success path because the
		// catch block re-throws on failure.
		await step.do('mirror-ready-status-to-d1', async () => {
			try {
				await setPuzzleStatus(getDb(this.env), puzzleId, 'ready');
			} catch (d1Error) {
				console.error('Failed to mirror ready status to D1:', d1Error);
			}
		});
	}
}

// Export default for wrangler
export default {
	async fetch(_request: Request, _env: Env): Promise<Response> {
		// This worker processes puzzles via Workflow and Durable Object bindings.
		// It does not serve public HTTP endpoints.
		return new Response('Not Found', { status: 404 });
	}
};
