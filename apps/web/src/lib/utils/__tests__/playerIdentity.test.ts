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
});
