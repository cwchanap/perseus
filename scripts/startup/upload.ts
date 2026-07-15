/**
 * HTTP helpers and upload logic.
 *
 * accessHeaders / hasAccessCredentials / sessionCookieFrom / readError are the
 * shared HTTP utilities used by both the upload command and the token probe
 * flow. fetchExistingKeys is used for idempotency (skip already-uploaded
 * puzzles) and for retry verification (detect silent successes).
 *
 * uploadWithRetry wraps the POST with bounded retry for transient failures
 * (5xx, network errors). 4xx responses are not retried — they are
 * deterministic validation/authorization failures.
 */

import { basename } from 'node:path';
import { aspectRatiosMatch } from '@perseus/types';
import { parseImageDimensions, detectImageType } from '@perseus/shared';
import {
	FETCH_TIMEOUT_MS,
	UPLOAD_TIMEOUT_MS,
	MAX_FILE_SIZE,
	type Options,
	FatalError,
	sleep
} from './types';
import { validateCatalog, selectEntries, imagePathFor, mimeForPath } from './catalog';
import { resolveAccessToken, probeAccessToken, probeServiceToken } from './token';

export function accessHeaders(options: Options): Record<string, string> {
	if (options.skipAccess) return {};
	const headers: Record<string, string> = {};
	if (options.cfAccessToken) {
		headers['cf-access-token'] = options.cfAccessToken;
		headers['Cookie'] = `CF_Authorization=${options.cfAccessToken}`;
	}
	if (options.cfClientId && options.cfClientSecret) {
		headers['CF-Access-Client-Id'] = options.cfClientId;
		headers['CF-Access-Client-Secret'] = options.cfClientSecret;
	}
	return headers;
}

export function hasAccessCredentials(options: Options): boolean {
	if (options.skipAccess) return true;
	if (options.cfAccessToken) return true;
	if (options.cfClientId && options.cfClientSecret) return true;
	return false;
}

export function sessionCookieFrom(response: Response, priorCookie?: string): string {
	const multi =
		typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
	const setCookie = multi[0] ?? response.headers.get('set-cookie');
	if (!setCookie) {
		throw new Error('Admin login did not return a session cookie');
	}
	const session = setCookie.split(';', 1)[0];
	if (priorCookie?.includes('CF_Authorization=')) {
		const accessPart = priorCookie
			.split(';')
			.map((p) => p.trim())
			.find((p) => p.startsWith('CF_Authorization='));
		if (accessPart) return `${session}; ${accessPart}`;
	}
	return session;
}

export async function readError(response: Response, usingServiceToken = false): Promise<string> {
	const payload = await response
		.clone()
		.json()
		.catch(() => null);
	if (payload && typeof payload === 'object' && 'message' in payload) {
		const message = (payload as { message?: unknown }).message;
		if (typeof message === 'string') return message;
	}
	const text = await response
		.clone()
		.text()
		.catch(() => '');
	if (text.includes('Cloudflare Access') || response.status === 302 || response.status === 403) {
		const hint = usingServiceToken
			? 'Check CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET are valid and not expired.'
			: 'Run: bun run admin:startup:set-token';
		return `${response.status} Cloudflare Access blocked — ${hint}`;
	}
	return `${response.status} ${response.statusText}`;
}

/**
 * Composite idempotency key: name + pieceCount + aspectRatio. Matching on name
 * alone is fragile because the API does not enforce unique names — a manually
 * uploaded puzzle sharing a seed entry's name (but with a different piece count
 * or aspect ratio) would wrongly cause the seed entry to be skipped. Including
 * pieceCount and aspectRatio makes the dedup key specific to the puzzle
 * configuration the catalog entry describes.
 */
export function idempotencyKey(name: string, pieceCount?: number, aspectRatio?: string): string {
	return `${name.trim()}\u0000${pieceCount ?? ''}\u0000${aspectRatio ?? ''}`;
}

