declare module 'virtual:perseus-gameplay-runtime-override' {
	import type {
		GameplayRuntimeDependencies,
		GameplayRuntimeOverrideContext
	} from '$lib/services/gameplay/runtime.types';

	export function readGameplayRuntimeOverride(
		context: GameplayRuntimeOverrideContext
	): GameplayRuntimeDependencies | null;
}
