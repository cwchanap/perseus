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
});
