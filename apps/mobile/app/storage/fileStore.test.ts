import { describe, expect, it } from 'vitest';
import { createFileKeyValueStore, type FileOps } from './fileStore';

function fakeFileOps(operations: string[] = []): FileOps {
	const directories = new Map<string, Set<string>>();
	const addFile = (path: string) => {
		const dir = path.slice(0, path.lastIndexOf('/'));
		if (!directories.has(dir)) directories.set(dir, new Set());
		directories.get(dir)!.add(path.slice(path.lastIndexOf('/') + 1));
	};
	return {
		readText: () => null,
		writeText: (path, content) => {
			operations.push(`write:${path}:${content}`);
			addFile(path);
		},
		replace: (fromPath, toPath) => operations.push(`replace:${fromPath}->${toPath}`),
		remove: (path) => operations.push(`remove:${path}`),
		list: (rootPath) => Array.from(directories.get(rootPath) ?? []).sort()
	};
}

describe('createFileKeyValueStore', () => {
	it('returns null when the canonical session file is missing', () => {
		const store = createFileKeyValueStore({
			rootPath: '/sessions',
			fileOps: fakeFileOps()
		});
		expect(store.getItem('p1')).toBeNull();
	});

	it('writes a complete temp file before replacing the canonical file', () => {
		const operations: string[] = [];
		const store = createFileKeyValueStore({
			rootPath: '/sessions',
			fileOps: fakeFileOps(operations)
		});

		store.setItem('p1', '{"ok":true}');

		expect(operations).toEqual([
			'write:/sessions/p1.json.tmp:{"ok":true}',
			'replace:/sessions/p1.json.tmp->/sessions/p1.json'
		]);
	});

	it('lists direct file names in the root only', () => {
		const operations: string[] = [];
		const fileOps = fakeFileOps(operations);
		fileOps.writeText('/completions/run-b.json', '{}');
		fileOps.writeText('/completions/run-a.json', '{}');
		fileOps.writeText('/completions/nested/deep.json', '{}');
		fileOps.writeText('/other/run-c.json', '{}');

		expect(fileOps.list('/completions')).toEqual(['run-a.json', 'run-b.json']);
		expect(fileOps.list('/missing')).toEqual([]);
	});
});
