// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	// Set by vite.config.ts `define`: true only in PERSEUS_E2E_HARNESS=1 builds.
	const __PERSEUS_E2E_HARNESS__: boolean;

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