export async function fetchExistingKeys(
	server: string,
	baseHeaders: Record<string, string>,
	cookie: string
): Promise<Set<string>> {
	const res = await fetch(`${server}/api/admin/puzzles`, {
		method: 'GET',
		headers: { ...baseHeaders, Cookie: cookie },
		redirect: 'manual',
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	if (!res.ok) {
		throw new Error(
			`Could not fetch existing puzzles (${res.status} ${res.statusText}). ` +
				'Aborting to avoid duplicate uploads — re-run after verifying the API is reachable.'
		);
	}
	const payload = (await res.json()) as {
		puzzles?: Array<{ name?: string; pieceCount?: number; aspectRatio?: string }>;
	};
	const keys = new Set<string>();
	for (const p of payload.puzzles ?? []) {
		if (typeof p.name === 'string' && p.name.trim()) {
			keys.add(idempotencyKey(p.name, p.pieceCount, p.aspectRatio));
		}
	}
	return keys;
}

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

/**
 * Retry parameters exported as a mutable object so tests can override the sleep
 * function without waiting real time. Mutate `retryConfig.sleepFn` in test setup
 * and restore it in teardown.
 */
export const retryConfig = {
	maxAttempts: MAX_RETRY_ATTEMPTS,
	baseDelayMs: RETRY_BASE_DELAY_MS,
	sleepFn: sleep
};

/**
 * POST the puzzle form with bounded retry for transient failures (5xx responses
 * and network errors). 4xx responses are not retried — they are deterministic
 * validation/authorization failures.
 *
 * To prevent duplicate puzzles when the server creates the puzzle but the
 * response is lost (network error or post-creation 5xx), the entry name is
 * re-checked against existing puzzles before each retry. If the name already
 * exists, a synthetic OK response is returned instead of re-POSTing.
 */
export async function uploadWithRetry(
	server: string,
	baseHeaders: Record<string, string>,
	cookie: string,
	formData: FormData,
	entryName: string,
	dedupKey: string
): Promise<Response> {
	let lastError: Error | undefined;
	const maxAttempts = retryConfig.maxAttempts;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const response = await fetch(`${server}/api/admin/puzzles`, {
				method: 'POST',
				headers: { ...baseHeaders, Cookie: cookie },
				body: formData,
				redirect: 'manual',
				signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
			});
			if (response.ok || response.status < 500) return response;
			// 5xx — transient, retry
			lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
		if (attempt < maxAttempts) {
			// Before retrying: check if the failed attempt actually succeeded
			// server-side (response lost / post-creation 5xx). If so, return a
			// synthetic OK instead of re-POSTing — re-POSTing would create a
			// duplicate puzzle since the API generates a fresh UUID per upload.
			const existing = await fetchExistingKeys(server, baseHeaders, cookie).catch(() => null);
			if (existing?.has(dedupKey)) {
				console.log(`  verified: ${entryName} already on server — skipping retry`);
				return new Response(
					JSON.stringify({ id: 'verified', status: 'response lost — verified via re-fetch' }),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}
			const backoff = retryConfig.baseDelayMs * 2 ** (attempt - 1);
			console.error(`  retry ${attempt}/${maxAttempts} after ${backoff}ms (${lastError.message})`);
			await retryConfig.sleepFn(backoff);
		}
	}
	throw lastError ?? new Error('Upload failed after retries');
}

export async function cmdUpload(options: Options): Promise<void> {
	if (!options.dryRun && !options.passkey) {
		throw new FatalError('Missing admin passkey. Set ADMIN_PASSKEY or use --passkey.');
	}

	// Skip JWT token resolution when service tokens are already available —
	// service tokens (CF-Access-Client-Id/Secret) authenticate Access without
	// needing a JWT, and resolveAccessToken would fall through to spawning
	// cloudflared (not installed in CI, wasteful everywhere else).
	if (!options.dryRun && !options.skipAccess && (!options.cfClientId || !options.cfClientSecret)) {
		options.cfAccessToken = await resolveAccessToken({
			explicit: options.cfAccessToken,
			tokenCachePath: options.tokenCachePath,
			skipAccess: false,
			server: options.server
		});
	}

	if (!options.dryRun && !hasAccessCredentials(options)) {
		throw new FatalError(`Cloudflare Access credentials missing.

For automation, Cloudflare recommends Access service tokens (not browser cookies):
  https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

After deploying the admin CLI service token (Pulumi exports):
  export CF_ACCESS_CLIENT_ID="$(cd packages/infrastructure && pulumi stack output adminCliAccessClientId)"
  export CF_ACCESS_CLIENT_SECRET="$(cd packages/infrastructure && pulumi stack output --show-secrets adminCliAccessClientSecret)"

Or add those two keys to apps/api/.env, then:
  bun run admin:startup:upload -- --limit 5
`);
	}

	if (!options.dryRun && options.cfAccessToken && !options.skipAccess) {
		const probe = await probeAccessToken(options.server, options.cfAccessToken);
		if (probe === 'blocked') {
			throw new FatalError(
				'Access JWT is present but rejected by Cloudflare Access (302/403).\n' +
					'Run: bun run admin:startup:set-token'
			);
		}
	}

	// Live smoke check for the service-token path (the primary CI method).
	// Mirrors the JWT probe above: hit GET /api/admin/puzzles with the service
	// token headers and fail fast if Access rejects them (302/403). Without
	// this, an expired/invalid CF-Access-Client-Id/Secret pair only surfaces as
	// an opaque login failure after the upload has already started. Only probe
	// when no JWT is present — if both are set, the JWT probe already ran.
	if (
		!options.dryRun &&
		!options.skipAccess &&
		!options.cfAccessToken &&
		options.cfClientId &&
		options.cfClientSecret
	) {
		const probe = await probeServiceToken(
			options.server,
			options.cfClientId,
			options.cfClientSecret
		);
		if (probe === 'blocked') {
			throw new FatalError(
				'Cloudflare Access service token rejected (302/403).\n' +
					'Check CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET are valid and not expired.\n' +
					'To rotate: see "CLI Service Token Rotation" in packages/infrastructure/README.md.'
			);
		}
	}

	const catalogRaw = await Bun.file(options.catalogPath).json();
	const catalog = validateCatalog(catalogRaw, options.catalogPath);
	const selected = selectEntries(catalog, options);
	if (selected.length === 0) {
		throw new FatalError('No catalog entries match the selected range.');
	}

	console.log(
		`${options.dryRun ? 'Dry-run' : 'Uploading'} ${selected.length} puzzle(s) to ${options.server}`
	);
	const toLabel = options.to === Number.MAX_SAFE_INTEGER ? 'end' : options.to;
	console.log(
		`Range: ids ${options.from}–${toLabel}${options.limit ? ` (limit ${options.limit})` : ''}`
	);

	if (options.dryRun) {
		for (const entry of selected) {
			const imagePath = imagePathFor(entry, options.imagesDir);
			console.log(
				`[dry-run] ${entry.id} ${entry.name} ${entry.pieceCount}pcs ${entry.aspectRatio} ${entry.category} -> ${imagePath ?? 'MISSING'}`
			);
		}
		return;
	}

	const baseHeaders = accessHeaders(options);
	const loginResponse = await fetch(`${options.server}/api/admin/login`, {
		method: 'POST',
		headers: { ...baseHeaders, 'Content-Type': 'application/json' },
		body: JSON.stringify({ passkey: options.passkey }),
		redirect: 'manual',
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	if (!loginResponse.ok) {
		throw new FatalError(
			`Admin login failed: ${await readError(loginResponse, !!(options.cfClientId && options.cfClientSecret))}`
		);
	}
	const cookie = sessionCookieFrom(loginResponse, baseHeaders.Cookie);
	console.log('Admin session OK\n');

	// Idempotency: fetch existing puzzle keys so reruns skip already-uploaded
	// entries instead of creating duplicates (the API generates a fresh UUID
	// per upload). The key is name + pieceCount + aspectRatio so a same-named
	// but differently-configured puzzle does not cause a wrongful skip.
	const existingKeys = await fetchExistingKeys(options.server, baseHeaders, cookie);
	if (existingKeys.size > 0) {
		console.log(
			`Idempotency: ${existingKeys.size} existing puzzle(s) on server — duplicates will be skipped.\n`
		);
	}

	const results: Array<{ id: string; name: string; ok: boolean; detail: string }> = [];
	let skipped = 0;

	for (const entry of selected) {
		const dedupKey = idempotencyKey(entry.name, entry.pieceCount, entry.aspectRatio);
		if (existingKeys.has(dedupKey)) {
			skipped++;
			results.push({
				id: entry.id,
				name: entry.name,
				ok: true,
				detail: 'already exists — skipped'
			});
			console.log(`SKIP ${entry.id} ${entry.name}: already exists on server`);
			continue;
		}

		const imagePath = imagePathFor(entry, options.imagesDir);
		if (!imagePath) {
			results.push({ id: entry.id, name: entry.name, ok: false, detail: 'image missing' });
			console.error(`FAIL ${entry.id} ${entry.name}: image missing`);
			continue;
		}

		const image = Bun.file(imagePath, { type: mimeForPath(imagePath) });

		// Pre-validate file size locally to avoid uploading images the server
		// will reject (MAX_FILE_SIZE = 10MB). Saves bandwidth on slow links.
		if (image.size > MAX_FILE_SIZE) {
			const detail = `image is ${(image.size / 1024 / 1024).toFixed(1)}MB — exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`;
			results.push({ id: entry.id, name: entry.name, ok: false, detail });
			console.error(`FAIL ${entry.id} ${entry.name}: ${detail}`);
			continue;
		}

		// Pre-validate image dimensions against the requested aspect ratio.
		// Catches mis-cropped images locally before wasting a network round-trip
		// (the server performs the same check and returns 400 on mismatch).
		// Use detectImageType (magic bytes) instead of mimeForPath (extension)
		// so a mislabeled file (e.g. a .png containing JPEG data) is parsed
		// with the correct format decoder instead of silently skipping the
		// aspect-ratio check.
		const detectedMime = await detectImageType(image);
		const dimensions = detectedMime ? await parseImageDimensions(image, detectedMime) : null;
		if (dimensions) {
			if (!aspectRatiosMatch(dimensions.width, dimensions.height, entry.aspectRatio)) {
				const detail = `image ${dimensions.width}x${dimensions.height} does not match ${entry.aspectRatio}`;
				results.push({ id: entry.id, name: entry.name, ok: false, detail });
				console.error(`FAIL ${entry.id} ${entry.name}: ${detail}`);
				continue;
			}
		}
		const formData = new FormData();
		formData.append('name', entry.name);
		formData.append('pieceCount', String(entry.pieceCount));
		formData.append('aspectRatio', entry.aspectRatio);
		formData.append('category', entry.category);
		formData.append('image', image, basename(imagePath));

		try {
			const uploadResponse = await uploadWithRetry(
				options.server,
				baseHeaders,
				cookie,
				formData,
				entry.name,
				dedupKey
			);
			if (!uploadResponse.ok) {
				const detail = await readError(
					uploadResponse,
					!!(options.cfClientId && options.cfClientSecret)
				);
				results.push({ id: entry.id, name: entry.name, ok: false, detail });
				console.error(`FAIL ${entry.id} ${entry.name}: ${detail}`);
			} else {
				const puzzle = (await uploadResponse.json()) as { id?: string; status?: string };
				results.push({
					id: entry.id,
					name: entry.name,
					ok: true,
					detail: `${puzzle.id ?? '?'} ${puzzle.status ?? ''}`
				});
				console.log(`OK   ${entry.id} ${entry.name} -> ${puzzle.id} (${puzzle.status})`);
				existingKeys.add(dedupKey);
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			// All retries exhausted. The final attempt may have succeeded
			// server-side but lost its response. Re-fetch to verify before
			// declaring failure — prevents false negatives on flaky connections.
			let verified = false;
			try {
				const refreshed = await fetchExistingKeys(options.server, baseHeaders, cookie);
				verified = refreshed.has(dedupKey);
			} catch {
				// re-fetch itself failed; cannot verify — record original failure
			}
			if (verified) {
				results.push({
					id: entry.id,
					name: entry.name,
					ok: true,
					detail: 'verified — response lost on final attempt'
				});
				existingKeys.add(dedupKey);
				console.log(`OK   ${entry.id} ${entry.name} -> verified (response lost on final attempt)`);
			} else {
				results.push({ id: entry.id, name: entry.name, ok: false, detail });
				console.error(`FAIL ${entry.id} ${entry.name}: ${detail}`);
			}
		}

		if (options.delayMs > 0) await sleep(options.delayMs);
	}

	const ok = results.filter((r) => r.ok && r.detail !== 'already exists — skipped').length;
	const fail = results.filter((r) => !r.ok).length;
	console.log(`\nDone: ${ok} uploaded, ${skipped} skipped, ${fail} failed`);
	if (fail > 0) throw new FatalError(`${fail} puzzle(s) failed to upload`);
}
