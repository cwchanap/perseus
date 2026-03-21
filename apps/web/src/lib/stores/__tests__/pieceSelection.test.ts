import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { selectedPieceId, setSelectedPiece, clearSelectedPiece } from '../pieceSelection';

describe('pieceSelection store', () => {
	beforeEach(() => {
		// Reset to initial state before each test
		clearSelectedPiece();
	});

	it('starts with null value', () => {
		expect(get(selectedPieceId)).toBeNull();
	});

	it('setSelectedPiece sets the piece id', () => {
		setSelectedPiece(5);
		expect(get(selectedPieceId)).toBe(5);
	});

	it('setSelectedPiece updates to a new id', () => {
		setSelectedPiece(3);
		setSelectedPiece(7);
		expect(get(selectedPieceId)).toBe(7);
	});

	it('setSelectedPiece works with id 0', () => {
		setSelectedPiece(0);
		expect(get(selectedPieceId)).toBe(0);
	});

	it('clearSelectedPiece sets value to null', () => {
		setSelectedPiece(10);
		expect(get(selectedPieceId)).toBe(10);
		clearSelectedPiece();
		expect(get(selectedPieceId)).toBeNull();
	});

	it('clearSelectedPiece is idempotent when already null', () => {
		clearSelectedPiece();
		clearSelectedPiece();
		expect(get(selectedPieceId)).toBeNull();
	});

	it('store is reactive - subscriber receives updates', () => {
		const values: (number | null)[] = [];
		const unsubscribe = selectedPieceId.subscribe((v) => values.push(v));

		setSelectedPiece(1);
		setSelectedPiece(2);
		clearSelectedPiece();

		unsubscribe();

		expect(values).toEqual([null, 1, 2, null]);
	});
});
