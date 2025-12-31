import { describe, it, expect, beforeEach } from 'bun:test';
import { __getSharpForTests, __resetSharpFactoryForTests } from '../services/puzzle-generator';

describe('getSharp (lazy loader)', () => {
	beforeEach(() => {
		__resetSharpFactoryForTests();
	});

	it('resolves CommonJS-style module (module itself is the factory)', async () => {
		const factory = (() => undefined) as unknown as typeof import('sharp');
		const resolved = await __getSharpForTests(async () => factory);
		expect(resolved).toBe(factory);
	});

	it('resolves ESM-style module (default export is the factory)', async () => {
		const factory = (() => undefined) as unknown as typeof import('sharp');
		const resolved = await __getSharpForTests(async () => ({ default: factory }));
		expect(resolved).toBe(factory);
	});

	it('caches the resolved factory', async () => {
		const first = (() => undefined) as unknown as typeof import('sharp');
		const second = (() => undefined) as unknown as typeof import('sharp');

		let calls = 0;
		const loader1 = async () => {
			calls++;
			return { default: first };
		};
		const loader2 = async () => {
			calls++;
			return { default: second };
		};

		const resolved1 = await __getSharpForTests(loader1);
		const resolved2 = await __getSharpForTests(loader2);

		expect(resolved1).toBe(first);
		expect(resolved2).toBe(first);
		expect(calls).toBe(1);
	});

	it('throws a helpful error when sharp is unavailable', async () => {
		const loader = async () => {
			throw new Error('Cannot find module');
		};

		await expect(__getSharpForTests(loader)).rejects.toMatchObject({
			message: 'Image processing dependency "sharp" is not available'
		});
	});
});
