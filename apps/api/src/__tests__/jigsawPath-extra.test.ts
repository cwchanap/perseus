// Extra tests for jigsaw path generation — non-square dimensions, coordinate bounds, and SVG mask
import { describe, it, expect } from 'vitest';
import { generateJigsawPath, generateJigsawSvgMask } from '../utils/jigsawPath';
import { TAB_RATIO } from '../constants/puzzle';
import type { EdgeConfig } from '../types';

describe('generateJigsawPath - non-square dimensions', () => {
	it('produces valid path for wide (landscape) image', () => {
		const edges: EdgeConfig = { top: 'tab', right: 'blank', bottom: 'tab', left: 'flat' };
		const path = generateJigsawPath(edges, 200, 100);

		expect(path).toMatch(/^M\s/);
		expect(path).toMatch(/Z$/);
		expect(path).toMatch(/C\s/);

		expect(path).not.toContain('NaN');
		expect(path).not.toContain('Infinity');
		const numbers = path.match(/[\d.]+/g)!.map(parseFloat);
		for (const n of numbers) {
			expect(Number.isFinite(n)).toBe(true);
		}
	});

	it('produces valid path for tall (portrait) image', () => {
		const edges: EdgeConfig = { top: 'flat', right: 'tab', bottom: 'flat', left: 'blank' };
		const path = generateJigsawPath(edges, 100, 200);

		expect(path).toMatch(/^M\s/);
		expect(path).toMatch(/Z$/);
		expect(path).toMatch(/C\s/);
	});

	it('scales differently for wide vs tall images with same edges', () => {
		const edges: EdgeConfig = { top: 'tab', right: 'flat', bottom: 'flat', left: 'flat' };
		const wide = generateJigsawPath(edges, 300, 100);
		const tall = generateJigsawPath(edges, 100, 300);

		expect(wide).not.toBe(tall);
	});

	it('produces valid numeric coordinates for non-square image with all curved edges', () => {
		const edges: EdgeConfig = { top: 'tab', right: 'blank', bottom: 'blank', left: 'tab' };
		const path = generateJigsawPath(edges, 160, 80);

		expect(path).not.toContain('NaN');
		expect(path).not.toContain('Infinity');
		const numbers = path.match(/[\d.]+/g)!.map(parseFloat);
		expect(numbers.length).toBeGreaterThan(0);
		for (const n of numbers) {
			expect(Number.isFinite(n)).toBe(true);
			expect(Number.isNaN(n)).toBe(false);
		}
	});
});

describe('generateJigsawPath - blank edge coordinate bounds', () => {
	it('blank on top edge should have Y coordinates that stay within the base area (inward)', () => {
		const edges: EdgeConfig = { top: 'blank', right: 'flat', bottom: 'flat', left: 'flat' };
		const width = 100;
		const height = 100;
		const path = generateJigsawPath(edges, width, height);

		const expansion = 1 + 2 * TAB_RATIO;
		const baseStartY = (TAB_RATIO / expansion) * height;

		expect(path).not.toContain('NaN');
		expect(path).not.toContain('Infinity');
		// Parsed numbers alternate x, y; Y-values are at odd indices (1, 3, 5…)
		const allNums = path.match(/[\d.]+/g)!.map(parseFloat);
		// Skip the M coordinate pair; remaining pairs alternate x, y
		// Simply check that all values are within [0, height]
		for (const n of allNums) {
			expect(n).toBeGreaterThanOrEqual(0);
			expect(n).toBeLessThanOrEqual(width); // width == height == 100
		}

		// Blank curves should NOT extend above baseStartY
		// Extract Y coordinates (odd indices in coordinate pairs after M x y)
		const yCoords = allNums.filter((_, i) => i % 2 === 1);
		const minY = Math.min(...yCoords);
		expect(minY).toBeGreaterThanOrEqual(baseStartY - 0.01); // blank stays within base area
	});

	it('tab on top should extend above baseStartY while blank stays within', () => {
		const tabEdges: EdgeConfig = { top: 'tab', right: 'flat', bottom: 'flat', left: 'flat' };
		const blankEdges: EdgeConfig = { top: 'blank', right: 'flat', bottom: 'flat', left: 'flat' };
		const width = 100;
		const height = 100;

		const tabPath = generateJigsawPath(tabEdges, width, height);
		const blankPath = generateJigsawPath(blankEdges, width, height);

		expect(tabPath).not.toContain('NaN');
		expect(blankPath).not.toContain('NaN');
		expect(tabPath).not.toContain('Infinity');
		expect(blankPath).not.toContain('Infinity');
		const tabNums = tabPath.match(/[\d.]+/g)!.map(parseFloat);
		const blankNums = blankPath.match(/[\d.]+/g)!.map(parseFloat);

		const tabYCoords = tabNums.filter((_, i) => i % 2 === 1);
		const blankYCoords = blankNums.filter((_, i) => i % 2 === 1);

		const minTabY = Math.min(...tabYCoords);
		const minBlankY = Math.min(...blankYCoords);

		// Tab extends outward (smaller Y), blank stays inward (larger min Y)
		expect(minTabY).toBeLessThan(minBlankY);
	});
});

