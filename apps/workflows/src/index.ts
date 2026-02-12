// Perseus Workflows Worker
// Handles async puzzle generation via Cloudflare Workflows

import { DurableObject, WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type {
	WorkflowParams,
	PuzzleMetadata,
	PuzzlePiece,
	EdgeConfig,
	EdgeType,
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
import { generateJigsawSvgMask } from './utils/jigsaw-path';
import {
	MAX_IMAGE_BYTES,
	getMetadata,
	updateMetadata,
	padPixelsToTarget,
	applyMaskAlpha
} from './helpers';

export interface Env {
	PUZZLES_BUCKET: R2Bucket;
	PUZZLE_METADATA: KVNamespace;
	PUZZLE_METADATA_DO: DurableObjectNamespace;
	PUZZLE_WORKFLOW: Workflow;
}

export class PuzzleMetadataDO extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== 'POST' || url.pathname !== '/update') {
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

		const currentVersion = existing.version ?? 0;
		const _previous = stored ?? existing; // Kept for potential future rollback needs

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
					console.warn(
						`KV write failed for puzzle ${puzzleId} after ${kvMaxRetries} attempts, DO is authoritative:`,
						kvError
					);
				}
			}
		}

		return Response.json({ success: true, version: updated.version });
	}
}

// Grid dimension calculator
// Finds the most square-like grid for the given piece count by finding the largest
// factor of pieceCount that is <= sqrt(pieceCount), making that the row count.
// This ensures rows <= cols and produces a balanced grid (e.g., 225 -> 15x15).
function getGridDimensions(pieceCount: number): { rows: number; cols: number } {
	// Validate input - guard against zero or negative values
	if (pieceCount <= 0) {
		return { rows: 0, cols: 0 };
	}

	const sqrt = Math.floor(Math.sqrt(pieceCount));
	for (let i = sqrt; i >= 1; i -= 1) {
		if (pieceCount % i === 0) {
			return { rows: i, cols: pieceCount / i };
		}
	}

	// Unreachable: the loop always returns at i===1 since pieceCount % 1 === 0
	// but TypeScript needs a return path
	return { rows: 1, cols: pieceCount };
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

// Edge type helper
function opposite(edge: EdgeType): EdgeType {
	return edge === 'tab' ? 'blank' : edge === 'blank' ? 'tab' : 'flat';
}

// Deterministic edge calculation helpers
// These compute edges based on position alone, ensuring consistency across workflow steps
function getBottomEdge(row: number, col: number, rows: number): EdgeType {
	if (row === rows - 1) return 'flat';
	return (row + col) % 2 === 0 ? 'blank' : 'tab';
}

function getRightEdge(row: number, col: number, cols: number): EdgeType {
	if (col === cols - 1) return 'flat';
	return (row + col) % 2 === 0 ? 'tab' : 'blank';
}

function getTopEdge(row: number, col: number, rows: number): EdgeType {
	if (row === 0) return 'flat';
	// Top edge is opposite of the bottom edge of the piece above (row - 1, col)
	return opposite(getBottomEdge(row - 1, col, rows));
}

function getLeftEdge(row: number, col: number, cols: number): EdgeType {
	if (col === 0) return 'flat';
	// Left edge is opposite of the right edge of the piece to the left (row, col - 1)
	return opposite(getRightEdge(row, col - 1, cols));
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

				// Calculate thumbnail dimensions (cover fit)
				const srcW = image.get_width();
				const srcH = image.get_height();
				const scale = Math.max(THUMBNAIL_SIZE / srcW, THUMBNAIL_SIZE / srcH);
				const newW = Math.round(srcW * scale);
				const newH = Math.round(srcH * scale);

				// Resize
				const resized = resize(image, newW, newH, SamplingFilter.Lanczos3);
				image.free();

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
			});

			// Step 4: Generate pieces
			const { rows, cols } = getGridDimensions(metadata.pieceCount);
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

			// Step 5: Mark puzzle as ready (progress field is removed when status changes to ready)
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

				for (let attempt = 0; attempt < maxRetries; attempt++) {
					try {
						const message =
							originalError instanceof Error ? originalError.message : 'Unknown error';
						await updateMetadata(this.env.PUZZLE_METADATA_DO, puzzleId, {
							status: 'failed',
							error: { message }
						});
						return; // Success
					} catch (markErr) {
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
	}
}

// Export default for wrangler
export default {
	async fetch(_request: Request, _env: Env): Promise<Response> {
		// This worker doesn't serve HTTP requests directly
		// It only exposes the Workflow binding
		return new Response('Perseus Workflows Worker', { status: 200 });
	}
};
