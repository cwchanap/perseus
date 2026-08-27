/**
 * Catalog validation, entry selection, and image path helpers.
 */

import { isPuzzleAspectRatio, PUZZLE_CATEGORIES, type PuzzleCategory } from '@perseus/types';
import type { CatalogEntry, Options } from './types';

const CATALOG_ENTRY_KEYS: Record<keyof CatalogEntry, 'string'> = {
	id: 'string',
	name: 'string',
	category: 'string',
	aspectRatio: 'string'
};

export function validateCatalog(raw: unknown, source: string): CatalogEntry[] {
	if (!Array.isArray(raw)) {
		throw new Error(`Catalog at ${source} must be a JSON array`);
	}
	if (raw.length === 0) {
		throw new Error(`Catalog at ${source} is empty`);
	}
	const seenIds = new Set<string>();
	const seenNames = new Set<string>();
	for (let i = 0; i < raw.length; i++) {
		const entry = raw[i];
		if (typeof entry !== 'object' || entry === null) {
			throw new Error(`Catalog entry ${i} at ${source} must be an object`);
		}
		if ('pieceCount' in entry) {
			throw new Error(
				`Catalog entry ${i} at ${source} must not include pieceCount; families generate Easy, Normal, and Hard variants`
			);
		}
		for (const [key, expectedType] of Object.entries(CATALOG_ENTRY_KEYS)) {
			const value = (entry as Record<string, unknown>)[key];
			if (value === undefined || value === null) {
				throw new Error(`Catalog entry ${i} at ${source} is missing required field: ${key}`);
			}
			if (expectedType === 'string' && typeof value !== 'string') {
				throw new Error(`Catalog entry ${i} at ${source} field "${key}" must be a string`);
			}
			if (expectedType === 'string' && typeof value === 'string' && !value.trim()) {
				throw new Error(`Catalog entry ${i} at ${source} field "${key}" must not be blank`);
			}
			if (expectedType === 'string' && typeof value === 'string' && /\p{Cc}/u.test(value)) {
				throw new Error(
					`Catalog entry ${i} at ${source} field "${key}" contains a control character (\\p{Cc}); remove it before uploading`
				);
			}
		}
		const id = (entry as CatalogEntry).id;
		if (seenIds.has(id)) {
			throw new Error(`Catalog at ${source} has duplicate id: ${id}`);
		}
		seenIds.add(id);

		const trimmedName = (entry as CatalogEntry).name.trim();
		const nameKey = trimmedName.toLowerCase();
		if (seenNames.has(nameKey)) {
			throw new Error(`Catalog at ${source} has duplicate name: "${trimmedName}"`);
		}
		seenNames.add(nameKey);

		if (!/^\d+$/.test(id)) {
			throw new Error(
				`Catalog entry ${i} at ${source} has non-numeric id "${id}" — ids must be digits (e.g. "01", "70") so --from/--to range filtering works`
			);
		}

		const { aspectRatio, category } = entry as CatalogEntry;
		if (!isPuzzleAspectRatio(aspectRatio)) {
			throw new Error(
				`Catalog entry ${i} at ${source} has invalid aspectRatio "${aspectRatio}" — must be one of 1:1, 4:3, 3:4`
			);
		}
		if (!PUZZLE_CATEGORIES.includes(category as PuzzleCategory)) {
			throw new Error(
				`Catalog entry ${i} at ${source} has category "${category}" — must be one of: ${PUZZLE_CATEGORIES.join(', ')}`
			);
		}
	}
	return raw as CatalogEntry[];
}

export function selectEntries(catalog: CatalogEntry[], options: Options): CatalogEntry[] {
	const from = options.from === 0 ? -Infinity : options.from;
	const to = options.to === 0 ? Infinity : options.to;
	const filtered = catalog.filter((e) => {
		const n = Number.parseInt(e.id, 10);
		return n >= from && n <= to;
	});
	filtered.sort((a, b) => Number.parseInt(a.id, 10) - Number.parseInt(b.id, 10));
	if (options.limit !== undefined) return filtered.slice(0, options.limit);
	return filtered;
}

const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp)$/i;

export function imagePathFor(entry: CatalogEntry, imagesDir: string): string | null {
	const glob = new Bun.Glob(`${entry.id}{,-*}.*`);
	const matches = [...glob.scanSync({ cwd: imagesDir, absolute: true })]
		.filter((p) => IMAGE_EXT_RE.test(p))
		.sort();
	return matches[0] ?? null;
}

const MIME_BY_EXT: Record<string, string> = {
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp'
};

export function mimeForPath(path: string): string {
	const ext = path.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
	return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
