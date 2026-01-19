// Perseus Workflows Worker
// Handles async puzzle generation via Cloudflare Workflows

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { WorkflowParams, PuzzleMetadata, PuzzlePiece, EdgeConfig, EdgeType } from './types';
import { TAB_RATIO, THUMBNAIL_SIZE, MAX_IMAGE_DIMENSION } from './types';
import { generateJigsawSvgMask } from './utils/jigsaw-path';

export interface Env {
	PUZZLES_BUCKET: R2Bucket;
	PUZZLE_METADATA: KVNamespace;
	PUZZLE_WORKFLOW: Workflow;
}

// Helper to get/update puzzle metadata from KV
async function getMetadata(kv: KVNamespace, puzzleId: string): Promise<PuzzleMetadata | null> {
	const data = await kv.get(`puzzle:${puzzleId}`, 'json');
	return data as PuzzleMetadata | null;
}

async function updateMetadata(
	kv: KVNamespace,
	puzzleId: string,
	updates: Partial<PuzzleMetadata>
): Promise<void> {
	const maxRetries = 3;
	const baseDelay = 50; // ms

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const existing = await getMetadata(kv, puzzleId);
		if (!existing) {
			throw new Error(`Puzzle ${puzzleId} not found in PUZZLE_METADATA`);
		}

		const currentVersion = existing.version ?? 0;
		const updated: PuzzleMetadata = {
			...existing,
			...updates,
			version: currentVersion + 1
		};

		// Write updated metadata
		await kv.put(`puzzle:${puzzleId}`, JSON.stringify(updated));

		// Small delay to account for KV eventual consistency before verification
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Verify our write succeeded by reading back and checking version
		const current = await getMetadata(kv, puzzleId);
		if (current?.version === updated.version) {
			// Our write succeeded
			return;
		}

		// Version mismatch - another update occurred, retry
		if (attempt < maxRetries - 1) {
			const delay = baseDelay * Math.pow(2, attempt);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	throw new Error(
		`Failed to update puzzle ${puzzleId} in PUZZLE_METADATA after ${maxRetries} retries due to concurrent updates`
	);
}

// Grid dimension calculator
function getGridDimensions(pieceCount: number): { rows: number; cols: number } {
	// Validate input - guard against zero or negative values
	if (pieceCount <= 0) {
		return { rows: 0, cols: 0 };
	}

	const cols = Math.ceil(Math.sqrt(pieceCount));
	// cols will always be >= 1 for pieceCount >= 1
	const rows = Math.ceil(pieceCount / cols);
	return { rows, cols };
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
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<void> {
		const { puzzleId } = event.payload;

		try {
			// Step 1: Load metadata and original image
			const { metadata, imageBytes } = await step.do('load-image', async () => {
				const meta = await getMetadata(this.env.PUZZLE_METADATA, puzzleId);
				if (!meta) {
					throw new Error(`Puzzle ${puzzleId} not found`);
				}

				const imageObj = await this.env.PUZZLES_BUCKET.get(`puzzles/${puzzleId}/original`);
				if (!imageObj) {
					throw new Error(`Original image not found for puzzle ${puzzleId}`);
				}

				const bytes = await imageObj.arrayBuffer();
				return {
					metadata: meta,
					imageBytes: Array.from(new Uint8Array(bytes)),
					contentType: imageObj.httpMetadata?.contentType || 'image/jpeg'
				};
			});

			// Step 2: Decode image and validate dimensions using Photon
			const { width, height } = await step.do('decode-validate', async () => {
				const { PhotonImage } = await import('@cf-wasm/photon');
				const bytes = new Uint8Array(imageBytes);
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
				await updateMetadata(this.env.PUZZLE_METADATA, puzzleId, {
					imageWidth: width,
					imageHeight: height
				});
			});

			// Step 3: Generate thumbnail
			await step.do('generate-thumbnail', async () => {
				const { PhotonImage, resize, crop, SamplingFilter } = await import('@cf-wasm/photon');
				const bytes = new Uint8Array(imageBytes);
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

				// Center crop to exact thumbnail size
				const cropX = Math.floor((newW - THUMBNAIL_SIZE) / 2);
				const cropY = Math.floor((newH - THUMBNAIL_SIZE) / 2);
				const cropped = crop(resized, cropX, cropY, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
				resized.free();

				// Encode as JPEG
				const jpegBytes = cropped.get_bytes_jpeg(80);
				cropped.free();

				// Upload to R2
				await this.env.PUZZLES_BUCKET.put(`puzzles/${puzzleId}/thumbnail.jpg`, jpegBytes, {
					httpMetadata: { contentType: 'image/jpeg' }
				});
			});

			// Step 4: Generate pieces
			const { rows, cols } = getGridDimensions(metadata.pieceCount);
			const totalPieces = metadata.pieceCount;

			// Process pieces in batches (rows) to checkpoint progress
			for (let row = 0; row < rows; row++) {
				await step.do(`generate-row-${row}`, async () => {
					const { PhotonImage, crop } = await import('@cf-wasm/photon');
					const { Resvg } = await import('@cf-wasm/resvg');

					const bytes = new Uint8Array(imageBytes);
					const srcImage = PhotonImage.new_from_byteslice(bytes);
					const srcW = srcImage.get_width();
					const srcH = srcImage.get_height();

					const basePieceWidth = Math.floor(srcW / cols);
					const extraWidth = srcW % cols;
					const basePieceHeight = Math.floor(srcH / rows);
					const extraHeight = srcH % rows;

					const pieces: PuzzlePiece[] = [];

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

						// Determine edge types using deterministic calculation
						// This ensures edges are consistent across workflow steps
						const edges: EdgeConfig = {
							top: getTopEdge(row, col, rows),
							right: getRightEdge(row, col, cols),
							bottom: getBottomEdge(row, col, rows),
							left: getLeftEdge(row, col, cols)
						};

						// Extract piece region from source image using crop function
						const pieceImage = crop(srcImage, extractLeft, extractTop, extractWidth, extractHeight);

						// Generate jigsaw mask SVG using actual extracted dimensions
						const maskSvg = generateJigsawSvgMask(edges, extractWidth, extractHeight);

						// Render SVG mask to PNG using Resvg
						const resvg = new Resvg(maskSvg, {
							fitTo: { mode: 'width', value: extractWidth }
						});
						const maskPng = resvg.render().asPng();

						// Load mask as PhotonImage
						const maskImage = PhotonImage.new_from_byteslice(maskPng);

						// Apply mask by manipulating raw bytes
						// Get raw bytes from both images (RGBA format, 4 bytes per pixel)
						const pieceBytes = pieceImage.get_bytes();
						const maskBytes = maskImage.get_bytes();

						// Copy alpha channel from mask to piece (4th byte in each RGBA pixel)
						// The mask is grayscale where white = transparent, black = opaque
						for (let i = 0; i < pieceBytes.length; i += 4) {
							// Invert mask luminance for alpha: black (0) = opaque (255), white (255) = transparent (0)
							const luminance = maskBytes[i]; // All channels are same in grayscale
							pieceBytes[i + 3] = 255 - luminance;
						}

						// Create new PhotonImage from modified raw RGBA bytes using correct constructor
						const pieceWidth = pieceImage.get_width();
						const pieceHeight = pieceImage.get_height();
						const maskedPiece = PhotonImage.new(pieceBytes, pieceWidth, pieceHeight);

						// Free original images
						maskImage.free();
						pieceImage.free();

						// Encode masked piece as PNG
						const pngBytes = maskedPiece.get_bytes_png();
						maskedPiece.free();

						// Upload piece to R2
						await this.env.PUZZLES_BUCKET.put(
							`puzzles/${puzzleId}/pieces/${pieceId}.png`,
							pngBytes,
							{ httpMetadata: { contentType: 'image/png' } }
						);

						pieces.push({
							id: pieceId,
							puzzleId,
							correctX: col,
							correctY: row,
							edges,
							imagePath: `pieces/${pieceId}.png`
						});
					}

					srcImage.free();

					// Update progress in metadata
					const generatedPieces = Math.min((row + 1) * cols, totalPieces);

					// Retry logic for fetching metadata with exponential backoff
					const maxRetries = 3;
					let currentMeta: PuzzleMetadata | null = null;

					for (let attempt = 0; attempt < maxRetries; attempt++) {
						currentMeta = await getMetadata(this.env.PUZZLE_METADATA, puzzleId);
						if (currentMeta) break;

						if (attempt < maxRetries - 1) {
							const delay = 100 * Math.pow(2, attempt);
							await new Promise((resolve) => setTimeout(resolve, delay));
						}
					}

					if (!currentMeta) {
						throw new Error(
							`Failed to retrieve metadata for puzzle ${puzzleId} after ${maxRetries} retries. Namespace: PUZZLE_METADATA`
						);
					}

					const updatedPieces = [...(currentMeta.pieces || []), ...pieces];
					await updateMetadata(this.env.PUZZLE_METADATA, puzzleId, {
						pieces: updatedPieces,
						progress: {
							totalPieces,
							generatedPieces,
							updatedAt: Date.now()
						}
					});
				});
			}

			// Step 5: Mark puzzle as ready
			await step.do('finalize', async () => {
				await updateMetadata(this.env.PUZZLE_METADATA, puzzleId, {
					status: 'ready',
					progress: {
						totalPieces,
						generatedPieces: totalPieces,
						updatedAt: Date.now()
					}
				});
			});
		} catch (error) {
			// Mark puzzle as failed
			await step.do('mark-failed', async () => {
				const message = error instanceof Error ? error.message : 'Unknown error';
				await updateMetadata(this.env.PUZZLE_METADATA, puzzleId, {
					status: 'failed',
					error: { message }
				});
			});
			throw error;
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
