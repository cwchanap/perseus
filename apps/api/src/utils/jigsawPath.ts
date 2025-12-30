// Jigsaw Path Generator for Server-side Masking
// Generates SVG mask for Sharp to apply jigsaw shape to puzzle pieces

import type { EdgeConfig, EdgeType } from '../types';
import { TAB_RATIO } from '../constants/puzzle';

export { TAB_RATIO };

// Tab width as fraction of edge length (40% of edge is the tab)
const TAB_WIDTH_RATIO = 0.4;

// Pre-calculated fractions for tab positioning
const TAB_START = (1 - TAB_WIDTH_RATIO) / 2; // 0.3
const TAB_END = (1 + TAB_WIDTH_RATIO) / 2; // 0.7

// Bezier curve shape parameters for classic jigsaw tabs
// Local coordinate system: X from -0.5 to 0.5, Y from 0 to 1
const BEZIER_POINTS = {
	// Curve 1: Base to neck (left side)
	c1Start: { x: -0.5, y: 0.0 },
	c1Cp1: { x: -0.5, y: 0.15 },
	c1Cp2: { x: -0.28, y: 0.25 },
	c1End: { x: -0.21, y: 0.35 },

	// Curve 2: Neck to apex (left side with head bulge)
	c2Cp1: { x: -0.15, y: 0.5 },
	c2Cp2: { x: -0.38, y: 0.85 },
	c2End: { x: 0.0, y: 1.0 },

	// Curve 3: Apex to neck (right side, mirrored)
	c3Cp1: { x: 0.38, y: 0.85 },
	c3Cp2: { x: 0.15, y: 0.5 },
	c3End: { x: 0.21, y: 0.35 },

	// Curve 4: Neck to base (right side)
	c4Cp1: { x: 0.28, y: 0.25 },
	c4Cp2: { x: 0.5, y: 0.15 },
	c4End: { x: 0.5, y: 0.0 }
};

interface EdgeParams {
	startX: number;
	startY: number;
	endX: number;
	endY: number;
	tabStartPos: number;
	tabEndPos: number;
	tabExtend: number;
}

interface Point {
	x: number;
	y: number;
}

/**
 * Format number for SVG path (2 decimal places)
 */
function fmt(n: number): string {
	return n.toFixed(2);
}

/**
 * Transform local tab coordinates to absolute pixel coordinates
 * Local coords: X from -0.5 to 0.5 (tab width), Y from 0 to 1 (tab height)
 */
function transformPoint(
	local: Point,
	side: 'top' | 'right' | 'bottom' | 'left',
	isTab: boolean,
	params: EdgeParams
): Point {
	const { startX, startY, endX, endY, tabExtend, tabStartPos, tabEndPos } = params;
	const tabWidth = tabEndPos - tabStartPos;

	// Map localX from [-0.5, 0.5] to [tabStartPos, tabEndPos]
	const edgePos = tabStartPos + (local.x + 0.5) * tabWidth;

	// Map localY (0 to 1) to perpendicular offset
	const perpOffset = local.y * tabExtend * (isTab ? 1 : -1);

	switch (side) {
		case 'top':
			return { x: edgePos, y: startY - perpOffset };
		case 'right':
			return { x: endX + perpOffset, y: edgePos };
		case 'bottom':
			return { x: edgePos, y: endY + perpOffset };
		case 'left':
			return { x: startX - perpOffset, y: edgePos };
	}
}

/**
 * Get the corner positions for an edge based on traversal direction
 */
