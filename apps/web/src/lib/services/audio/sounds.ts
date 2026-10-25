// Gameplay sound effects. The session store reports every dispatch outcome
// here; soundForOutcome decides which (if any) effect it earns, and the player
// plays it through plain HTMLAudioElements unless the device has muted sound.

import type { PuzzleSessionOutcome } from '@perseus/game-core';

export type SoundName = 'pickup' | 'snap' | 'wrong' | 'rotate' | 'hint' | 'complete';

export const SOUND_NAMES: readonly SoundName[] = [
	'pickup',
	'snap',
	'wrong',
	'rotate',
	'hint',
	'complete'
];

export const SOUND_ENABLED_KEY = 'perseus-sound-enabled-v1';

export function soundForOutcome(outcome: PuzzleSessionOutcome): SoundName | null {
	switch (outcome.type) {
		case 'selection_changed':
			return outcome.pieceId === null ? null : 'pickup';
		case 'placement':
			if (outcome.outcome.status === 'accepted') {
				return outcome.outcome.completed ? 'complete' : 'snap';
			}
			return outcome.outcome.status === 'rejected' ? 'wrong' : null;
		case 'piece_rotated':
			return 'rotate';
		case 'hint_used':
			return outcome.pieceId === null ? null : 'hint';
		default:
			return null;
	}
}

function browserStorage(): Storage | undefined {
	try {
		return typeof localStorage === 'undefined' ? undefined : localStorage;
	} catch {
		return undefined;
	}
}

export function loadSoundEnabled(storage: Storage | undefined = browserStorage()): boolean {
	try {
		return storage?.getItem(SOUND_ENABLED_KEY) !== 'false';
	} catch {
		return true;
	}
}

export function saveSoundEnabled(
	enabled: boolean,
	storage: Storage | undefined = browserStorage()
): void {
	try {
		storage?.setItem(SOUND_ENABLED_KEY, String(enabled));
	} catch {
		// Device preferences are best effort and never block play.
	}
}

export interface SoundPlayer {
	readonly enabled: boolean;
	setEnabled(enabled: boolean): void;
	preload(): void;
	play(name: SoundName): void;
	playForOutcome(outcome: PuzzleSessionOutcome): void;
}

export function createSoundPlayer(storage: Storage | undefined = browserStorage()): SoundPlayer {
	let enabled = loadSoundEnabled(storage);
	const clips = new Map<SoundName, HTMLAudioElement>();

	function clip(name: SoundName): HTMLAudioElement | null {
		if (typeof Audio === 'undefined') return null;
		let audio = clips.get(name);
		if (!audio) {
			audio = new Audio(`/sfx/${name}.mp3`);
			audio.preload = 'auto';
			clips.set(name, audio);
		}
		return audio;
	}

	function play(name: SoundName): void {
		if (!enabled) return;
		const audio = clip(name);
		if (!audio) return;
		audio.currentTime = 0;
		// Autoplay policies may reject before the first user gesture; sound is
		// decoration, so a rejected play is ignored.
		audio.play()?.catch(() => {});
	}

	return {
		get enabled() {
			return enabled;
		},
		setEnabled(next) {
			enabled = next;
			saveSoundEnabled(next, storage);
		},
		preload() {
			for (const name of SOUND_NAMES) clip(name);
		},
		play,
		playForOutcome(outcome) {
			const name = soundForOutcome(outcome);
			if (name) play(name);
		}
	};
}
