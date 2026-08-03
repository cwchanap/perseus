import { test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { format } from 'prettier';

test('print formatted analytics ledger test', async () => {
	const source = await readFile(
		'apps/web/src/lib/services/analytics/run-ledger.test.ts',
		'utf8'
	);
	const formatted = await format(source, {
		parser: 'typescript',
		useTabs: true,
		singleQuote: true,
		trailingComma: 'none',
		printWidth: 100
	});
	throw new Error(`FORMATTED_LEDGER_TEST_START\n${formatted}FORMATTED_LEDGER_TEST_END`);
});
