// Unit tests for viewport helper. calculateFitZoom tests live with the
// portable formula in @perseus/game-core (geometry).
import { describe, it, expect } from 'vitest';
import { clampZoom, clampPan, type ViewportBounds } from './viewport';

describe('Viewport Helper', () => {
	describe('clampZoom', () => {
		it('should clamp to min zoom', () => {
			expect(clampZoom(0.1, 0.5, 3)).toBe(0.5);
			expect(clampZoom(0.3, 0.5, 3)).toBe(0.5);
		});

		it('should clamp to max zoom', () => {
			expect(clampZoom(5, 0.5, 3)).toBe(3);
			expect(clampZoom(10, 0.5, 3)).toBe(3);
		});

		it('should allow values within range', () => {
			expect(clampZoom(1, 0.5, 3)).toBe(1);
			expect(clampZoom(2, 0.5, 3)).toBe(2);
			expect(clampZoom(0.5, 0.5, 3)).toBe(0.5);
			expect(clampZoom(3, 0.5, 3)).toBe(3);
		});
	});

	describe('clampPan', () => {
		const bounds: ViewportBounds = {
			minX: -100,
			maxX: 100,
			minY: -50,
			maxY: 50
		};

		it('should clamp x to min', () => {
			const result = clampPan(-200, 0, bounds);
			expect(result.x).toBe(-100);
		});

		it('should clamp x to max', () => {
			const result = clampPan(200, 0, bounds);
			expect(result.x).toBe(100);
		});

		it('should clamp y to min', () => {
			const result = clampPan(0, -100, bounds);
			expect(result.y).toBe(-50);
		});

		it('should clamp y to max', () => {
			const result = clampPan(0, 100, bounds);
			expect(result.y).toBe(50);
		});

		it('should allow values within bounds', () => {
			const result = clampPan(50, 25, bounds);
			expect(result.x).toBe(50);
			expect(result.y).toBe(25);
		});

		it('should clamp both x and y if needed', () => {
			const result = clampPan(-500, 200, bounds);
			expect(result.x).toBe(-100);
			expect(result.y).toBe(50);
		});
	});
});
