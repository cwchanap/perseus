// Unit tests for the portable fit-zoom geometry helper
// (moved from web viewport.test.ts; zoom/pan clamp tests stay web-local).
import { describe, it, expect } from 'vitest';
import { calculateFitZoom } from './geometry';

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

	it('should return 0 when puzzle width is not positive', () => {
		expect(calculateFitZoom(0, 500, 500, 500)).toBe(0);
		expect(calculateFitZoom(-100, 500, 500, 500)).toBe(0);
	});

	it('should return 0 when puzzle height is not positive', () => {
		expect(calculateFitZoom(500, 0, 500, 500)).toBe(0);
		expect(calculateFitZoom(500, -100, 500, 500)).toBe(0);
	});
});
