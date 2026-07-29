import { describe, expect, it } from 'vitest';
import { format } from 'prettier/standalone';
import * as estreePlugin from 'prettier/plugins/estree';
import * as typescriptPlugin from 'prettier/plugins/typescript';
import persistenceSource from './persistence.validation.test.ts?raw';

interface Patch {
	start: number;
	deleteCount: number;
	lines: string[];
}

function base64(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function logChunks(value: string): void {
	const encoded = base64(value);
	for (let offset = 0; offset < encoded.length; offset += 3_000) {
		const index = String(offset / 3_000).padStart(3, '0');
		console.log(`PATCH_CHUNK:${index}:${encoded.slice(offset, offset + 3_000)}`);
	}
}

function createPatch(original: string, formatted: string): Patch[] {
	const before = original.split('\n');
	const after = formatted.split('\n');
	const common = Array.from(
		{ length: before.length + 1 },
		() => new Uint16Array(after.length + 1)
	);

	for (let i = before.length - 1; i >= 0; i--) {
		for (let j = after.length - 1; j >= 0; j--) {
			common[i][j] =
				before[i] === after[j]
					? common[i + 1][j + 1] + 1
					: Math.max(common[i + 1][j], common[i][j + 1]);
		}
	}

	const patches: Patch[] = [];
	let i = 0;
	let j = 0;
	while (i < before.length || j < after.length) {
		if (i < before.length && j < after.length && before[i] === after[j]) {
			i++;
			j++;
			continue;
		}

		const patch: Patch = { start: i, deleteCount: 0, lines: [] };
		while (
			(i < before.length || j < after.length) &&
			!(i < before.length && j < after.length && before[i] === after[j])
		) {
			if (
				i < before.length &&
				(j >= after.length || common[i + 1][j] >= common[i][j + 1])
			) {
				patch.deleteCount++;
				i++;
			} else {
				patch.lines.push(after[j]);
				j++;
			}
		}
		patches.push(patch);
	}
	return patches;
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
	it('prints repository formatting edits', async () => {
		const formatted = await format(persistenceSource, options);
		const patches = createPatch(persistenceSource, formatted);

		logChunks(JSON.stringify(patches));

		expect(patches.length).toBeGreaterThan(0);
	});
});
