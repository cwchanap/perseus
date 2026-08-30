import { describe, expect, it } from 'vitest';
import {
	commitViewport,
	discardProgress,
	entrySheetFor,
	suspendSession
} from './gameplaySessionPolicy';

describe('gameplaySessionPolicy', () => {
	it('maps fresh/active/paused entry without dispatching an active restore', () => {
		expect(entrySheetFor(undefined)).toBe('setup');
		expect(entrySheetFor({ lifecycle: 'active' })).toBeNull();
		expect(entrySheetFor({ lifecycle: 'paused' })).toBe('pause');
	});

	it('hides before save on suspend', () => {
		const calls: string[] = [];
		suspendSession({ setDocumentHidden: (hidden) => calls.push(`hidden:${hidden}`) }, () =>
			calls.push('save')
		);
		expect(calls).toEqual(['hidden:true', 'save']);
	});

	it('saves only an accepted viewport change', () => {
		let saves = 0;
		const changed = commitViewport(
			{ dispatch: () => ({ type: 'viewport_changed', viewport: null }) },
			null,
			() => saves++
		);
		expect(changed.type).toBe('viewport_changed');
		expect(saves).toBe(1);

		const invalid = commitViewport(
			{ dispatch: () => ({ type: 'viewport_noop', reason: 'invalid_viewport' }) },
			{ zoom: 0, panX: 0, panY: 0 },
			() => saves++
		);
		expect(invalid.type).toBe('viewport_noop');
		expect(saves).toBe(1);
	});

	it('returns the storage discard result unchanged', () => {
		expect(discardProgress({ clearSession: () => false }, 'pz1')).toBe(false);
		expect(discardProgress({ clearSession: () => true }, 'pz1')).toBe(true);
	});
});
