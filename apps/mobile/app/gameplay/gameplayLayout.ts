export const LANDSCAPE_TRAY_WIDTH = 320;
export const PORTRAIT_TRAY_COLLAPSED_HEIGHT = 220;
export const PORTRAIT_TRAY_EXPANDED_HEIGHT = 360;

export type GameplayLayoutMode = 'landscape' | 'portrait';

export interface GameplayLayout {
	mode: GameplayLayoutMode;
	rows: string;
	columns: string;
	trayRow: number;
	trayColumn: number;
}

export const DEFAULT_GAMEPLAY_LAYOUT: GameplayLayout = {
	mode: 'landscape',
	rows: '*',
	columns: `*,${LANDSCAPE_TRAY_WIDTH}`,
	trayRow: 0,
	trayColumn: 1
};

export function createGameplayLayout(
	widthDip: number,
	heightDip: number,
	portraitTrayExpanded: boolean
): GameplayLayout | null {
	if (
		!Number.isFinite(widthDip) ||
		!Number.isFinite(heightDip) ||
		widthDip <= 0 ||
		heightDip <= 0
	) {
		return null;
	}

	if (heightDip > widthDip) {
		const trayHeight = portraitTrayExpanded
			? PORTRAIT_TRAY_EXPANDED_HEIGHT
			: PORTRAIT_TRAY_COLLAPSED_HEIGHT;
		return {
			mode: 'portrait',
			rows: `*,${trayHeight}`,
			columns: '*',
			trayRow: 1,
			trayColumn: 0
		};
	}

	return DEFAULT_GAMEPLAY_LAYOUT;
}