function getEdgeCorners(
	side: 'top' | 'right' | 'bottom' | 'left',
	params: EdgeParams
): { start: Point; tabStart: Point; tabEnd: Point; end: Point } {
	const { startX, startY, endX, endY, tabStartPos, tabEndPos } = params;

	switch (side) {
		case 'top':
			return {
				start: { x: startX, y: startY },
				tabStart: { x: tabStartPos, y: startY },
				tabEnd: { x: tabEndPos, y: startY },
				end: { x: endX, y: startY }
			};
		case 'right':
			return {
				start: { x: endX, y: startY },
				tabStart: { x: endX, y: tabStartPos },
				tabEnd: { x: endX, y: tabEndPos },
				end: { x: endX, y: endY }
			};
		case 'bottom':
			return {
				start: { x: endX, y: endY },
				tabStart: { x: tabEndPos, y: endY },
				tabEnd: { x: tabStartPos, y: endY },
				end: { x: startX, y: endY }
			};
		case 'left':
			return {
				start: { x: startX, y: endY },
				tabStart: { x: startX, y: tabEndPos },
				tabEnd: { x: startX, y: tabStartPos },
				end: { x: startX, y: startY }
			};
	}
}

/**
 * Generate SVG path commands for a single edge
 */
function generateEdgePath(
	edgeType: EdgeType,
	side: 'top' | 'right' | 'bottom' | 'left',
	params: EdgeParams
): string {
	const corners = getEdgeCorners(side, params);

	if (edgeType === 'flat') {
		return `L ${fmt(corners.end.x)} ${fmt(corners.end.y)}`;
	}

	const isTab = edgeType === 'tab';
	const pathParts: string[] = [];

	// Line from current position to tab start
	pathParts.push(`L ${fmt(corners.tabStart.x)} ${fmt(corners.tabStart.y)}`);

	// Transform all Bezier control points
	const p = BEZIER_POINTS;
	const points = [
		transformPoint(p.c1Start, side, isTab, params),
		transformPoint(p.c1Cp1, side, isTab, params),
		transformPoint(p.c1Cp2, side, isTab, params),
		transformPoint(p.c1End, side, isTab, params),
		transformPoint(p.c2Cp1, side, isTab, params),
		transformPoint(p.c2Cp2, side, isTab, params),
		transformPoint(p.c2End, side, isTab, params),
		transformPoint(p.c3Cp1, side, isTab, params),
		transformPoint(p.c3Cp2, side, isTab, params),
		transformPoint(p.c3End, side, isTab, params),
		transformPoint(p.c4Cp1, side, isTab, params),
		transformPoint(p.c4Cp2, side, isTab, params),
		transformPoint(p.c4End, side, isTab, params)
	];

	// For bottom and left edges, traverse in reverse direction
	const needsReverse = side === 'bottom' || side === 'left';

	if (needsReverse) {
		pathParts.push(
			`C ${fmt(points[11].x)} ${fmt(points[11].y)}, ${fmt(points[10].x)} ${fmt(points[10].y)}, ${fmt(points[9].x)} ${fmt(points[9].y)}`
		);
		pathParts.push(
			`C ${fmt(points[8].x)} ${fmt(points[8].y)}, ${fmt(points[7].x)} ${fmt(points[7].y)}, ${fmt(points[6].x)} ${fmt(points[6].y)}`
		);
		pathParts.push(
			`C ${fmt(points[5].x)} ${fmt(points[5].y)}, ${fmt(points[4].x)} ${fmt(points[4].y)}, ${fmt(points[3].x)} ${fmt(points[3].y)}`
		);
		pathParts.push(
			`C ${fmt(points[2].x)} ${fmt(points[2].y)}, ${fmt(points[1].x)} ${fmt(points[1].y)}, ${fmt(points[0].x)} ${fmt(points[0].y)}`
		);
	} else {
		pathParts.push(
			`C ${fmt(points[1].x)} ${fmt(points[1].y)}, ${fmt(points[2].x)} ${fmt(points[2].y)}, ${fmt(points[3].x)} ${fmt(points[3].y)}`
		);
		pathParts.push(
			`C ${fmt(points[4].x)} ${fmt(points[4].y)}, ${fmt(points[5].x)} ${fmt(points[5].y)}, ${fmt(points[6].x)} ${fmt(points[6].y)}`
		);
		pathParts.push(
			`C ${fmt(points[7].x)} ${fmt(points[7].y)}, ${fmt(points[8].x)} ${fmt(points[8].y)}, ${fmt(points[9].x)} ${fmt(points[9].y)}`
		);
		pathParts.push(
			`C ${fmt(points[10].x)} ${fmt(points[10].y)}, ${fmt(points[11].x)} ${fmt(points[11].y)}, ${fmt(points[12].x)} ${fmt(points[12].y)}`
		);
	}

	pathParts.push(`L ${fmt(corners.end.x)} ${fmt(corners.end.y)}`);

	return pathParts.join(' ');
}

