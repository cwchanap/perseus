// Synchronous, browser-compatible run-ID and canonical-JSON helpers.
//
// The codec must remain synchronous and must not depend on the secure-context
// only `crypto.subtle`. SHA-256 uses the audited `@noble/hashes` WASM-free
// implementation over UTF-8 bytes.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { RunIdFactory } from './types';

/**
 * SHA-256 over the UTF-8 bytes of `value`, returned as 64 lowercase hex chars.
 */
export function sha256Hex(value: string): string {
	return bytesToHex(sha256(utf8ToBytes(value)));
}

/**
 * Canonical JSON form: object keys sorted recursively (arrays preserve order,
 * undefined object properties omitted). Used to produce a stable hash input so
 * the same logical payload yields the same run id regardless of insertion order.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (value === null || typeof value !== 'object') {
		return value;
	}
	const input = value as Record<string, unknown>;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		const child = input[key];
		if (child !== undefined) {
			sorted[key] = canonicalize(child);
		}
	}
	return sorted;
}

/**
 * Deterministic legacy run id: `legacy-` + SHA-256 of the canonical JSON of the
 * raw legacy payload. The raw value is canonicalized as-is — before any
 * migration normalization — so a failed migration write produces the same id on
 * retry. The original `lastUpdated` is part of the hashed payload.
 */
export function legacyRunId(rawLegacyValue: unknown): string {
	return `legacy-${sha256Hex(canonicalJson(rawLegacyValue))}`;
}

/**
 * Factory for fresh canonical lowercase UUID v4 run ids. Uses `crypto.randomUUID`
 * when present, and otherwise formats 16 bytes from `crypto.getRandomValues`,
 * setting the version (4) and variant (8-b) nibbles. Never falls back to
 * `Math.random`. The optional crypto surface lets tests inject deterministic
 * bytes; production passes the global `crypto` (or omits it).
 */
export function createBrowserRunIdFactory(cryptoSource?: Crypto): RunIdFactory {
	const source =
		cryptoSource ??
		(typeof crypto !== 'undefined'
			? (globalThis as unknown as { crypto: Crypto }).crypto
			: undefined);
	if (source && typeof source.randomUUID === 'function') {
		return { create: () => source.randomUUID() };
	}
	return { create: () => fallbackUuidV4(source) };
}

function fallbackUuidV4(source: Crypto | undefined): string {
	const cryptoObj = source ?? (globalThis as unknown as { crypto: Crypto }).crypto;
	const bytes = new Uint8Array(16);
	cryptoObj.getRandomValues(bytes);
	// RFC 4122 v4: version nibble (byte 6 high) = 0100, variant (byte 8 high) = 10.
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytesToHex(bytes);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
