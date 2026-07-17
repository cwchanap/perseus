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
import { createHash } from 'node:crypto';
import { aspectRatiosMatch, DEFAULT_PUZZLE_ASPECT_RATIO } from '@perseus/types';
import { parseImageDimensions, detectImageType } from '@perseus/shared';
import {
	FETCH_TIMEOUT_MS,
	UPLOAD_TIMEOUT_MS,
	MAX_FILE_SIZE,
	type Options,
	type AccessCredentials,
	type CatalogEntry,
	FatalError,
	sleep
} from './types';
import { validateCatalog, selectEntries, imagePathFor, mimeForPath } from './catalog';
import { resolveAccessToken, probeAccessToken, probeServiceToken } from './token';

export function accessHeaders(options: AccessCredentials): Record<string, string> {
	if (options.skipAccess) return {};
	const headers: Record<string, string> = {};
	// When service tokens are available, prefer them over a JWT — a stale
	// JWT alongside valid service tokens could cause Access to reject the
	// request. Only send JWT headers when service tokens are absent.
	const hasServiceToken = !!(options.cfClientId && options.cfClientSecret);
	if (options.cfAccessToken && !hasServiceToken) {
		headers['cf-access-token'] = options.cfAccessToken;
		headers['Cookie'] = `CF_Authorization=${options.cfAccessToken}`;
	}
	if (hasServiceToken) {
		headers['CF-Access-Client-Id'] = options.cfClientId!;
		headers['CF-Access-Client-Secret'] = options.cfClientSecret!;
	}
	return headers;
}

export function hasAccessCredentials(options: AccessCredentials): boolean {
	if (options.skipAccess) return true;
	if (options.cfAccessToken) return true;
	if (options.cfClientId && options.cfClientSecret) return true;
	return false;
}

