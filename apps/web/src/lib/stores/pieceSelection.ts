import { writable } from 'svelte/store';

export const selectedPieceId = writable<number | null>(null);

export function setSelectedPiece(id: number): void {
	selectedPieceId.set(id);
}

export function clearSelectedPiece(): void {
	selectedPieceId.set(null);
}
