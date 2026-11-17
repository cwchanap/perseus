import { describe, expect, it } from 'vitest';
import { playerIdentity } from '../playerIdentity';

describe('playerIdentity', () => {
	it('derives display name and initials from a full name', () => {
		expect(playerIdentity('Alex C.')).toEqual({ displayName: 'Alex C.', initials: 'AC' });
	});

	it('falls back to a generic identity for an absent or blank name', () => {
		for (const name of ['', '   ', null, undefined]) {
			expect(playerIdentity(name)).toEqual({ displayName: 'Player', initials: 'P' });
		}
	});

	it('trims surrounding whitespace while still reading initials from parts', () => {
		expect(playerIdentity('  Rae  Villa ')).toEqual({
			displayName: 'Rae  Villa',
			initials: 'RV'
		});
	});

	it('uses a single-part name as one initial', () => {
		expect(playerIdentity('Serena')).toEqual({ displayName: 'Serena', initials: 'S' });
	});

	it('keeps supplementary-plane characters whole when deriving initials', () => {
		// 𠮷 (U+20BB7) is one code point but two UTF-16 code units; UTF-16
		// indexing would leak a lone surrogate into the avatar and label.
		expect(playerIdentity('𠮷野 太郎')).toEqual({
			displayName: '𠮷野 太郎',
			initials: '𠮷太'
		});
	});

	it('falls back to the player email when the name is blank', () => {
		// Matches the arcade shell's identity for a nameless account so the
		// profile avatar and the shell avatar cannot disagree.
		expect(playerIdentity('  ', 'rae@example.com')).toEqual({
			displayName: 'rae@example.com',
			initials: 'R'
		});
	});

	it('splits name parts on any whitespace, including the ideographic space', () => {
		expect(playerIdentity('山田　太郎')).toEqual({
			displayName: '山田　太郎',
			initials: '山太'
		});
	});

	it('keeps grapheme clusters whole when deriving initials', () => {
		// A flag emoji is two regional-indicator code points; a decomposed é
		// (e + U+0301) is two code points. Each is one grapheme — splitting on
		// code points would leak half a flag or a bare combining mark.
		expect(playerIdentity('🇯🇵 Tanaka').initials).toBe('🇯🇵T');
		expect(playerIdentity('e\u0301clair Test').initials).toBe('E\u0301T');
	});
});
