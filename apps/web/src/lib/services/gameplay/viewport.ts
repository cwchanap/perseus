// Viewport helper for zoom and pan constraints. The portable fit-zoom
// formula lives in @perseus/game-core (geometry); only app-side clamping is
// owned here.

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
