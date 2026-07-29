import { describe, expect, it } from 'vitest';
import { format } from 'prettier/standalone';
import * as estreePlugin from 'prettier/plugins/estree';
import * as typescriptPlugin from 'prettier/plugins/typescript';
import source from './persistence.validation-completion.test.ts?raw';

const options = {
	parser: 'typescript',
	plugins: [typescriptPlugin, estreePlugin],
	useTabs: true,
	singleQuote: true,
	trailingComma: 'none' as const,
	printWidth: 100
};

describe('temporary completion formatter diagnostic', () => {
	it('prints formatted completion coverage', async () => {
		const formatted = await format(source, options);
		const encoded = btoa(formatted);
		for (let offset = 0; offset < encoded.length; offset += 3_000) {
			console.log(`COMPLETION_FORMAT:${offset / 3_000}:${encoded.slice(offset, offset + 3_000)}`);
		}
		expect(formatted).not.toBe(source);
	});
});
