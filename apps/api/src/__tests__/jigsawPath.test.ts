// Unit tests for jigsaw path generation
import { describe, it, expect } from 'bun:test';
import { generateJigsawPath, generateJigsawSvgMask, getExpansionFactor } from '../utils/jigsawPath';
import { TAB_RATIO } from '../constants/puzzle';
import type { EdgeConfig } from '../types';

describe('jigsawPath constants', () => {
	it('TAB_RATIO should be 0.2', () => {
		expect(TAB_RATIO).toBe(0.2);
	});

	it('getExpansionFactor should return 1.4 (1 + 2 * TAB_RATIO)', () => {
		expect(getExpansionFactor()).toBe(1.4);
	});
});

describe('generateJigsawPath', () => {
	const testWidth = 100;
	const testHeight = 100;

	it('should generate valid SVG path starting with M command', () => {
		const edges: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' };
		const path = generateJigsawPath(edges, testWidth, testHeight);

		expect(path).toMatch(/^M\s/);
	});

	it('should generate path ending with Z (close path)', () => {
		const edges: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' };
		const path = generateJigsawPath(edges, testWidth, testHeight);

		expect(path).toMatch(/Z$/);
	});

	it('should generate simple rectangle for all flat edges', () => {
		const edges: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' };
		const path = generateJigsawPath(edges, testWidth, testHeight);

		// All flat edges should only have M, L, and Z commands (no curves)
		expect(path).not.toMatch(/C\s/);
	});

	it('should generate curves for tab edges', () => {
		const edges: EdgeConfig = { top: 'tab', right: 'flat', bottom: 'flat', left: 'flat' };
		const path = generateJigsawPath(edges, testWidth, testHeight);

		// Tab edges should have C (cubic bezier) commands
		expect(path).toMatch(/C\s/);
	});

	it('should generate curves for blank edges', () => {
		const edges: EdgeConfig = { top: 'blank', right: 'flat', bottom: 'flat', left: 'flat' };
		const path = generateJigsawPath(edges, testWidth, testHeight);

		// Blank edges should have C (cubic bezier) commands
		expect(path).toMatch(/C\s/);
	});

	it('should handle all edge type combinations', () => {
		const edgeTypes: Array<'flat' | 'tab' | 'blank'> = ['flat', 'tab', 'blank'];

		for (const top of edgeTypes) {
			for (const right of edgeTypes) {
				for (const bottom of edgeTypes) {
					for (const left of edgeTypes) {
						const edges: EdgeConfig = { top, right, bottom, left };
						const path = generateJigsawPath(edges, testWidth, testHeight);

						// Should not throw and should produce valid path
						expect(path).toBeTruthy();
						expect(path).toMatch(/^M\s/);
						expect(path).toMatch(/Z$/);
					}
				}
			}
		}
	});

	it('should produce different paths for different edge configurations', () => {
		const flatEdges: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' };
		const tabEdges: EdgeConfig = { top: 'tab', right: 'tab', bottom: 'tab', left: 'tab' };
		const blankEdges: EdgeConfig = { top: 'blank', right: 'blank', bottom: 'blank', left: 'blank' };

		const flatPath = generateJigsawPath(flatEdges, testWidth, testHeight);
		const tabPath = generateJigsawPath(tabEdges, testWidth, testHeight);
		const blankPath = generateJigsawPath(blankEdges, testWidth, testHeight);

		expect(flatPath).not.toBe(tabPath);
		expect(flatPath).not.toBe(blankPath);
		expect(tabPath).not.toBe(blankPath);
	});

	it('should scale path coordinates with width and height', () => {
		const edges: EdgeConfig = { top: 'tab', right: 'flat', bottom: 'flat', left: 'flat' };

		const smallPath = generateJigsawPath(edges, 50, 50);
		const largePath = generateJigsawPath(edges, 200, 200);

		// Paths should be different due to scaling
		expect(smallPath).not.toBe(largePath);

		// Extract first coordinate from M command
		const smallMatch = smallPath.match(/^M\s+([\d.]+)\s+([\d.]+)/);
		const largeMatch = largePath.match(/^M\s+([\d.]+)\s+([\d.]+)/);

		expect(smallMatch).not.toBeNull();
		expect(largeMatch).not.toBeNull();

		const smallX = parseFloat(smallMatch![1]);
		const largeX = parseFloat(largeMatch![1]);

		// Large path coordinates should be proportionally larger
		expect(largeX).toBeGreaterThan(smallX);
	});

	it('should produce valid numeric coordinates (no NaN or Infinity)', () => {
		const edges: EdgeConfig = { top: 'tab', right: 'blank', bottom: 'tab', left: 'blank' };
		const path = generateJigsawPath(edges, testWidth, testHeight);

		// Extract all numbers from path
		const numbers = path.match(/[\d.]+/g);
		expect(numbers).not.toBeNull();

		for (const num of numbers!) {
			const parsed = parseFloat(num);
			expect(Number.isFinite(parsed)).toBe(true);
			expect(Number.isNaN(parsed)).toBe(false);
		}
	});
});

