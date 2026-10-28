import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const appHtml = readFileSync(join(import.meta.dir, '../src/app.html'), 'utf8');

describe('app shell (app.html)', () => {
	it('sets theme-color to the dark shell background unconditionally', () => {
		const metas = appHtml.match(/<meta\s+name="theme-color"[^>]*>/g) ?? [];
		expect(metas).toHaveLength(1);
		expect(metas[0]).toContain('content="#0a0620"');
	});
});
