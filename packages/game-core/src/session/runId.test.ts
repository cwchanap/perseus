// UUID v4 run-id formatting tests that inject an explicit crypto source,
// moved from web persistence.test.ts. Browser global crypto resolution and
// the crypto-unavailable branch stay web-local.
import { describe, it, expect } from 'vitest';
import { createRunIdFactory, type RunIdCrypto } from './runId';
import { isPuzzleRunId } from '@perseus/types';

function makeDeterministicCrypto(bytes: number[]): RunIdCrypto {
	let call = 0;
	return {
		getRandomValues: (arr: Uint8Array): Uint8Array => {
			if (call > 0) throw new Error('unexpected second getRandomValues call');
			call++;
			for (let i = 0; i < arr.length; i++) {
				arr[i] = bytes[i] ?? 0;
			}
			return arr;
		}
	};
}

describe('createRunIdFactory', () => {
	it('formats 16 zero bytes as the canonical nil-ish v4 uuid', () => {
		const factory = createRunIdFactory(makeDeterministicCrypto(new Array(16).fill(0)));
		expect(factory.create()).toBe('00000000-0000-4000-8000-000000000000');
	});

	it('sets the version nibble to 4 and the variant nibble to 8-b', () => {
		const factory = createRunIdFactory(makeDeterministicCrypto(new Array(16).fill(0xff)));
		const id = factory.create();

		expect(isPuzzleRunId(id)).toBe(true);
		const parts = id.split('-');
		expect(parts[2][0]).toBe('4');
		expect('89ab').toContain(parts[3][0]);
	});

	it('passes deterministic bytes straight through (never uses Math.random)', () => {
		const bytes = [
			0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88
		];
		const factory = createRunIdFactory(makeDeterministicCrypto(bytes));
		// byte6: 0xde -> (0xde & 0x0f) | 0x40 = 0x4e; byte8: 0x11 -> (0x11 & 0x3f) | 0x80 = 0x91
		expect(factory.create()).toBe('12345678-9abc-4ef0-9122-334455667788');
	});

	it('lowercase output is accepted by isPuzzleRunId', () => {
		const factory = createRunIdFactory(makeDeterministicCrypto(new Array(16).fill(0xab)));
		const id = factory.create();

		expect(id).toBe(id.toLowerCase());
		expect(isPuzzleRunId(id)).toBe(true);
	});

	it('works when crypto.subtle is absent', () => {
		const crypto = makeDeterministicCrypto(new Array(16).fill(0));
		expect((crypto as unknown as { subtle?: unknown }).subtle).toBeUndefined();
		const factory = createRunIdFactory(crypto);

		expect(isPuzzleRunId(factory.create())).toBe(true);
	});

	it('uses the getRandomValues fallback path when the source lacks randomUUID', () => {
		const source: RunIdCrypto = {
			getRandomValues: (arr: Uint8Array): Uint8Array => {
				arr.fill(0);
				return arr;
			}
		};
		const factory = createRunIdFactory(source);
		expect(isPuzzleRunId(factory.create())).toBe(true);
	});

	it('lowercases an id provided by randomUUID', () => {
		const source: RunIdCrypto = {
			randomUUID: () => 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
			getRandomValues: (): Uint8Array => {
				throw new Error('must not be called');
			}
		};
		expect(createRunIdFactory(source).create()).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
	});
});
