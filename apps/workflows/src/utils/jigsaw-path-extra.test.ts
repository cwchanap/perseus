// Extra coverage tests for the workflows jigsaw-path utility
import { describe, it, expect } from 'vitest';
import { generateJigsawPath, generateJigsawSvgMask } from './jigsaw-path';
import type { EdgeConfig } from '../types';

describe('generateJigsawPath - all edge type permutations', () => {
	const edgeTypes = ['flat', 'tab', 'blank'] as const;

	it('produces valid paths for all 81 edge type combinations', () => {
		for (const top of edgeTypes) {
			for (const right of edgeTypes) {
				for (const bottom of edgeTypes) {
					for (const left of edgeTypes) {
						const edges: EdgeConfig = { top, right, bottom, left };
						const path = generateJigsawPath(edges, 100, 100);

						expect(path).toBeTruthy();
						expect(path).toMatch(/^M\s/);
						expect(path).toMatch(/Z$/);

						expect(path).not.toContain('NaN');
						expect(path).not.toContain('Infinity');
						const numbers = path.match(/[\d.]+/g)!.map(parseFloat);
						for (const n of numbers) {
							expect(Number.isFinite(n)).toBe(true);
							expect(Number.isNaN(n)).toBe(false);
						}
					}
				}
			}
		}
	});
});

describe('generateJigsawPath - flat edge produces no curves', () => {
	it('generates no C commands for all-flat piece', () => {
		const edges: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' };
		const path = generateJigsawPath(edges, 100, 100);
		expect(path).not.toMatch(/C\s/);
	});
});

describe('generateJigsawPath - C command counts per edge', () => {
	it('single tab on top produces 4 C commands', () => {
		const edges: EdgeConfig = { top: 'tab', right: 'flat', bottom: 'flat', left: 'flat' };
		const path = generateJigsawPath(edges, 100, 100);
		expect((path.match(/C\s/g) ?? []).length).toBe(4);
	});

	it('single blank on right produces 4 C commands', () => {
		const edges: EdgeConfig = { top: 'flat', right: 'blank', bottom: 'flat', left: 'flat' };
		const path = generateJigsawPath(edges, 100, 100);
		expect((path.match(/C\s/g) ?? []).length).toBe(4);
	});

	it('single tab on bottom produces 4 C commands', () => {
		const edges: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'tab', left: 'flat' };
		const path = generateJigsawPath(edges, 100, 100);
		expect((path.match(/C\s/g) ?? []).length).toBe(4);
	});

	it('single blank on left produces 4 C commands', () => {
		const edges: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'flat', left: 'blank' };
		const path = generateJigsawPath(edges, 100, 100);
		expect((path.match(/C\s/g) ?? []).length).toBe(4);
	});

	it('all four curved edges produce 16 C commands', () => {
		const edges: EdgeConfig = { top: 'blank', right: 'tab', bottom: 'tab', left: 'blank' };
		const path = generateJigsawPath(edges, 100, 100);
		expect((path.match(/C\s/g) ?? []).length).toBe(16);
	});
});

describe('generateJigsawPath - bottom and left edge reversal', () => {
	it('bottom tab and top tab produce different paths', () => {
		const bottomTab: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'tab', left: 'flat' };
		const topTab: EdgeConfig = { top: 'tab', right: 'flat', bottom: 'flat', left: 'flat' };

		expect(generateJigsawPath(bottomTab, 100, 100)).not.toBe(generateJigsawPath(topTab, 100, 100));
	});

	it('left blank and right blank produce different paths', () => {
		const leftBlank: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'flat', left: 'blank' };
		const rightBlank: EdgeConfig = { top: 'flat', right: 'blank', bottom: 'flat', left: 'flat' };

		expect(generateJigsawPath(leftBlank, 100, 100)).not.toBe(
			generateJigsawPath(rightBlank, 100, 100)
		);
	});

	it('bottom blank and top blank produce different paths', () => {
		const bottomBlank: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'blank', left: 'flat' };
		const topBlank: EdgeConfig = { top: 'blank', right: 'flat', bottom: 'flat', left: 'flat' };

		expect(generateJigsawPath(bottomBlank, 100, 100)).not.toBe(
			generateJigsawPath(topBlank, 100, 100)
		);
	});

	it('left tab and right tab produce different paths', () => {
		const leftTab: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'flat', left: 'tab' };
		const rightTab: EdgeConfig = { top: 'flat', right: 'tab', bottom: 'flat', left: 'flat' };

		expect(generateJigsawPath(leftTab, 100, 100)).not.toBe(generateJigsawPath(rightTab, 100, 100));
	});
});

describe('generateJigsawPath - tab vs blank perpendicular directions', () => {
	it('tab on top extends upward (min Y smaller) compared to blank on top', () => {
		const tabTop: EdgeConfig = { top: 'tab', right: 'flat', bottom: 'flat', left: 'flat' };
		const blankTop: EdgeConfig = { top: 'blank', right: 'flat', bottom: 'flat', left: 'flat' };

		const tabPath = generateJigsawPath(tabTop, 100, 100);
		const blankPath = generateJigsawPath(blankTop, 100, 100);
		expect(tabPath).not.toContain('NaN');
		expect(blankPath).not.toContain('NaN');
		expect(tabPath).not.toContain('Infinity');
		expect(blankPath).not.toContain('Infinity');
		const tabNums = tabPath.match(/[\d.]+/g)!.map(parseFloat);
		const blankNums = blankPath.match(/[\d.]+/g)!.map(parseFloat);

		const minTabY = Math.min(...tabNums.filter((_, i) => i % 2 === 1));
		const minBlankY = Math.min(...blankNums.filter((_, i) => i % 2 === 1));

		expect(minTabY).toBeLessThan(minBlankY);
	});
});

describe('generateJigsawPath - coordinate validity for large dimensions', () => {
	it('handles large dimensions without overflow', () => {
		const edges: EdgeConfig = { top: 'tab', right: 'blank', bottom: 'tab', left: 'blank' };
		const path = generateJigsawPath(edges, 1000, 800);

		expect(path).not.toContain('NaN');
		expect(path).not.toContain('Infinity');
		const numbers = path.match(/[\d.]+/g)!.map(parseFloat);
		for (const n of numbers) {
			expect(Number.isFinite(n)).toBe(true);
		}
	});

	it('handles small (1x1) dimensions', () => {
		const edges: EdgeConfig = { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' };
		const path = generateJigsawPath(edges, 1, 1);

		expect(path).toMatch(/^M\s/);
		expect(path).toMatch(/Z$/);
	});
});

describe('generateJigsawSvgMask - output format', () => {
	it('SVG output is a string containing the generated path', () => {
		const edges: EdgeConfig = { top: 'tab', right: 'flat', bottom: 'blank', left: 'flat' };
		const path = generateJigsawPath(edges, 100, 100);
		const svg = generateJigsawSvgMask(edges, 100, 100);

		expect(svg).toContain(`d="${path}"`);
	});

	it('uses correct dimensions for non-square images', () => {
		const edges: EdgeConfig = { top: 'flat', right: 'tab', bottom: 'flat', left: 'blank' };
		const svg = generateJigsawSvgMask(edges, 300, 200);

		expect(svg).toContain('width="300"');
		expect(svg).toContain('height="200"');
		expect(svg).toContain('viewBox="0 0 300 200"');
	});

	it('always includes xmlns and white fill', () => {
		const edges: EdgeConfig = { top: 'blank', right: 'blank', bottom: 'blank', left: 'blank' };
		const svg = generateJigsawSvgMask(edges, 50, 50);

		expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
		expect(svg).toContain('fill="white"');
	});
});
