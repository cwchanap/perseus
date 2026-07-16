/**
 * Catalog validation, entry selection, and image path helpers.
 *
 * validateCatalog performs structural + semantic validation upfront so the
 * CLI catches bad entries before wasting network round-trips. The semantic
 * checks (aspect ratio, piece count, category) mirror the server-side
 * validation in admin.ts / admin.worker.ts.
 */

import {
	isPuzzleAspectRatio,
	isValidPieceCountForAspectRatio,
	MAX_PIECES,
	PUZZLE_CATEGORIES,
	type PuzzleCategory
} from '@perseus/types';
import type { CatalogEntry, Options } from './types';

const CATALOG_ENTRY_KEYS: Record<keyof CatalogEntry, 'string' | 'number'> = {
	id: 'string',
	name: 'string',
	category: 'string',
	aspectRatio: 'string',
	pieceCount: 'number'
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
		for (const [key, expectedType] of Object.entries(CATALOG_ENTRY_KEYS)) {
			const value = (entry as Record<string, unknown>)[key];
			if (value === undefined || value === null) {
				throw new Error(`Catalog entry ${i} at ${source} is missing required field: ${key}`);
			}
			if (expectedType === 'string' && typeof value !== 'string') {
				throw new Error(`Catalog entry ${i} at ${source} field "${key}" must be a string`);
			}
			if (expectedType === 'number' && typeof value !== 'number') {
				throw new Error(`Catalog entry ${i} at ${source} field "${key}" must be a number`);
			}
			if (expectedType === 'string' && typeof value === 'string' && !value.trim()) {
				throw new Error(`Catalog entry ${i} at ${source} field "${key}" must not be blank`);
			}
			if (key === 'pieceCount' && typeof value === 'number' && !Number.isInteger(value)) {
				throw new Error(`Catalog entry ${i} at ${source} field "pieceCount" must be an integer`);
			}
			if (key === 'pieceCount' && typeof value === 'number' && value <= 0) {
				throw new Error(`Catalog entry ${i} at ${source} field "pieceCount" must be positive`);
			}
			// Match the server-side minimum: both API runtimes reject pieceCount < 4
			// (admin.worker.ts: pieceCount < 4; admin.ts: isValidPieceCount → count >= 4).
			// Rejecting upfront avoids a guaranteed 400 at upload time.
			if (key === 'pieceCount' && typeof value === 'number' && value > 0 && value < 4) {
				throw new Error(
					`Catalog entry ${i} at ${source} field "pieceCount" must be at least 4 (server minimum)`
				);
			}
		}
		const id = (entry as CatalogEntry).id;
		if (seenIds.has(id)) {
			throw new Error(`Catalog at ${source} has duplicate id: ${id}`);
		}
		seenIds.add(id);

		const trimmedName = (entry as CatalogEntry).name.trim();
		// Duplicate detection is case-insensitive after trimming: "Sunset"
		// and "sunset" would create indistinguishable catalog entries. The
		// comparison key is lowercased so mixed-case duplicates are caught,
		// while the error message preserves the original trimmed name.
		const nameKey = trimmedName.toLowerCase();
		if (seenNames.has(nameKey)) {
			throw new Error(`Catalog at ${source} has duplicate name: "${trimmedName}"`);
		}
		seenNames.add(nameKey);

		// Numeric id check: selectEntries parses ids as base-10 integers to
		// filter by --from/--to. A non-numeric id (e.g. "anime-01") parses to
		// NaN and is silently filtered out of every range. Reject upfront so
		// the operator sees the bad entry instead of a confusing "no entries
		// match" result. Zero-padded ids ("01") are fine — parseInt handles them.
		if (!/^\d+$/.test(id)) {
			throw new Error(
				`Catalog entry ${i} at ${source} has non-numeric id "${id}" — ids must be digits (e.g. "01", "70") so --from/--to range filtering works`
			);
		}

		// Semantic validation: catch invalid aspect ratios, piece counts, and
		// categories before uploading so the API doesn't reject each entry
		// one-by-one over the network.
		const { aspectRatio, pieceCount, category } = entry as CatalogEntry;
		if (!isPuzzleAspectRatio(aspectRatio)) {
			throw new Error(
				`Catalog entry ${i} at ${source} has invalid aspectRatio "${aspectRatio}" — must be one of 1:1, 4:3, 3:4`
			);
		}
		if (!isValidPieceCountForAspectRatio(pieceCount, aspectRatio)) {
			throw new Error(
				`Catalog entry ${i} at ${source} has pieceCount ${pieceCount} which is not valid for aspectRatio ${aspectRatio}`
			);
		}
		// Match the server-side ceiling: both API runtimes reject pieceCount
		// > MAX_PIECES (admin.worker.ts: pieceCount > MAX_PIECES; admin.ts:
		// isValidPieceCount → count <= MAX_PIECES). isValidPieceCountForAspectRatio
		// only checks grid divisibility, not the upper bound — so a valid grid
		// like 256 (16×16 for 1:1) would pass above but be rejected by the API
		// at upload time. Reject upfront to avoid a guaranteed 400.
		if (pieceCount > MAX_PIECES) {
			throw new Error(
				`Catalog entry ${i} at ${source} has pieceCount ${pieceCount} which exceeds the server maximum of ${MAX_PIECES}`
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
	// from=0 means "from the very beginning" (no lower bound) — matches the
	// 0-means-no-limit convention used by --to and --limit. In practice this
	// includes all entries since catalog ids are positive, but it's explicit
	// rather than relying on that coincidence.
	const from = options.from === 0 ? -Infinity : options.from;
	const to = options.to === 0 ? Infinity : options.to;
	const filtered = catalog.filter((e) => {
		const n = Number.parseInt(e.id, 10);
		return n >= from && n <= to;
	});
	// Sort by numeric id so --limit takes the lowest ids in the range, not
	// the first M entries in catalog order. Without this, a catalog that is
	// not in ascending id order would break the --from N --limit M batched
	// run pattern (e.g. --from 1 --limit 5 might skip id 1 and include id 70
	// if id 70 appears before id 1 in the JSON array).
	filtered.sort((a, b) => Number.parseInt(a.id, 10) - Number.parseInt(b.id, 10));
	if (options.limit !== undefined) return filtered.slice(0, options.limit);
	return filtered;
}

const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp)$/i;

export function imagePathFor(entry: CatalogEntry, imagesDir: string): string | null {
	// Match either `{id}-*.{ext}` (e.g. 01-alpine-lake.jpg) or `{id}.{ext}` (e.g. 01.jpg).
	// Scan with a permissive `.*` extension then filter case-insensitively so that
	// mixed-case assets (e.g. 02.JpG, 04.PnG) — which pass the workflow's
	// `find -iname` preflight — are matched here too. A brace pattern enumerating
	// only lowercase + all-uppercase variants would miss mixed-case extensions.
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