describe('generateJigsawPath - bottom and left edge reversal', () => {
	it('bottom tab and top tab generate different paths', () => {
		const bottomTab: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'tab', left: 'flat' };
		const topTab: EdgeConfig = { top: 'tab', right: 'flat', bottom: 'flat', left: 'flat' };

		const bottomPath = generateJigsawPath(bottomTab, 100, 100);
		const topPath = generateJigsawPath(topTab, 100, 100);

		expect(bottomPath).toMatch(/C\s/);
		expect(topPath).toMatch(/C\s/);
		expect(bottomPath).not.toBe(topPath);
	});

	it('left tab and right tab generate different paths', () => {
		const leftTab: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'flat', left: 'tab' };
		const rightTab: EdgeConfig = { top: 'flat', right: 'tab', bottom: 'flat', left: 'flat' };

		const leftPath = generateJigsawPath(leftTab, 100, 100);
		const rightPath = generateJigsawPath(rightTab, 100, 100);

		expect(leftPath).toMatch(/C\s/);
		expect(rightPath).toMatch(/C\s/);
		expect(leftPath).not.toBe(rightPath);
	});

	it('bottom blank and top blank produce different paths', () => {
		const bottomBlank: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'blank', left: 'flat' };
		const topBlank: EdgeConfig = { top: 'blank', right: 'flat', bottom: 'flat', left: 'flat' };

		const bottomPath = generateJigsawPath(bottomBlank, 100, 100);
		const topPath = generateJigsawPath(topBlank, 100, 100);

		expect(bottomPath).not.toBe(topPath);
	});

	it('left blank and right blank produce different paths', () => {
		const leftBlank: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'flat', left: 'blank' };
		const rightBlank: EdgeConfig = { top: 'flat', right: 'blank', bottom: 'flat', left: 'flat' };

		const leftPath = generateJigsawPath(leftBlank, 100, 100);
		const rightPath = generateJigsawPath(rightBlank, 100, 100);

		expect(leftPath).not.toBe(rightPath);
	});
});

describe('generateJigsawSvgMask - non-square dimensions', () => {
	it('generates correct SVG dimensions for landscape image', () => {
		const edges: EdgeConfig = { top: 'tab', right: 'flat', bottom: 'flat', left: 'flat' };
		const buffer = generateJigsawSvgMask(edges, 200, 100);
		const svgString = buffer.toString('utf-8');

		expect(svgString).toContain('width="200"');
		expect(svgString).toContain('height="100"');
		expect(svgString).toContain('viewBox="0 0 200 100"');
	});

	it('generates correct SVG dimensions for portrait image', () => {
		const edges: EdgeConfig = { top: 'flat', right: 'tab', bottom: 'flat', left: 'flat' };
		const buffer = generateJigsawSvgMask(edges, 80, 160);
		const svgString = buffer.toString('utf-8');

		expect(svgString).toContain('width="80"');
		expect(svgString).toContain('height="160"');
		expect(svgString).toContain('viewBox="0 0 80 160"');
	});

	it('includes a path element with white fill in SVG mask', () => {
		const edges: EdgeConfig = { top: 'blank', right: 'tab', bottom: 'blank', left: 'tab' };
		const buffer = generateJigsawSvgMask(edges, 120, 80);
		const svgString = buffer.toString('utf-8');

		expect(svgString).toContain('fill="white"');
		expect(svgString).toMatch(/<path d="[^"]+"/);
	});
});

describe('generateJigsawPath - C command count per edge', () => {
	it('single tab edge produces exactly 4 C commands', () => {
		const edges: EdgeConfig = { top: 'tab', right: 'flat', bottom: 'flat', left: 'flat' };
		const path = generateJigsawPath(edges, 100, 100);

		const curveMatches = path.match(/C\s/g);
		expect(curveMatches).not.toBeNull();
		expect(curveMatches!.length).toBe(4);
	});

	it('single blank edge produces exactly 4 C commands', () => {
		const edges: EdgeConfig = { top: 'flat', right: 'blank', bottom: 'flat', left: 'flat' };
		const path = generateJigsawPath(edges, 100, 100);

		const curveMatches = path.match(/C\s/g);
		expect(curveMatches).not.toBeNull();
		expect(curveMatches!.length).toBe(4);
	});

	it('two curved edges produces exactly 8 C commands', () => {
		const edges: EdgeConfig = { top: 'tab', right: 'blank', bottom: 'flat', left: 'flat' };
		const path = generateJigsawPath(edges, 100, 100);

		const curveMatches = path.match(/C\s/g);
		expect(curveMatches).not.toBeNull();
		expect(curveMatches!.length).toBe(8);
	});
});
