// Unit tests for undo/redo history helper
import { describe, it, expect, beforeEach } from 'vitest';
import { createHistory, type History } from './history';

describe('History Helper', () => {
	let history: History<string>;

	beforeEach(() => {
		history = createHistory<string>();
	});

	describe('createHistory', () => {
		it('should create empty history', () => {
			expect(history.canUndo()).toBe(false);
			expect(history.canRedo()).toBe(false);
		});

		it('should accept initial state', () => {
			const h = createHistory<string>('initial');
			expect(h.canUndo()).toBe(false);
			expect(h.getCurrent()).toBe('initial');
		});

		it('should accept max size', () => {
			const h = createHistory<number>(0, 3);
			h.push(1);
			h.push(2);
			h.push(3);
			h.push(4);
			// Should only keep last 3
			expect(h.canUndo()).toBe(true);
			h.undo();
			h.undo();
			h.undo();
			expect(h.canUndo()).toBe(false);
			expect(h.getCurrent()).toBe(2);
		});

		it('should handle initial state with one push correctly', () => {
			const h = createHistory<string>('initial');
			h.push('first');

			// Should be able to undo back to initial
			expect(h.canUndo()).toBe(true);
			expect(h.getCurrent()).toBe('first');

			const undoResult = h.undo();
			expect(undoResult).toBe('initial');
			expect(h.getCurrent()).toBe('initial');

			// At initial state, cannot undo further
			expect(h.canUndo()).toBe(false);
		});

		it('should handle empty history with one push correctly', () => {
			const h = createHistory<string>();
			h.push('first');

			// Should be able to undo to empty state
			expect(h.canUndo()).toBe(true);
			expect(h.getCurrent()).toBe('first');

			const undoResult = h.undo();
			expect(undoResult).toBeUndefined();
			expect(h.getCurrent()).toBeUndefined();

			// At empty state, cannot undo further
			expect(h.canUndo()).toBe(false);
		});
	});

	describe('push', () => {
		it('should add state to history', () => {
			history.push('a');
			expect(history.canUndo()).toBe(true);
			expect(history.getCurrent()).toBe('a');
		});

		it('should clear redo stack on push', () => {
			history.push('a');
			history.push('b');
			history.undo();
			expect(history.canRedo()).toBe(true);

			history.push('c');
			expect(history.canRedo()).toBe(false);
			expect(history.getCurrent()).toBe('c');
		});
	});

	describe('undo', () => {
		it('should move back in history', () => {
			history.push('a');
			history.push('b');

			const result = history.undo();
			expect(result).toBe('a');
			expect(history.getCurrent()).toBe('a');
			expect(history.canRedo()).toBe(true);
		});

		it('should return undefined when cannot undo', () => {
			const result = history.undo();
			expect(result).toBeUndefined();
		});
	});

	describe('redo', () => {
		it('should move forward in history', () => {
			history.push('a');
			history.push('b');
			history.undo();

			const result = history.redo();
			expect(result).toBe('b');
			expect(history.getCurrent()).toBe('b');
		});

		it('should return undefined when cannot redo', () => {
			const result = history.redo();
			expect(result).toBeUndefined();
		});
	});

	describe('getCurrent', () => {
		it('should return current state', () => {
			expect(history.getCurrent()).toBeUndefined();

			history.push('a');
			expect(history.getCurrent()).toBe('a');

			history.push('b');
			expect(history.getCurrent()).toBe('b');

			history.undo();
			expect(history.getCurrent()).toBe('a');
		});
	});

	describe('clear', () => {
		it('should clear all history', () => {
			history.push('a');
			history.push('b');
			history.undo();

			history.clear();

			expect(history.canUndo()).toBe(false);
			expect(history.canRedo()).toBe(false);
			expect(history.getCurrent()).toBeUndefined();
		});

		it('should allow undo back to empty history after clearing an initial state', () => {
			const h = createHistory<string>('initial');

			h.clear();
			h.push('next');

			expect(h.canUndo()).toBe(true);
			expect(h.undo()).toBeUndefined();
			expect(h.getCurrent()).toBeUndefined();
			expect(h.canUndo()).toBe(false);
		});
	});
});
