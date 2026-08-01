import type { Plugin } from 'vite';

const virtualId = 'virtual:perseus-gameplay-runtime-override';
const resolvedVirtualId = `\0${virtualId}`;

// Normal-build module body: a no-op override reader that always yields null,
// so the production runtime supplies its own gameplay dependencies.
const noopModule = `export function readGameplayRuntimeOverride(_context) {
	return null;
}
`;

/**
 * Build-time Vite plugin that materializes the
 * `virtual:perseus-gameplay-runtime-override` module.
 *
 * Outside the harness build it emits an inline no-op reader (returns null). In
 * the harness build it re-exports the reader from `readerPath`, which Task 2
 * supplies. The harness flag is captured when the Vite config is created; an
 * already-running Vitest process will not switch modes after env mutation.
 */
export function gameplayRuntimeOverridePlugin(options?: {
	harnessEnabled?: boolean;
	readerPath?: string;
}): Plugin {
	const harnessEnabled = options?.harnessEnabled ?? false;
	const readerPath = options?.readerPath;

	return {
		name: 'perseus:gameplay-runtime-override',
		enforce: 'pre',
		resolveId(id) {
			if (id === virtualId) {
				return resolvedVirtualId;
			}
			return null;
		},
		load(id) {
			if (id !== resolvedVirtualId) {
				return null;
			}
			if (harnessEnabled) {
				if (!readerPath) {
					throw new Error(
						'gameplayRuntimeOverridePlugin: readerPath is required when harnessEnabled is true'
					);
				}
				return `export { readGameplayRuntimeOverride } from ${JSON.stringify(readerPath)};\n`;
			}
			return noopModule;
		}
	};
}
