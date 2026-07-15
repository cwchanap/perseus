#!/usr/bin/env bun

/**
 * Bulk-upload startup puzzle images from scripts/startup-seed/.
 *
 * Production admin API is behind Cloudflare Access. For non-interactive CLI use,
 * Cloudflare's supported approach is Access **service tokens** (not browser cookies
 * or cloudflared access login):
 *
 *   https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
 *
 * After infra deploy provisions the CLI service token + Service Auth policy:
 *
 *   export CF_ACCESS_CLIENT_ID="$(cd packages/infrastructure && pulumi stack output adminCliAccessClientId)"
 *   export CF_ACCESS_CLIENT_SECRET="$(cd packages/infrastructure && pulumi stack output --show-secrets adminCliAccessClientSecret)"
 *   bun run admin:startup:upload -- --limit 5
 *
 * Or put CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET next to ADMIN_PASSKEY in apps/api/.env.
 *
 * This file is the entry point. Implementation lives in scripts/startup/ modules:
 *   types.ts   — shared types, constants, URL helpers
 *   token.ts   — Cloudflare Access token management
 *   catalog.ts — catalog validation, entry selection, image helpers
 *   upload.ts  — HTTP helpers, retry logic, cmdUpload
 *   cli.ts     — CLI parsing, commands (set-token/login/status), main
 *
 * Re-exports keep test imports (`from './admin-bulk-upload-startup'`) working
 * after the split.
 */

// Re-export so tests can import from this module without reaching into startup/.
export {
	FatalError,
	accessAppFor,
	adminUiFor,
	tokenBasenameFor,
	type CatalogEntry,
	type Options
} from './startup/types';
export { validateCatalog, selectEntries, imagePathFor, mimeForPath } from './startup/catalog';
export {
	fetchExistingKeys,
	idempotencyKey,
	retryConfig,
	uploadWithRetry,
	cmdUpload
} from './startup/upload';
export { aspectRatiosMatch, DEFAULT_PUZZLE_ASPECT_RATIO, MAX_PIECES } from '@perseus/types';
export { parseImageDimensions } from '@perseus/shared';

import { main } from './startup/cli';
import { FatalError } from './startup/types';

if (import.meta.main) {
	main().catch((error) => {
		if (error instanceof FatalError) {
			console.error(error.message);
			process.exit(error.exitCode);
		}
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