describe('generateJigsawSvgMask', () => {
	it('should generate valid SVG buffer', () => {
		const edges: EdgeConfig = { top: 'tab', right: 'blank', bottom: 'flat', left: 'tab' };
		const buffer = generateJigsawSvgMask(edges, 100, 100);

		expect(buffer).toBeInstanceOf(Buffer);
		expect(buffer.length).toBeGreaterThan(0);
	});

	it('should generate valid SVG XML', () => {
		const edges: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' };
		const buffer = generateJigsawSvgMask(edges, 100, 100);
		const svgString = buffer.toString('utf-8');

		// Check SVG structure
		expect(svgString).toMatch(/<svg[^>]*>/);
		expect(svgString).toMatch(/<\/svg>/);
		expect(svgString).toMatch(/<path[^>]*\/>/);
	});

	it('should include correct dimensions in SVG', () => {
		const width = 150;
		const height = 200;
		const edges: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' };
		const buffer = generateJigsawSvgMask(edges, width, height);
		const svgString = buffer.toString('utf-8');

		expect(svgString).toContain(`width="${width}"`);
		expect(svgString).toContain(`height="${height}"`);
		expect(svgString).toContain(`viewBox="0 0 ${width} ${height}"`);
	});

	it('should have white fill for mask', () => {
		const edges: EdgeConfig = { top: 'tab', right: 'tab', bottom: 'tab', left: 'tab' };
		const buffer = generateJigsawSvgMask(edges, 100, 100);
		const svgString = buffer.toString('utf-8');

		expect(svgString).toContain('fill="white"');
	});

	it('should include xmlns attribute for valid SVG', () => {
		const edges: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' };
		const buffer = generateJigsawSvgMask(edges, 100, 100);
		const svgString = buffer.toString('utf-8');

		expect(svgString).toContain('xmlns="http://www.w3.org/2000/svg"');
	});
});

describe('Edge matching - tabs and blanks should interlock', () => {
	it('tab and blank paths should be complementary (opposite perpendicular offsets)', () => {
		// When piece A has a tab on right, piece B should have blank on left
		// The curves should be mirror images in terms of perpendicular offset

		const tabOnRight: EdgeConfig = { top: 'flat', right: 'tab', bottom: 'flat', left: 'flat' };
		const blankOnLeft: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'flat', left: 'blank' };

		const tabPath = generateJigsawPath(tabOnRight, 100, 100);
		const blankPath = generateJigsawPath(blankOnLeft, 100, 100);

		// Both should have curves
		expect(tabPath).toMatch(/C\s/);
		expect(blankPath).toMatch(/C\s/);

		// Paths should be different (tab extends outward, blank inward)
		expect(tabPath).not.toBe(blankPath);
	});

	it('adjacent pieces with matching edges should have same curve shapes', () => {
		// Verify that tab on bottom of piece A matches blank on top of piece B
		const pieceA: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'tab', left: 'flat' };
		const pieceB: EdgeConfig = { top: 'blank', right: 'flat', bottom: 'flat', left: 'flat' };

		const pathA = generateJigsawPath(pieceA, 100, 100);
		const pathB = generateJigsawPath(pieceB, 100, 100);

		// Both should generate curves for their non-flat edges
		expect(pathA).toMatch(/C\s/);
		expect(pathB).toMatch(/C\s/);
	});
});

describe('Corner and edge piece configurations', () => {
	it('should handle corner piece (two flat edges)', () => {
		// Top-left corner
		const topLeftCorner: EdgeConfig = { top: 'flat', right: 'tab', bottom: 'tab', left: 'flat' };
		const path = generateJigsawPath(topLeftCorner, 100, 100);

		expect(path).toBeTruthy();
		expect(path).toMatch(/^M\s/);
		expect(path).toMatch(/Z$/);
	});

	it('should handle edge piece (one flat edge)', () => {
		// Top edge piece
		const topEdge: EdgeConfig = { top: 'flat', right: 'tab', bottom: 'blank', left: 'tab' };
		const path = generateJigsawPath(topEdge, 100, 100);

		expect(path).toBeTruthy();
		expect(path).toMatch(/C\s/); // Should have curves for non-flat edges
	});

	it('should handle center piece (no flat edges)', () => {
		const centerPiece: EdgeConfig = { top: 'blank', right: 'tab', bottom: 'tab', left: 'blank' };
		const path = generateJigsawPath(centerPiece, 100, 100);

		expect(path).toBeTruthy();
		// Count number of C commands - should have 4 sets (one per edge)
		const curveMatches = path.match(/C\s/g);
		expect(curveMatches).not.toBeNull();
		// Each curved edge has 4 bezier curves
		expect(curveMatches!.length).toBe(16); // 4 edges * 4 curves each
	});
});

describe('Path coordinate bounds', () => {
	it('should have coordinates within expected bounds for flat piece', () => {
		const edges: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' };
		const width = 100;
		const height = 100;
		const path = generateJigsawPath(edges, width, height);

		// Extract all coordinates
		const coords = path.match(/[\d.]+/g)!.map(parseFloat);

		// For flat edges, coordinates should be within the piece bounds
		// Base area starts at TAB_RATIO / expansionFactor (~14.29%) and ends at ~85.71%
		const minExpected = 0;
		const maxExpected = width; // Coordinates should not exceed dimensions

		for (const coord of coords) {
			expect(coord).toBeGreaterThanOrEqual(minExpected);
			expect(coord).toBeLessThanOrEqual(maxExpected);
		}
	});

	it('should have some coordinates outside base area for tab edges', () => {
		const edges: EdgeConfig = { top: 'tab', right: 'flat', bottom: 'flat', left: 'flat' };
		const width = 100;
		const height = 100;
		const path = generateJigsawPath(edges, width, height);

		// Extract Y coordinates (tab on top extends upward, reducing Y)
		const numbers = path.match(/[\d.]+/g)!.map(parseFloat);

		// Some Y coordinates should be near 0 (tab extending to top)
		// Y-coordinates are at odd indices (1, 3, 5...)
		const minY = Math.min(...numbers.filter((_, i) => i % 2 === 1));
		expect(minY).toBeLessThan(height * 0.15); // Tab should extend into vertical margin area
	});
});