export function sessionCookieFrom(response: Response, priorCookie?: string): string {
	const multi =
		typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
	// Select the API session cookie by name — Cloudflare Access can add a
	// CF_Authorization cookie alongside perseus_session in the response, so
	// taking multi[0] may return the Access cookie instead.
	const sessionCookie =
		multi.find((c) => c.startsWith('perseus_session=')) ?? response.headers.get('set-cookie');
	if (!sessionCookie) {
		throw new Error('Admin login did not return a session cookie');
	}
	const session = sessionCookie.split(';', 1)[0];
	// Preserve a CF_Authorization cookie (from the response or the prior
	// request cookie) so subsequent requests carry both cookies.
	const accessFromResponse = multi.find((c) => c.startsWith('CF_Authorization='));
	if (accessFromResponse) {
		return `${session}; ${accessFromResponse.split(';', 1)[0]}`;
	}
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

/**
 * HTTP-safe Idempotency-Key header value. The raw dedup key contains NUL
 * separators (invalid in HTTP headers), so SHA-256 hash it to a hex string.
 * The server uses this only as an opaque unique identifier — it never
 * decodes it — so a hash preserves the collision-resistance properties of
 * the composite key while being valid header content.
 */
export function idempotencyKeyHeader(dedupKey: string): string {
	return createHash('sha256').update(dedupKey).digest('hex');
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
		puzzles?: Array<{
			name?: string;
			pieceCount?: number;
			aspectRatio?: string;
			status?: string;
		}>;
	};
	const keys = new Set<string>();
	for (const p of payload.puzzles ?? []) {
		// Exclude failed puzzles so a subsequent seed run retries them instead
		// of skipping permanently. processing and ready puzzles are retained
		// for deduplication — they represent successful (or in-flight) uploads.
		if (p.status === 'failed') continue;
		if (typeof p.name === 'string' && p.name.trim()) {
			// Normalize missing aspectRatio to the server default (1:1). Legacy
			// puzzles may omit aspectRatio in their summary; the API treats a
			// missing value as 1:1, but the dedup key would encode it as an
			// empty field while catalog entries use '1:1' — causing a duplicate
			// upload on the next seed run.
			keys.add(idempotencyKey(p.name, p.pieceCount, p.aspectRatio ?? DEFAULT_PUZZLE_ASPECT_RATIO));
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
	// Poll count / base delay for post-failure existence checks. Production
	// GET /api/admin/puzzles reads eventually consistent KV; a single GET can
	// omit a just-created puzzle and cause a duplicate re-POST.
	verifyPollAttempts: 4,
	verifyPollBaseDelayMs: 250,
	sleepFn: sleep
};

/**
 * Poll GET /api/admin/puzzles until `dedupKey` appears or the attempt budget
 * is exhausted. Used after a transient POST failure (and after final-attempt
 * failure) so KV lag does not cause a duplicate re-POST or a false FAIL.
 *
 * If a poll GET itself fails, the error propagates — callers must not re-POST
 * blind when verification is broken.
 */
export async function pollForExistingKey(
	server: string,
	baseHeaders: Record<string, string>,
	cookie: string,
	dedupKey: string
): Promise<boolean> {
	const attempts = retryConfig.verifyPollAttempts;
	const baseDelayMs = retryConfig.verifyPollBaseDelayMs;
	for (let i = 0; i < attempts; i++) {
		await retryConfig.sleepFn(baseDelayMs * 2 ** i);
		const existing = await fetchExistingKeys(server, baseHeaders, cookie);
		if (existing.has(dedupKey)) return true;
	}
	return false;
}

/**
 * POST the puzzle form with bounded retry for transient failures (5xx responses,
 * network errors, and HTTP 409 idempotency conflicts). Other 4xx responses are
 * not retried — they are deterministic validation/authorization failures.
 *
 * Duplicate prevention has two layers:
 *   1. Idempotency-Key header (primary): the server reserves the key in
 *      PuzzleMetadataDO (strongly consistent) before minting a UUID. A retried
 *      POST that reaches the server returns the original puzzle (200) instead
 *      of creating a duplicate — no KV propagation race.
 *   2. KV-lag polling (secondary): before each retry, GET /api/admin/puzzles
 *      checks if the puzzle already exists. If found, a synthetic OK response
 *      is returned without re-POSTing. This catches the case where the first
 *      POST succeeded but the response was lost, without needing a second
 *      round-trip to the server.
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
	// Send the Idempotency-Key header so the server can dedup a retried POST
	// after a lost response via PuzzleMetadataDO (strongly consistent) instead
	// of relying solely on the eventually-consistent KV poll below.
	const idempotencyHeader = idempotencyKeyHeader(dedupKey);
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const response = await fetch(`${server}/api/admin/puzzles`, {
				method: 'POST',
				headers: {
					...baseHeaders,
					Cookie: cookie,
					'Idempotency-Key': idempotencyHeader
				},
				body: formData,
				redirect: 'manual',
				signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
			});
			if (response.ok) return response;
			if (response.status === 409) {
				// Idempotency conflict: another request with the same
				// Idempotency-Key is already in flight. The winner will commit
				// and a re-POST returns its puzzle (200) once metadata lands, so
				// treat 409 as transient and retry (polling first, as below)
				// instead of reporting a hard FAIL. No duplicate is created —
				// the DO reservation blocks the loser's POST until the winner
				// finishes, at which point the reserve returns the existing
				// puzzle (200) rather than a 409.
				lastError = new Error('HTTP 409 idempotency conflict — winner in flight');
			} else if (response.status < 500) {
				// Other 4xx are deterministic validation/authorization failures.
				return response;
			} else {
				// 5xx — transient, retry
				lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
			}
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
		if (attempt < maxAttempts) {
			// After a transient failure: poll for the puzzle before re-POSTing.
			// The Idempotency-Key header above is the primary dedup mechanism
			// (server-side, strongly consistent via DO). This KV poll is a
			// secondary check — it catches the case where the first POST
			// succeeded but the response was lost, without needing the server
			// to support idempotency. With the header in place, a re-POST that
			// reaches the server will return the original puzzle (200) instead
			// of creating a duplicate, even if this poll misses due to KV lag.
			if (await pollForExistingKey(server, baseHeaders, cookie, dedupKey)) {
				console.log(`  verified: ${entryName} already on server — skipping retry`);
				return new Response(
					JSON.stringify({ id: 'verified', status: 'response lost — verified via re-fetch' }),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}
			console.error(`  retry ${attempt}/${maxAttempts} (${lastError.message})`);
		}
	}
	throw lastError ?? new Error('Upload failed after retries');
}

/**
 * Resolve and probe Cloudflare Access credentials. Mutates options.cfAccessToken
 * if a JWT is resolved from cache/cloudflared. Throws FatalError on any auth
 * failure so the upload aborts before wasting network round-trips.
 *
 * Skipped entirely for --dry-run (no network needed) and --skip-access (local
 * API without Access).
 */
async function resolveAndProbeAccess(options: Options): Promise<void> {
	if (options.dryRun || options.skipAccess) return;

	// Skip JWT token resolution when service tokens are already available —
	// service tokens (CF-Access-Client-Id/Secret) authenticate Access without
	// needing a JWT, and resolveAccessToken would fall through to spawning
	// cloudflared (not installed in CI, wasteful everywhere else).
	if (!options.cfClientId || !options.cfClientSecret) {
		options.cfAccessToken = await resolveAccessToken({
			explicit: options.cfAccessToken,
			tokenCachePath: options.tokenCachePath,
			skipAccess: false,
			server: options.server
		});
	}

	if (!hasAccessCredentials(options)) {
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

	// When service tokens (CF-Access-Client-Id/Secret) are available, prefer
	// them over a JWT. A stale JWT from env/cache alongside valid service
	// tokens would cause the JWT probe to fail and abort, even though the
	// service tokens would work. Only probe the JWT when service tokens are
	// absent — service tokens are the recommended automation path.
	const hasServiceToken = !!(options.cfClientId && options.cfClientSecret);

	if (options.cfAccessToken && !hasServiceToken) {
		const probe = await probeAccessToken(options.server, options.cfAccessToken);
		if (probe === 'blocked') {
			throw new FatalError(
				'Access JWT is present but rejected by Cloudflare Access (302/403).\n' +
					'Run: bun run admin:startup:set-token'
			);
		}
		if (probe === 'error') {
			throw new FatalError(
				'Access JWT probe failed (network error or unexpected response).\n' +
					'Cannot verify Access credentials — aborting to avoid a doomed upload.\n' +
					'Check network connectivity and retry, or run: bun run admin:startup:set-token'
			);
		}
	}

	// Live smoke check for the service-token path (the primary CI method).
	// Mirrors the JWT probe above: hit GET /api/admin/puzzles with the service
	// token headers and fail fast if Access rejects them (302/403). Without
	// this, an expired/invalid CF-Access-Client-Id/Secret pair only surfaces as
	// an opaque login failure after the upload has already started.
	if (hasServiceToken) {
		const probe = await probeServiceToken(
			options.server,
			options.cfClientId!,
			options.cfClientSecret!
		);
		if (probe === 'blocked') {
			throw new FatalError(
				'Cloudflare Access service token rejected (302/403).\n' +
					'Check CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET are valid and not expired.\n' +
					'To rotate: see "CLI Service Token Rotation" in packages/infrastructure/README.md.'
			);
		}
		if (probe === 'error') {
			throw new FatalError(
				'Access service token probe failed (network error or unexpected response).\n' +
					'Cannot verify Access credentials — aborting to avoid a doomed upload.\n' +
					'Check network connectivity and retry.'
			);
		}
	}
}

/**
 * Log in to the admin API and return the session cookie. Throws FatalError on
 * login failure so the upload aborts before processing any entries.
 */
async function adminLogin(options: Options, baseHeaders: Record<string, string>): Promise<string> {
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
	return cookie;
}

type ImageValidation =
	| { ok: true; image: Bun.BunFile; imagePath: string }
	| { ok: false; detail: string };

/**
 * Validate a catalog entry's image file locally before uploading. Checks:
 *   1. Image file exists on disk
 *   2. File size ≤ MAX_FILE_SIZE (saves bandwidth on doomed uploads)
 *   3. Image dimensions match the entry's aspect ratio (magic-byte type
 *      detection so mislabeled extensions don't skip the check)
 *
 * Returns { ok: true, image, imagePath } on success, or { ok: false, detail }
 * with a human-readable failure reason.
 */
async function validateEntryImage(
	entry: CatalogEntry,
	imagesDir: string
): Promise<ImageValidation> {
	const imagePath = imagePathFor(entry, imagesDir);
	if (!imagePath) return { ok: false, detail: 'image missing' };

	const image = Bun.file(imagePath, { type: mimeForPath(imagePath) });

	if (image.size > MAX_FILE_SIZE) {
		return {
			ok: false,
			detail: `image is ${(image.size / 1024 / 1024).toFixed(1)}MB — exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`
		};
	}

	// Use detectImageType (magic bytes) instead of mimeForPath (extension)
	// so a mislabeled file (e.g. a .png containing JPEG data) is parsed
	// with the correct format decoder instead of silently skipping the
	// aspect-ratio check. If the type cannot be detected, the bytes are
	// not a supported image format (or are corrupted) — the API will
	// deterministically reject the upload with 400, so fail early here
	// rather than reporting a false-positive validation in dry runs.
	const detectedMime = await detectImageType(image);
	if (!detectedMime) {
		return { ok: false, detail: 'image type unrecognized (not JPEG, PNG, or WebP)' };
	}
	const dimensions = await parseImageDimensions(image, detectedMime);
	if (!dimensions) {
		return {
			ok: false,
			detail: 'image dimensions could not be parsed (corrupted or truncated header)'
		};
	}
	if (dimensions.width <= 0 || dimensions.height <= 0) {
		return {
			ok: false,
			detail: `image has invalid dimensions ${dimensions.width}x${dimensions.height}`
		};
	}
	if (!aspectRatiosMatch(dimensions.width, dimensions.height, entry.aspectRatio)) {
		return {
			ok: false,
			detail: `image ${dimensions.width}x${dimensions.height} does not match ${entry.aspectRatio}`
		};
	}

	return { ok: true, image, imagePath };
}

type UploadResult = { id: string; name: string; ok: boolean; detail: string };

/**
 * Process a single catalog entry: check idempotency, validate image, upload
 * with retry, and record the result. Mutates existingKeys (adds successful
 * dedup keys so later entries in the same run are skipped on retry).
 */
async function processEntry(
	entry: CatalogEntry,
	options: Options,
	baseHeaders: Record<string, string>,
	cookie: string,
	existingKeys: Set<string>
): Promise<UploadResult> {
	const dedupKey = idempotencyKey(entry.name, entry.pieceCount, entry.aspectRatio);
	if (existingKeys.has(dedupKey)) {
		console.log(`SKIP ${entry.id} ${entry.name}: already exists on server`);
		return { id: entry.id, name: entry.name, ok: true, detail: 'already exists — skipped' };
	}

	const validation = await validateEntryImage(entry, options.imagesDir);
	if (!validation.ok) {
		console.error(`FAIL ${entry.id} ${entry.name}: ${validation.detail}`);
		return { id: entry.id, name: entry.name, ok: false, detail: validation.detail };
	}

	const { image, imagePath } = validation;
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
			console.error(`FAIL ${entry.id} ${entry.name}: ${detail}`);
			return { id: entry.id, name: entry.name, ok: false, detail };
		}
		const puzzle = (await uploadResponse.json()) as { id?: string; status?: string };
		console.log(`OK   ${entry.id} ${entry.name} -> ${puzzle.id} (${puzzle.status})`);
		existingKeys.add(dedupKey);
		return {
			id: entry.id,
			name: entry.name,
			ok: true,
			detail: `${puzzle.id ?? '?'} ${puzzle.status ?? ''}`
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		// All retries exhausted. The final attempt may have succeeded
		// server-side but lost its response. Poll with bounded backoff before
		// declaring failure — a single GET can miss KV lag and report FAIL
		// for a puzzle that was actually created.
		let verified = false;
		try {
			verified = await pollForExistingKey(options.server, baseHeaders, cookie, dedupKey);
		} catch {
			// re-fetch itself failed; cannot verify — record original failure
		}
		if (verified) {
			existingKeys.add(dedupKey);
			console.log(`OK   ${entry.id} ${entry.name} -> verified (response lost on final attempt)`);
			return {
				id: entry.id,
				name: entry.name,
				ok: true,
				detail: 'verified — response lost on final attempt'
			};
		}
		console.error(`FAIL ${entry.id} ${entry.name}: ${detail}`);
		return { id: entry.id, name: entry.name, ok: false, detail };
	}
}

export async function cmdUpload(options: Options): Promise<void> {
	if (!options.dryRun && !options.passkey) {
		throw new FatalError('Missing admin passkey. Set ADMIN_PASSKEY or use --passkey.');
	}

	await resolveAndProbeAccess(options);

	const catalogRaw = await Bun.file(options.catalogPath).json();
	const catalog = validateCatalog(catalogRaw, options.catalogPath);
	const selected = selectEntries(catalog, options);
	if (selected.length === 0) {
		throw new FatalError('No catalog entries match the selected range.');
	}

	console.log(
		`${options.dryRun ? 'Dry-run' : 'Uploading'} ${selected.length} puzzle(s) to ${options.server}`
	);
	const toLabel = options.to === 0 || options.to === Number.MAX_SAFE_INTEGER ? 'end' : options.to;
	console.log(
		`Range: ids ${options.from}–${toLabel}${options.limit ? ` (limit ${options.limit})` : ''}`
	);

	if (options.dryRun) {
		let validationFailures = 0;
		for (const entry of selected) {
			const validation = await validateEntryImage(entry, options.imagesDir);
			const status = validation.ok ? 'OK' : `FAIL: ${validation.detail}`;
			console.log(
				`[dry-run] ${entry.id} ${entry.name} ${entry.pieceCount}pcs ${entry.aspectRatio} ${entry.category} -> ${status}`
			);
			if (!validation.ok) validationFailures++;
		}
		if (validationFailures > 0) {
			console.log(`\n${validationFailures} entry(s) would fail validation.`);
		}
		return;
	}

	const baseHeaders = accessHeaders(options);
	const cookie = await adminLogin(options, baseHeaders);

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

	const results: UploadResult[] = [];
	let skipped = 0;

	for (const entry of selected) {
		const result = await processEntry(entry, options, baseHeaders, cookie, existingKeys);
		results.push(result);
		if (result.detail === 'already exists — skipped') skipped++;
		if (options.delayMs > 0) await sleep(options.delayMs);
	}

	const ok = results.filter((r) => r.ok && r.detail !== 'already exists — skipped').length;
	const fail = results.filter((r) => !r.ok).length;
	console.log(`\nDone: ${ok} uploaded, ${skipped} skipped, ${fail} failed`);
	if (fail > 0) throw new FatalError(`${fail} puzzle(s) failed to upload`);
}
