// Unit tests for viewport helper
import { describe, it, expect } from 'vitest';
import { clampZoom, clampPan, calculateFitZoom, type ViewportBounds } from './viewport';

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

	describe('calculateFitZoom', () => {
		it('should fit width when puzzle is wider', () => {
			const zoom = calculateFitZoom(1600, 800, 800, 600, 0.9);
			// viewport: 800x600, puzzle: 1600x800
			// width ratio: 800/1600 = 0.5
			// height ratio: 600/800 = 0.75
			// min ratio with padding: 0.5 * 0.9 = 0.45
			expect(zoom).toBeCloseTo(0.45);
		});

		it('should fit height when puzzle is taller', () => {
			const zoom = calculateFitZoom(800, 1600, 800, 600, 0.9);
			// viewport: 800x600, puzzle: 800x1600
			// width ratio: 800/800 = 1.0
			// height ratio: 600/1600 = 0.375
			// min ratio with padding: 0.375 * 0.9 = 0.3375
			expect(zoom).toBeCloseTo(0.3375);
		});

		it('should use default padding factor', () => {
			const zoom = calculateFitZoom(1000, 1000, 800, 600);
			// Default padding should be 0.9
			// width ratio: 800/1000 = 0.8
			// height ratio: 600/1000 = 0.6
			// min ratio with padding: 0.6 * 0.9 = 0.54
			expect(zoom).toBeCloseTo(0.54);
		});

		it('should handle square puzzle in square viewport', () => {
			const zoom = calculateFitZoom(1000, 1000, 1000, 1000, 0.8);
			expect(zoom).toBeCloseTo(0.8);
		});

		it('should handle no padding', () => {
			const zoom = calculateFitZoom(1000, 500, 500, 500, 1.0);
			// width ratio: 500/1000 = 0.5
			// height ratio: 500/500 = 1.0
			// min ratio: 0.5 * 1.0 = 0.5
			expect(zoom).toBeCloseTo(0.5);
		});
	});
});
