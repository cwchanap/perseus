import { describe, expect, it } from 'bun:test';
import { gameplayRuntimeOverridePlugin } from './gameplay-runtime-override-plugin';

/**
 * Vite's Plugin type declares resolveId/load as ObjectHook unions — either the
 * hook function itself or a `{ handler, order? }` object. The plugin's hooks
 * are plain functions; narrow the union to the callable form so the tests can
 * invoke them directly.
 */
function callableHook<T>(hook: T | { handler: T } | undefined): T | undefined {
	if (typeof hook === 'function') return hook;
	if (hook !== null && typeof hook === 'object' && 'handler' in hook) return hook.handler;
	return undefined;
}

describe('gameplayRuntimeOverridePlugin', () => {
	it('resolves only the exact virtual id', async () => {
		const plugin = gameplayRuntimeOverridePlugin({ harnessEnabled: false });
		const resolveId = callableHook(plugin.resolveId)!;
		// The hook signature is (source, importer, options); the plugin only
		// reads `source`, so the remaining arguments are placeholders.
		const invoke = (id: string) =>
			resolveId.call({} as never, id, undefined, { attributes: {}, isEntry: false });
		expect(await invoke('virtual:perseus-gameplay-runtime-override')).toBe(
			'\0virtual:perseus-gameplay-runtime-override'
		);
		expect(await invoke('./runtime-override')).toBeNull();
	});

	it('emits a no-op module outside the harness build', async () => {
		const plugin = gameplayRuntimeOverridePlugin({ harnessEnabled: false });
		const load = callableHook(plugin.load);
		const code = await load?.call({} as never, '\0virtual:perseus-gameplay-runtime-override');
		expect(String(code)).toContain('return null');
		expect(String(code)).not.toContain('e2e-gameplay-runtime');
	});

	it('re-exports the reader from readerPath in harness mode', async () => {
		const plugin = gameplayRuntimeOverridePlugin({
			harnessEnabled: true,
			readerPath: '/src/lib/testing/e2e-gameplay-runtime'
		});
		const load = callableHook(plugin.load);
		const code = await load?.call({} as never, '\0virtual:perseus-gameplay-runtime-override');
		expect(String(code)).toContain('readGameplayRuntimeOverride');
		expect(String(code)).toContain('"/src/lib/testing/e2e-gameplay-runtime"');
		// Harness output must not carry an inline fallback that would mask a
		// missing/misconfigured reader with a silent null.
		expect(String(code)).not.toContain('return null');
	});

	it('throws when harnessEnabled but readerPath is omitted', () => {
		const plugin = gameplayRuntimeOverridePlugin({ harnessEnabled: true });
		const load = callableHook(plugin.load);
		expect(() => load?.call({} as never, '\0virtual:perseus-gameplay-runtime-override')).toThrow();
	});
});
