import { describe, expect, it } from 'vitest';
import { format } from 'prettier/standalone';
import * as estreePlugin from 'prettier/plugins/estree';
import * as typescriptPlugin from 'prettier/plugins/typescript';
import persistenceSource from './persistence.validation.test.ts?raw';
import sessionEdgeSource from './session.edge.test.ts?raw';

interface DiffLine {
	kind: 'add' | 'remove';
	line: string;
}

function diffLines(original: string, formatted: string): DiffLine[] {
	const left = original.split('\n');
	const right = formatted.split('\n');
	const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));

	for (let i = left.length - 1; i >= 0; i--) {
		for (let j = right.length - 1; j >= 0; j--) {
			table[i][j] =
				left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}

	const changes: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < left.length || j < right.length) {
		if (i < left.length && j < right.length && left[i] === right[j]) {
			i++;
			j++;
		} else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) {
			changes.push({ kind: 'add', line: right[j++] });
		} else {
			changes.push({ kind: 'remove', line: left[i++] });
		}
	}
	return changes;
}

const options = {
	parser: 'typescript',
	plugins: [typescriptPlugin, estreePlugin],
	useTabs: true,
	singleQuote: true,
	trailingComma: 'none' as const,
	printWidth: 100
};

describe('temporary formatter diagnostic', () => {
	it('prints repository formatting differences', async () => {
		const persistence = await format(persistenceSource, options);
		const sessionEdge = await format(sessionEdgeSource, options);

		console.log(`FORMAT_DIFF:persistence:${JSON.stringify(diffLines(persistenceSource, persistence))}`);
		console.log(`FORMAT_DIFF:session-edge:${JSON.stringify(diffLines(sessionEdgeSource, sessionEdge))}`);

		expect(persistence).not.toBe(persistenceSource);
		expect(sessionEdge).toBe(sessionEdgeSource);
	});
});
