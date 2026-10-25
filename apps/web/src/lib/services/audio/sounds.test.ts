import { describe, expect, it } from 'vitest';
import type { PuzzleSessionOutcome } from '@perseus/game-core';
import { memoryStorage } from '../gameplay/session/persistence.test-fixtures';
import {
	SOUND_ENABLED_KEY,
	createSoundPlayer,
	loadSoundEnabled,
	saveSoundEnabled,
	soundForOutcome
} from './sounds';

describe('soundForOutcome', () => {
	it.each<[PuzzleSessionOutcome, string | null]>([
		[{ type: 'selection_changed', pieceId: 3 }, 'pickup'],
		[{ type: 'selection_changed', pieceId: null }, null],
		[{ type: 'placement', outcome: { status: 'accepted', completed: false } }, 'snap'],
		[{ type: 'placement', outcome: { status: 'accepted', completed: true } }, 'complete'],
		[
			{ type: 'placement', outcome: { status: 'rejected', reason: 'wrong_slot', counted: true } },
			'wrong'
		],
		[{ type: 'placement', outcome: { status: 'noop', reason: 'unknown_piece' } }, null],
		[{ type: 'piece_rotated', pieceId: 1 }, 'rotate'],
		[{ type: 'hint_used', pieceId: 2 }, 'hint'],
		[{ type: 'hint_used', pieceId: null }, null],
		[{ type: 'history_restored', direction: 'undo' }, null]
	])('maps %j to %s', (outcome, expected) => {
		expect(soundForOutcome(outcome)).toBe(expected);
	});
});

describe('sound enabled preference', () => {
	it('defaults to enabled and round-trips', () => {
		const store: Record<string, string> = {};
		const storage = memoryStorage(store);
		expect(loadSoundEnabled(storage)).toBe(true);

		saveSoundEnabled(false, storage);

		expect(store[SOUND_ENABLED_KEY]).toBe('false');
		expect(loadSoundEnabled(storage)).toBe(false);
	});

	it('player setEnabled persists the choice', () => {
		const store: Record<string, string> = {};
		const player = createSoundPlayer(memoryStorage(store));
		expect(player.enabled).toBe(true);

		player.setEnabled(false);

		expect(player.enabled).toBe(false);
		expect(createSoundPlayer(memoryStorage(store)).enabled).toBe(false);
	});
});
