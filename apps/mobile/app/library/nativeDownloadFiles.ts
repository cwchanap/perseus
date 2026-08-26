import { File, Folder, Http, isIOS, path } from '@nativescript/core';
import type { AssetDownloader, DownloadFileOps, DownloadedAsset } from './downloadStore';

function imageExtension(contentType: string | undefined): DownloadedAsset['extension'] {
	switch (contentType?.split(';', 1)[0]?.trim().toLowerCase()) {
		case 'image/png':
			return '.png';
		case 'image/jpeg':
			return '.jpg';
		case 'image/webp':
			return '.webp';
		default:
			throw new Error('unsupported_download_image_type');
	}
}

function readContentType(headers: Record<string, string | string[]>): string | undefined {
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === 'content-type') {
			const value = headers[key]!;
			return Array.isArray(value) ? value[0] : value;
		}
	}
	return undefined;
}

export const downloadNativeAsset: AssetDownloader = async (url, destinationBasePath) => {
	const response = await Http.request({ url, method: 'GET' });
	if (response.statusCode === 404) return { kind: 'not_found' };
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(`download_http_${response.statusCode}`);
	}
	if (!response.content) throw new Error('download_empty_response');
	const extension = imageExtension(readContentType(response.headers));
	const file = response.content.toFile(destinationBasePath + extension);
	if (!file || file.size <= 0) throw new Error('download_empty_file');
	return { kind: 'downloaded', extension, bytes: file.size };
};

export function createNativeDownloadFileOps(): DownloadFileOps {
	return {
		join: (...parts) => path.join(...parts),

		async ensureDir(dirPath) {
			Folder.fromPath(dirPath);
		},

		async directoryExists(dirPath) {
			return Folder.exists(dirPath);
		},

		async removeDir(dirPath) {
			if (Folder.exists(dirPath)) Folder.fromPath(dirPath).removeSync();
		},

		async moveDir(fromPath, toPath) {
			if (!isIOS) throw new Error('download_directory_move_unsupported');

			const g = globalThis as any;
			const fm = g.NSFileManager.defaultManager;
			const fromUrl = g.NSURL.fileURLWithPath(fromPath);
			const toUrl = g.NSURL.fileURLWithPath(toPath);

			let moved = false;
			try {
				moved = Boolean(fm.moveItemAtURLToURLError(fromUrl, toUrl, null));
			} catch {
				moved = false;
			}
			if (!moved) {
				moved = Boolean(fm.moveItemAtPathToPathError(fromPath, toPath, null));
			}
			if (!moved || Folder.exists(fromPath) || !Folder.exists(toPath)) {
				throw new Error('download_directory_move_failed');
			}
		},

		async readText(filePath) {
			if (!File.exists(filePath)) return null;
			return File.fromPath(filePath).readTextSync();
		},

		async writeText(filePath, content) {
			File.fromPath(filePath).writeTextSync(content);
		},

		async listDirectories(dirPath) {
			if (!Folder.exists(dirPath)) return [];
			const entities = Folder.fromPath(dirPath).getEntitiesSync() ?? [];
			return entities.filter((entity) => Folder.exists(entity.path)).map((entity) => entity.path);
		},

		async fileSize(filePath) {
			if (!File.exists(filePath)) return null;
			return File.fromPath(filePath).size;
		}
	};
}
