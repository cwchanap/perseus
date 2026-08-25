import { File } from '@nativescript/core';
import type { SessionFileOps } from './sessionStore';

function fileName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

function atomicReplace(fromPath: string, toPath: string): void {
	if (!File.exists(toPath)) {
		File.fromPath(fromPath).renameSync(fileName(toPath));
		return;
	}

	const fm = (globalThis as any).NSFileManager.defaultManager;
	const replaced = fm.replaceItemAtURLWithItemAtURLBackupItemNameOptionsResultingItemURLError(
		(globalThis as any).NSURL.fileURLWithPath(toPath),
		(globalThis as any).NSURL.fileURLWithPath(fromPath),
		null,
		0,
		null,
		null
	);
	if (!replaced || File.exists(fromPath)) {
		throw new Error('session_file_replace_failed');
	}
}

export function createNativeSessionFileOps(): SessionFileOps {
	return {
		readText(path) {
			if (!File.exists(path)) return null;
			return File.fromPath(path).readTextSync();
		},
		writeText(path, content) {
			File.fromPath(path).writeTextSync(content);
		},
		replace: atomicReplace,
		remove(path) {
			if (File.exists(path)) File.fromPath(path).removeSync();
		}
	};
}