/**
 * Generate SVG path for jigsaw piece with absolute pixel coordinates
 */
export function generateJigsawPath(edges: EdgeConfig, width: number, height: number): string {
	const totalScaleX = 1 + 2 * TAB_RATIO;
	const totalScaleY = 1 + 2 * TAB_RATIO;

	const baseStartX = (TAB_RATIO / totalScaleX) * width;
	const baseEndX = ((1 + TAB_RATIO) / totalScaleX) * width;
	const baseStartY = (TAB_RATIO / totalScaleY) * height;
	const baseEndY = ((1 + TAB_RATIO) / totalScaleY) * height;

	const tabExtendX = (TAB_RATIO / totalScaleX) * width;
	const tabExtendY = (TAB_RATIO / totalScaleY) * height;

	const edgeLengthX = baseEndX - baseStartX;
	const edgeLengthY = baseEndY - baseStartY;

	const topParams: EdgeParams = {
		startX: baseStartX,
		startY: baseStartY,
		endX: baseEndX,
		endY: baseStartY,
		tabStartPos: baseStartX + edgeLengthX * TAB_START,
		tabEndPos: baseStartX + edgeLengthX * TAB_END,
		tabExtend: tabExtendY
	};

	const rightParams: EdgeParams = {
		startX: baseEndX,
		startY: baseStartY,
		endX: baseEndX,
		endY: baseEndY,
		tabStartPos: baseStartY + edgeLengthY * TAB_START,
		tabEndPos: baseStartY + edgeLengthY * TAB_END,
		tabExtend: tabExtendX
	};

	const bottomParams: EdgeParams = {
		startX: baseStartX,
		startY: baseEndY,
		endX: baseEndX,
		endY: baseEndY,
		tabStartPos: baseStartX + edgeLengthX * TAB_START,
		tabEndPos: baseStartX + edgeLengthX * TAB_END,
		tabExtend: tabExtendY
	};

	const leftParams: EdgeParams = {
		startX: baseStartX,
		startY: baseStartY,
		endX: baseStartX,
		endY: baseEndY,
		tabStartPos: baseStartY + edgeLengthY * TAB_START,
		tabEndPos: baseStartY + edgeLengthY * TAB_END,
		tabExtend: tabExtendX
	};

	const pathParts: string[] = [];

	// Start at top-left of base area
	pathParts.push(`M ${fmt(baseStartX)} ${fmt(baseStartY)}`);

	// TOP EDGE (left to right)
	pathParts.push(generateEdgePath(edges.top, 'top', topParams));

	// RIGHT EDGE (top to bottom)
	pathParts.push(generateEdgePath(edges.right, 'right', rightParams));

	// BOTTOM EDGE (right to left)
	pathParts.push(generateEdgePath(edges.bottom, 'bottom', bottomParams));

	// LEFT EDGE (bottom to top)
	pathParts.push(generateEdgePath(edges.left, 'left', leftParams));

	pathParts.push('Z');

	return pathParts.join(' ');
}

/**
 * Generate complete SVG mask for Sharp compositing
 */
export function generateJigsawSvgMask(edges: EdgeConfig, width: number, height: number): Buffer {
	const path = generateJigsawPath(edges, width, height);

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <path d="${path}" fill="white"/>
</svg>`;

	return Buffer.from(svg);
}

/**
 * Calculate the expansion factor for piece containers
 */
export function getExpansionFactor(): number {
	return 1 + 2 * TAB_RATIO;
}
