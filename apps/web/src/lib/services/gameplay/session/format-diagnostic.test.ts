import { describe, expect, it } from 'vitest';
import { format } from 'prettier/standalone';
import * as estreePlugin from 'prettier/plugins/estree';
import * as typescriptPlugin from 'prettier/plugins/typescript';
import persistenceSource from './persistence.validation.test.ts?raw';
import sessionEdgeSource from './session.edge.test.ts?raw';

function base64(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function logChunks(label: string, value: string): void {
	const encoded = base64(value);
	for (let offset = 0; offset < encoded.length; offset += 3_000) {
		const index = String(offset / 3_000).padStart(3, '0');
		console.log(`FORMAT_CHUNK:${label}:${index}:${encoded.slice(offset, offset + 3_000)}`);
	}
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
	it('prints repository-formatted test sources', async () => {
		const persistence = await format(persistenceSource, options);
		const sessionEdge = await format(sessionEdgeSource, options);

		logChunks('persistence', persistence);
		logChunks('session-edge', sessionEdge);

		expect(persistence).not.toBe(persistenceSource);
		expect(sessionEdge.length).toBeGreaterThan(0);
	});
});
