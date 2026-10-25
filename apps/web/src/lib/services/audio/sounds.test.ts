import { describe, expect, it, vi } from 'vitest';
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

	it('uses localStorage by default', () => {
		localStorage.removeItem(SOUND_ENABLED_KEY);
		try {
			saveSoundEnabled(false);
			expect(loadSoundEnabled()).toBe(false);
		} finally {
			localStorage.removeItem(SOUND_ENABLED_KEY);
		}
	});

	it('falls back to enabled when storage throws', () => {
		const broken = {
			getItem: () => {
				throw new Error('denied');
			},
			setItem: () => {
				throw new Error('denied');
			}
		} as unknown as Storage;

		expect(loadSoundEnabled(broken)).toBe(true);
		expect(() => saveSoundEnabled(false, broken)).not.toThrow();
	});

	it('player setEnabled persists the choice', () => {
		const store: Record<string, string> = {};
		const player = createSoundPlayer(memoryStorage(store));
		expect(player.enabled).toBe(true);

		player.setEnabled(false);

		expect(player.enabled).toBe(false);
		expect(createSoundPlayer(memoryStorage(store)).enabled).toBe(false);
	});

	it('skips preloading while muted', () => {
		const player = createSoundPlayer(memoryStorage({ [SOUND_ENABLED_KEY]: 'false' }));
		const AudioSpy = vi.spyOn(window, 'Audio');

		player.preload();

		expect(AudioSpy).not.toHaveBeenCalled();
		AudioSpy.mockRestore();
	});
});

describe('sound player playback', () => {
	function spyPlay(result: Promise<void>) {
		return vi.spyOn(HTMLMediaElement.prototype, 'play').mockReturnValue(result);
	}

	it('plays the clip mapped from an outcome and rewinds it', () => {
		const play = spyPlay(Promise.resolve());
		const player = createSoundPlayer(memoryStorage({}));
		player.preload();

		player.playForOutcome({ type: 'piece_rotated', pieceId: 1 });
		player.playForOutcome({ type: 'history_restored', direction: 'undo' });

		expect(play).toHaveBeenCalledOnce();
		const audio = play.mock.contexts[0] as HTMLAudioElement;
		expect(audio.src).toContain('/sfx/rotate.mp3');
		expect(audio.currentTime).toBe(0);
		play.mockRestore();
	});

	it('stays silent while muted', () => {
		const play = spyPlay(Promise.resolve());
		const player = createSoundPlayer(memoryStorage({}));
		player.setEnabled(false);

		player.play('snap');

		expect(play).not.toHaveBeenCalled();
		play.mockRestore();
	});

	it('ignores a rejected play', async () => {
		const play = spyPlay(Promise.reject(new Error('NotAllowedError')));
		const player = createSoundPlayer(memoryStorage({}));

		expect(() => player.play('hint')).not.toThrow();
		await Promise.resolve();

		expect(play).toHaveBeenCalledOnce();
		play.mockRestore();
	});
});
