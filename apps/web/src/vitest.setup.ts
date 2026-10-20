import { beforeEach, vi } from 'vitest';

// kit 3's generated dev env module destructures globalThis.__sveltekit_dev at
// import time; vitest doesn't start kit's dev server. Export values are baked
// from .env.test at sync time, so an empty env object suffices.
(
	globalThis as { __sveltekit_dev?: { env: Record<string, string | undefined> } }
).__sveltekit_dev ??= { env: {} };

beforeEach(() => {
	vi.resetModules();
});
