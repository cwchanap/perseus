import { test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { format } from 'prettier';

test('print formatted analytics context implementation', async () => {
	const source = await readFile('apps/web/src/lib/services/analytics/context.ts', 'utf8');
	const formatted = await format(source, {
		parser: 'typescript',
		useTabs: true,
		singleQuote: true,
		trailingComma: 'none',
		printWidth: 100
	});
	throw new Error(`FORMATTED_CONTEXT_IMPL_START\n${formatted}FORMATTED_CONTEXT_IMPL_END`);
});
