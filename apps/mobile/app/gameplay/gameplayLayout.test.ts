import { describe, expect, it } from 'vitest';
import {
	DEFAULT_GAMEPLAY_LAYOUT,
	LANDSCAPE_TRAY_WIDTH,
	PORTRAIT_TRAY_COLLAPSED_HEIGHT,
	PORTRAIT_TRAY_EXPANDED_HEIGHT,
	createGameplayLayout
} from './gameplayLayout';

describe('createGameplayLayout', () => {
	it('exports the existing HPA-3 landscape layout as the safe initial default', () => {
		expect(DEFAULT_GAMEPLAY_LAYOUT).toEqual({
			mode: 'landscape',
			rows: '*',
			columns: `*,${LANDSCAPE_TRAY_WIDTH}`,
			trayRow: 0,
			trayColumn: 1
		});
	});

	it('keeps the right tray in landscape', () => {
		expect(createGameplayLayout(1194, 834, false)).toEqual(DEFAULT_GAMEPLAY_LAYOUT);
	});

	it('uses the collapsed bottom tray in portrait', () => {
		expect(createGameplayLayout(834, 1194, false)).toEqual({
			mode: 'portrait',
			rows: `*,${PORTRAIT_TRAY_COLLAPSED_HEIGHT}`,
			columns: '*',
			trayRow: 1,
			trayColumn: 0
		});
	});

	it('expands only the portrait tray height', () => {
		expect(createGameplayLayout(834, 1194, true)?.rows).toBe(`*,${PORTRAIT_TRAY_EXPANDED_HEIGHT}`);
		expect(createGameplayLayout(1194, 834, true)).toEqual(DEFAULT_GAMEPLAY_LAYOUT);
	});

	it('returns null for non-renderable sizes', () => {
		expect(createGameplayLayout(0, 1194, false)).toBeNull();
		expect(createGameplayLayout(834, Number.NaN, false)).toBeNull();
	});
});
