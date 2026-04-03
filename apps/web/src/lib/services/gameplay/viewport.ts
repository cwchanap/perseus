// Viewport helper for zoom and pan constraints

export interface ViewportBounds {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

/**
 * Clamps zoom level to the allowed range.
 *
 * @param zoom - Desired zoom level
 * @param minZoom - Minimum allowed zoom
 * @param maxZoom - Maximum allowed zoom
 * @returns Clamped zoom level
 */
export function clampZoom(zoom: number, minZoom: number, maxZoom: number): number {
	return Math.max(minZoom, Math.min(maxZoom, zoom));
}

/**
 * Clamps pan position to viewport bounds.
 *
 * @param x - Desired x position
 * @param y - Desired y position
 * @param bounds - Viewport bounds
 * @returns Clamped position { x, y }
 */
export function clampPan(x: number, y: number, bounds: ViewportBounds): { x: number; y: number } {
	return {
		x: Math.max(bounds.minX, Math.min(bounds.maxX, x)),
		y: Math.max(bounds.minY, Math.min(bounds.maxY, y))
	};
}

/**
 * Calculates the zoom level needed to fit the puzzle in the viewport.
 *
 * @param puzzleWidth - Width of the puzzle canvas
 * @param puzzleHeight - Height of the puzzle canvas
 * @param viewportWidth - Width of the viewport
 * @param viewportHeight - Height of the viewport
 * @param paddingFactor - Factor to add padding (0.9 = 10% padding, default)
 * @returns Zoom level to fit puzzle in viewport
 */
export function calculateFitZoom(
	puzzleWidth: number,
	puzzleHeight: number,
	viewportWidth: number,
	viewportHeight: number,
	paddingFactor = 0.9
): number {
	if (puzzleWidth <= 0 || puzzleHeight <= 0) {
		return 0;
	}

	const widthRatio = viewportWidth / puzzleWidth;
	const heightRatio = viewportHeight / puzzleHeight;
	const baseZoom = Math.min(widthRatio, heightRatio);
	return baseZoom * paddingFactor;
}
