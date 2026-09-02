// Single-flight drain scheduling with a trailing-edge requeue. Overlapping
// triggers share the in-flight pass and queue at most one follow-up pass, so
// a completion or reconnect arriving after the pass's pending snapshot is
// drained by a follow-up instead of waiting for an unrelated later trigger.
// Pure scheduling — no NativeScript imports; the pass and the epoch source
// are injected so the caller can guard stale results (see App.svelte).

export interface DrainScheduler {
	/** Trigger a validate+drain pass; overlapping triggers share the pass. */
	trigger(): Promise<void>;
}

export function createDrainScheduler(options: {
	startPass: (epoch: number) => Promise<void>;
	currentEpoch: () => number;
	onError: (error: unknown) => void;
}): DrainScheduler {
	let drainPass: Promise<void> | null = null;
	let drainQueued = false;

	function trigger(): Promise<void> {
		if (drainPass !== null) {
			// A pass is running; remember one follow-up so post-snapshot
			// arrivals still drain. The flag never stacks.
			drainQueued = true;
			return drainPass;
		}
		drainPass = options
			.startPass(options.currentEpoch())
			.catch((error) => {
				// A failed pass never crashes the app; records stay pending for
				// the next trigger.
				options.onError(error);
			})
			.finally(() => {
				drainPass = null;
				if (drainQueued) {
					drainQueued = false;
					void trigger();
				}
			});
		return drainPass;
	}

	return { trigger };
}
