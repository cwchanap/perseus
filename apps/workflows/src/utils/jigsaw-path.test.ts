import { describe, it, expect } from 'vitest';
import { generateJigsawPath, generateJigsawSvgMask } from './jigsaw-path';
import type { EdgeConfig } from '../types';

describe('generateJigsawPath', () => {
	it('should generate a valid SVG path for all flat edges', () => {
		const edges: EdgeConfig = {
			top: 'flat',
			right: 'flat',
			bottom: 'flat',
			left: 'flat'
		};

		const path = generateJigsawPath(edges, 100, 100);

		expect(path).toContain('M'); // Move command
		expect(path).toContain('L'); // Line commands for flat edges
		expect(path).toContain('Z'); // Close path
		expect(path).not.toContain('C'); // No curves for flat edges
	});

	it('should generate curves for tab edges', () => {
		const edges: EdgeConfig = {
			top: 'tab',
			right: 'flat',
			bottom: 'flat',
			left: 'flat'
		};

		const path = generateJigsawPath(edges, 100, 100);

		expect(path).toContain('C'); // Cubic bezier curves for tab
		expect(path).toContain('Z');
	});

	it('should generate curves for blank edges', () => {
		const edges: EdgeConfig = {
			top: 'blank',
			right: 'flat',
			bottom: 'flat',
			left: 'flat'
		};

		const path = generateJigsawPath(edges, 100, 100);

		expect(path).toContain('C'); // Cubic bezier curves for blank
		expect(path).toContain('Z');
	});

	it('should handle mixed edge types', () => {
		const edges: EdgeConfig = {
			top: 'tab',
			right: 'blank',
			bottom: 'tab',
			left: 'blank'
		};

		const path = generateJigsawPath(edges, 100, 100);

		// Should have multiple curve sections
		const curveCount = (path.match(/[Cc](?=[\d\s-])/g) || []).length;
		expect(curveCount).toBeGreaterThan(4); // Multiple curves for all non-flat edges
	});

	it('should scale with different dimensions', () => {
		const edges: EdgeConfig = {
			top: 'flat',
			right: 'flat',
			bottom: 'flat',
			left: 'flat'
		};

		const smallPath = generateJigsawPath(edges, 50, 50);
		const largePath = generateJigsawPath(edges, 200, 200);

		// Paths should be different due to different coordinates
		expect(smallPath).not.toBe(largePath);
	});

	it('should handle non-square dimensions', () => {
		const edges: EdgeConfig = {
			top: 'tab',
			right: 'blank',
			bottom: 'flat',
			left: 'tab'
		};

		const path = generateJigsawPath(edges, 150, 100);

		expect(path).toContain('M');
		expect(path).toContain('Z');
	});
});

describe('generateJigsawSvgMask', () => {
	it('should generate valid SVG markup', () => {
		const edges: EdgeConfig = {
			top: 'flat',
			right: 'flat',
			bottom: 'flat',
			left: 'flat'
		};

		const svg = generateJigsawSvgMask(edges, 100, 100);

		expect(svg).toContain('<svg');
		expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
		expect(svg).toContain('width="100"');
		expect(svg).toContain('height="100"');
		expect(svg).toContain('<path');
		expect(svg).toContain('fill="white"');
		expect(svg).toContain('</svg>');
	});

	it('should include viewBox attribute', () => {
		const edges: EdgeConfig = {
			top: 'tab',
			right: 'tab',
			bottom: 'tab',
			left: 'tab'
		};

		const svg = generateJigsawSvgMask(edges, 200, 150);

		expect(svg).toContain('viewBox="0 0 200 150"');
	});

	it('should embed the jigsaw path in the SVG', () => {
		const edges: EdgeConfig = {
			top: 'tab',
			right: 'flat',
			bottom: 'blank',
			left: 'flat'
		};

		const path = generateJigsawPath(edges, 100, 100);
		const svg = generateJigsawSvgMask(edges, 100, 100);

		expect(svg).toContain(`d="${path}"`);
	});
});
