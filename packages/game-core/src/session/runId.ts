// Canonical lowercase UUID v4 run-id factory over a structural crypto source.
import type { RunIdFactory } from './types';

export interface RunIdCrypto {
	randomUUID?(): string;
	getRandomValues(array: Uint8Array): Uint8Array;
}

/**
 * Factory for fresh canonical lowercase UUID v4 run ids. Uses the source's
 * `randomUUID` when present, and otherwise formats 16 bytes from
 * `getRandomValues`, setting the version (4) and variant (8-b) nibbles. Never
 * falls back to `Math.random`. The structural source lets web pass the global
 * `crypto` and NativeScript pass its platform equivalent; tests inject
 * deterministic bytes.
 */
export function createRunIdFactory(source: RunIdCrypto): RunIdFactory {
	return {
		create: () =>
			typeof source.randomUUID === 'function'
				? source.randomUUID().toLowerCase()
				: fallbackUuidV4(source)
	};
}

function fallbackUuidV4(source: RunIdCrypto): string {
	const bytes = new Uint8Array(16);
	source.getRandomValues(bytes);
	// RFC 4122 v4: version nibble (byte 6 high) = 0100, variant (byte 8 high) = 10.
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
