import type { SessionKeyValueStore } from '@perseus/game-core';

export interface SessionFileOps {
	readText(path: string): string | null;
	writeText(path: string, content: string): void;
	replace(fromPath: string, toPath: string): void;
	remove(path: string): void;
}

function joinPath(rootPath: string, fileName: string): string {
	return rootPath ? `${rootPath.replace(/\/+$/, '')}/${fileName}` : fileName;
}

export function createFileSessionKeyValueStore(options: {
	rootPath: string;
	fileOps: SessionFileOps;
}): SessionKeyValueStore {
	const canonical = (id: string) => joinPath(options.rootPath, `${id}.json`);

	return {
		getItem(id) {
			return options.fileOps.readText(canonical(id));
		},
		setItem(id, value) {
			const target = canonical(id);
			const temp = `${target}.tmp`;
			options.fileOps.writeText(temp, value);
			options.fileOps.replace(temp, target);
		},
		removeItem(id) {
			options.fileOps.remove(canonical(id));
		}
	};
}
