/**
 * Puzzle piece sizing constants
 * These must match the values used in the web app components
 */

// Tab size as fraction of base piece dimension (20%)
export const TAB_RATIO = 0.2;

// Expansion factor for piece containers (1 + 2 * TAB_RATIO)
export const EXPANSION_FACTOR = 1 + 2 * TAB_RATIO; // 1.4 (140%)

// Base offset for positioning pieces within containers
export const BASE_OFFSET = TAB_RATIO / EXPANSION_FACTOR; // ~14.29%
