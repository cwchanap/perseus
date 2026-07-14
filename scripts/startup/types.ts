/**
 * Shared types, constants, and URL helpers for the startup seed upload CLI.
 *
 * Extracted from admin-bulk-upload-startup.ts so each concern (token mgmt,
 * catalog validation, upload, CLI) can live in its own module without a
 * circular dependency on the 1000-line entry file.
 */

// Deployment-specific defaults. Override via env vars for non-default deployments:
//   PERSEUS_SERVER  — API base URL (default: https://perseus.cwchanap.dev)
//   CF_ACCESS_AUD   — Cloudflare Access application AUD (deployment-specific)
export const DEFAULT_SERVER = process.env.PERSEUS_SERVER ?? 'https://perseus.cwchanap.dev';
export const ACCESS_AUD =
	process.env.CF_ACCESS_AUD ?? '7fd50c02b28c32fe3abb938cebba2dc9dcec6c88f42969c28700e9a0a8a28e5f';

export const FETCH_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 120_000;
export const PROBE_TIMEOUT_MS = 15_000;

export function warnHardcodedDefaults(): void {
	if (!process.env.PERSEUS_SERVER) {
		console.warn(
			`[warn] PERSEUS_SERVER not set — using hardcoded default ${DEFAULT_SERVER}. ` +
				'Set PERSEUS_SERVER to override for non-default deployments.'
		);
	}
	if (!process.env.CF_ACCESS_AUD) {
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

export interface Options {
	command: 'login' | 'set-token' | 'upload' | 'status';
	server: string;
	passkey: string;
	catalogPath: string;
	imagesDir: string;
	tokenCachePath: string;
	cfAccessToken?: string;
	cfClientId?: string;
	cfClientSecret?: string;
	dryRun: boolean;
	from: number;
	to: number;
	limit?: number;
	delayMs: number;
	skipAccess: boolean;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
