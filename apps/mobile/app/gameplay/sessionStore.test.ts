import { describe, expect, it } from 'vitest';
import { createFileSessionKeyValueStore, type SessionFileOps } from './sessionStore';

function fakeFileOps(operations: string[] = []): SessionFileOps {
	return {
		readText: () => null,
		writeText: (path, content) => operations.push(`write:${path}:${content}`),
		replace: (fromPath, toPath) => operations.push(`replace:${fromPath}->${toPath}`),
		remove: (path) => operations.push(`remove:${path}`)
	};
}

describe('createFileSessionKeyValueStore', () => {
	it('returns null when the canonical session file is missing', () => {
		const store = createFileSessionKeyValueStore({
			rootPath: '/sessions',
			fileOps: fakeFileOps()
		});
		expect(store.getItem('p1')).toBeNull();
	});

	it('writes a complete temp file before replacing the canonical file', () => {
		const operations: string[] = [];
		const store = createFileSessionKeyValueStore({
			rootPath: '/sessions',
			fileOps: fakeFileOps(operations)
		});

		store.setItem('p1', '{"ok":true}');

		expect(operations).toEqual([
			'write:/sessions/p1.json.tmp:{"ok":true}',
			'replace:/sessions/p1.json.tmp->/sessions/p1.json'
		]);
	});
});
