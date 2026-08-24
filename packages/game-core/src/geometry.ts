// Portable viewport geometry: the fit-zoom formula shared by web and mobile.
// Zoom/pan clamping stays app-side (web viewport.ts owns it today).

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
