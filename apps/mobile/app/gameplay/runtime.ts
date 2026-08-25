import type { RunIdCrypto } from '@perseus/game-core';

export function resolveMobileCrypto(): RunIdCrypto {
	const source = (globalThis as any).crypto;
	if (
		!source ||
		(typeof source.randomUUID !== 'function' && typeof source.getRandomValues !== 'function')
	) {
		throw new Error('native_crypto_unavailable');
	}
	return source as RunIdCrypto;
}
