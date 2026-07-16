/**
 * Shared types, constants, and URL helpers for the startup seed upload CLI.
 *
 * Extracted from admin-bulk-upload-startup.ts so each concern (token mgmt,
 * catalog validation, upload, CLI) can live in its own module without a
 * circular dependency on the 1000-line entry file.
 */

import { MAX_FILE_SIZE } from '@perseus/types';

// Deployment-specific defaults. Override via env vars for non-default deployments:
//   PERSEUS_SERVER  — API base URL (default: https://perseus.cwchanap.dev)
//   CF_ACCESS_AUD   — Cloudflare Access application AUD (deployment-specific)
//
// These are `let` (not `const`) so applyDotenvOverrides can update them from
// apps/api/.env after the CLI loads the dotenv map. Module-level `const`
// initialization reads process.env at import time — before cli.ts loads the
// dotenv file — so a non-default deployment putting PERSEUS_SERVER or
// CF_ACCESS_AUD in apps/api/.env (but not in the shell environment) would
// silently use the hardcoded defaults and target the wrong environment.
export let DEFAULT_SERVER = process.env.PERSEUS_SERVER ?? 'https://perseus.cwchanap.dev';
export let ACCESS_AUD =
	process.env.CF_ACCESS_AUD ?? '7fd50c02b28c32fe3abb938cebba2dc9dcec6c88f42969c28700e9a0a8a28e5f';

/**
 * Apply dotenv deployment overrides after the CLI loads apps/api/.env.
 * Values in the dotenv map take priority over the process.env-derived
 * defaults (which were captured at module import time, before the dotenv
 * file was read). Call this once after loadDotEnvMap, before any code that
 * reads DEFAULT_SERVER or ACCESS_AUD (e.g. cloudflaredTokenPath).
 */
export function applyDotenvOverrides(dotenv: Record<string, string>): void {
	if (dotenv.PERSEUS_SERVER) DEFAULT_SERVER = dotenv.PERSEUS_SERVER;
	if (dotenv.CF_ACCESS_AUD) ACCESS_AUD = dotenv.CF_ACCESS_AUD;
}

export const FETCH_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 120_000;
export const PROBE_TIMEOUT_MS = 15_000;

// Re-exported from @perseus/types so the CLI and server share the same value
// without drift. Checked client-side so oversized images are rejected before
// wasting bandwidth on a doomed upload.
export { MAX_FILE_SIZE };

export function warnHardcodedDefaults(dotenv: Record<string, string> = {}): void {
	if (!process.env.PERSEUS_SERVER && !dotenv.PERSEUS_SERVER) {
		console.warn(
			`[warn] PERSEUS_SERVER not set — using hardcoded default ${DEFAULT_SERVER}. ` +
				'Set PERSEUS_SERVER to override for non-default deployments.'
		);
	}
	// The AUD is only needed for the JWT/cloudflared token path. CI uses
	// service tokens (CF-Access-Client-Id/Secret), which don't need the AUD,
	// so the warning is noise in CI logs. Suppress when CI=true is set
	// (GitHub Actions and most other CI systems set this).
	if (!process.env.CF_ACCESS_AUD && !dotenv.CF_ACCESS_AUD && !process.env.CI) {
		console.warn(
			'[warn] CF_ACCESS_AUD not set — using hardcoded default AUD. ' +
				'Set CF_ACCESS_AUD to override for non-default deployments.'
		);
	}
}

/**
 * Thrown by command functions instead of calling process.exit() directly, so
 * tests can assert on the failure via expect().rejects without monkey-patching
 * process.exit. main() catches FatalError and translates it to process.exit.
 */
export class FatalError extends Error {
	readonly exitCode: number;
	constructor(message: string, exitCode = 1) {
		super(message);
		this.name = 'FatalError';
		this.exitCode = exitCode;
	}
}

/** Derive the Cloudflare Access app URL from the server (used by cloudflared token flow). */
export function accessAppFor(server: string): string {
	return `${server.replace(/\/+$/, '')}/api/admin`;
}

/** Derive the admin UI URL from the server (used by the interactive set-token prompt). */
export function adminUiFor(server: string): string {
	return `${server.replace(/\/+$/, '')}/admin`;
}

/** Derive the cloudflared token cache basename from hostname + AUD. */
export function tokenBasenameFor(server: string, aud: string): string {
	const hostname = (() => {
		try {
			return new URL(server).hostname;
		} catch {
			return server.replace(/^https?:\/\//, '').split('/')[0] ?? server;
		}
	})();
	return `${hostname}-${aud}-token`;
}

export interface CatalogEntry {
	id: string;
	name: string;
	category: string;
	aspectRatio: string;
	pieceCount: number;
}

/**
 * The subset of Options that accessHeaders / hasAccessCredentials need.
 * Extracted so the single-puzzle uploader (admin-upload-puzzle.ts) can share
 * the Access helpers without constructing a full startup Options object.
 */
export interface AccessCredentials {
	skipAccess: boolean;
	cfAccessToken?: string;
	cfClientId?: string;
	cfClientSecret?: string;
}

export interface Options extends AccessCredentials {
	command: 'login' | 'set-token' | 'upload' | 'status';
	server: string;
	passkey: string;
	catalogPath: string;
	imagesDir: string;
	tokenCachePath: string;
	dryRun: boolean;
	from: number;
	to: number;
	limit?: number;
	delayMs: number;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
