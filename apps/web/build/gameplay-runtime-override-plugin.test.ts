import { describe, expect, it } from 'bun:test';
import { gameplayRuntimeOverridePlugin } from './gameplay-runtime-override-plugin';

describe('gameplayRuntimeOverridePlugin', () => {
	it('resolves only the exact virtual id', async () => {
		const plugin = gameplayRuntimeOverridePlugin({ harnessEnabled: false });
		expect(
			await plugin.resolveId?.call({} as never, 'virtual:perseus-gameplay-runtime-override')
		).toBe('\0virtual:perseus-gameplay-runtime-override');
		expect(await plugin.resolveId?.call({} as never, './runtime-override')).toBeNull();
	});

	it('emits a no-op module outside the harness build', async () => {
		const plugin = gameplayRuntimeOverridePlugin({ harnessEnabled: false });
		const code = await plugin.load?.call(
			{} as never,
			'\0virtual:perseus-gameplay-runtime-override'
		);
		expect(String(code)).toContain('return null');
		expect(String(code)).not.toContain('e2e-gameplay-runtime');
	});

	it('re-exports the reader from readerPath in harness mode', async () => {
		const plugin = gameplayRuntimeOverridePlugin({
			harnessEnabled: true,
			readerPath: '/src/lib/testing/e2e-gameplay-runtime'
		});
		const code = await plugin.load?.call(
			{} as never,
			'\0virtual:perseus-gameplay-runtime-override'
		);
		expect(String(code)).toContain('readGameplayRuntimeOverride');
		expect(String(code)).toContain('"/src/lib/testing/e2e-gameplay-runtime"');
		// Harness output must not carry an inline fallback that would mask a
		// missing/misconfigured reader with a silent null.
		expect(String(code)).not.toContain('return null');
	});

	it('throws when harnessEnabled but readerPath is omitted', () => {
		const plugin = gameplayRuntimeOverridePlugin({ harnessEnabled: true });
		expect(() =>
			plugin.load?.call({} as never, '\0virtual:perseus-gameplay-runtime-override')
		).toThrow();
	});
});
