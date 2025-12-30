import { beforeEach } from 'vitest';

beforeEach(() => {
	import('vitest').then(({ vi }) => vi.resetModules());
});
