import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
	accessHeaders,
	hasAccessCredentials,
	readError,
	uploadWithRetry,
	retryConfig
} from './upload';
import { detectImageType, parseImageDimensions, type BlobLike } from '@perseus/shared';
import { aspectRatiosMatch } from '@perseus/types';
import type { Options } from './types';

function makeOptions(overrides: Partial<Options> = {}): Options {
	return {
		command: 'upload',
		server: 'http://localhost:3000',
		passkey: 'test-passkey',
		catalogPath: '/dev/null',
		imagesDir: '/dev/null',
		tokenCachePath: '/dev/null',
		dryRun: false,
		from: 1,
		to: 70,
		delayMs: 0,
		skipAccess: true,
		...overrides
	};
}

// ─── accessHeaders ──────────────────────────────────────────────────
// The service token path (CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET)
// is the primary production auth path in CI. All existing tests use
// skipAccess: true, which returns {} — leaving this path untested.

describe('accessHeaders', () => {
	it('returns empty object when skipAccess is true', () => {
		expect(accessHeaders(makeOptions({ skipAccess: true }))).toEqual({});
	});

	it('returns service token headers when client id + secret are set', () => {
		const headers = accessHeaders(
			makeOptions({
				skipAccess: false,
				cfClientId: 'client-id-123',
				cfClientSecret: 'client-secret-456'
			})
		);
		expect(headers['CF-Access-Client-Id']).toBe('client-id-123');
		expect(headers['CF-Access-Client-Secret']).toBe('client-secret-456');
	});

	it('does not include cf-access-token when only service token is set', () => {
		const headers = accessHeaders(
			makeOptions({
				skipAccess: false,
				cfClientId: 'client-id-123',
				cfClientSecret: 'client-secret-456'
			})
		);
		expect(headers['cf-access-token']).toBeUndefined();
		expect(headers['Cookie']).toBeUndefined();
	});

	it('includes cf-access-token and Cookie when JWT is set', () => {
		const jwt = 'aaaa.bbbb.cccc';
		const headers = accessHeaders(
			makeOptions({
				skipAccess: false,
				cfAccessToken: jwt
			})
		);
		expect(headers['cf-access-token']).toBe(jwt);
		expect(headers['Cookie']).toBe(`CF_Authorization=${jwt}`);
	});

	it('prefers service token headers over JWT when both are set', () => {
		const jwt = 'aaaa.bbbb.cccc';
		const headers = accessHeaders(
			makeOptions({
				skipAccess: false,
				cfAccessToken: jwt,
				cfClientId: 'cid',
				cfClientSecret: 'csec'
			})
		);
		// Service token headers should be present; JWT headers should NOT —
		// a stale JWT alongside valid service tokens could cause Access to
		// reject the request, so service tokens are preferred.
		expect(headers['CF-Access-Client-Id']).toBe('cid');
		expect(headers['CF-Access-Client-Secret']).toBe('csec');
		expect(headers['cf-access-token']).toBeUndefined();
		expect(headers['Cookie']).toBeUndefined();
	});

	it('returns empty object when skipAccess is false but no credentials are set', () => {
		expect(accessHeaders(makeOptions({ skipAccess: false }))).toEqual({});
	});

	it('does not set service token headers when only client id is set (no secret)', () => {
		const headers = accessHeaders(
			makeOptions({
				skipAccess: false,
				cfClientId: 'cid'
			})
		);
		expect(headers['CF-Access-Client-Id']).toBeUndefined();
		expect(headers['CF-Access-Client-Secret']).toBeUndefined();
	});

	it('does not set service token headers when only client secret is set (no id)', () => {
		const headers = accessHeaders(
			makeOptions({
				skipAccess: false,
				cfClientSecret: 'csec'
			})
		);
		expect(headers['CF-Access-Client-Id']).toBeUndefined();
		expect(headers['CF-Access-Client-Secret']).toBeUndefined();
	});
});

// ─── hasAccessCredentials ───────────────────────────────────────────

describe('hasAccessCredentials', () => {
	it('returns true when skipAccess is true', () => {
		expect(hasAccessCredentials(makeOptions({ skipAccess: true }))).toBe(true);
	});

	it('returns true when cfAccessToken is set', () => {
		expect(
			hasAccessCredentials(makeOptions({ skipAccess: false, cfAccessToken: 'aaaa.bbbb.cccc' }))
		).toBe(true);
	});

	it('returns true when service token client id + secret are set', () => {
		expect(
			hasAccessCredentials(
				makeOptions({ skipAccess: false, cfClientId: 'cid', cfClientSecret: 'csec' })
			)
		).toBe(true);
	});

	it('returns false when no credentials are set and skipAccess is false', () => {
		expect(hasAccessCredentials(makeOptions({ skipAccess: false }))).toBe(false);
	});

	it('returns false when only client id is set (no secret)', () => {
		expect(hasAccessCredentials(makeOptions({ skipAccess: false, cfClientId: 'cid' }))).toBe(false);
	});

	it('returns false when only client secret is set (no id)', () => {
		expect(hasAccessCredentials(makeOptions({ skipAccess: false, cfClientSecret: 'csec' }))).toBe(
			false
		);
	});
});

// ─── readError ──────────────────────────────────────────────────────
// readError with usingServiceToken=true should produce a hint pointing
// to CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET, not the cookie-based
// set-token flow.

describe('readError', () => {
	it('extracts message from JSON error payload', async () => {
		const res = new Response(JSON.stringify({ message: 'Invalid category' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
		expect(await readError(res)).toBe('Invalid category');
	});

	it('falls back to status text when no JSON message', async () => {
		const res = new Response('plain text', { status: 400, statusText: 'Bad Request' });
		expect(await readError(res)).toBe('400 Bad Request');
	});

	it('detects Cloudflare Access block (302) with service token hint', async () => {
		const res = new Response('Cloudflare Access', { status: 302 });
		const msg = await readError(res, true);
		expect(msg).toContain('302');
		expect(msg).toContain('Cloudflare Access blocked');
		expect(msg).toContain('CF_ACCESS_CLIENT_ID');
		expect(msg).toContain('CF_ACCESS_CLIENT_SECRET');
	});

	it('detects Cloudflare Access block (403) with service token hint', async () => {
		const res = new Response('Forbidden', { status: 403 });
		const msg = await readError(res, true);
		expect(msg).toContain('403');
		expect(msg).toContain('CF_ACCESS_CLIENT_ID');
	});

	it('detects Cloudflare Access block (302) with cookie-based hint', async () => {
		const res = new Response('Cloudflare Access', { status: 302 });
		const msg = await readError(res, false);
		expect(msg).toContain('302');
		expect(msg).toContain('admin:startup:set-token');
		expect(msg).not.toContain('CF_ACCESS_CLIENT_ID');
	});

	it('detects Cloudflare Access block from body text even on non-302/403 status', async () => {
		const res = new Response('Cloudflare Access denied', { status: 400 });
		const msg = await readError(res, false);
		expect(msg).toContain('Cloudflare Access blocked');
	});

	it('falls back to status text for non-Access errors', async () => {
		const res = new Response('Internal Server Error', {
			status: 500,
			statusText: 'Internal Server Error'
		});
		expect(await readError(res)).toBe('500 Internal Server Error');
	});
});

// ─── uploadWithRetry ────────────────────────────────────────────────
// The API mints a fresh UUID per POST with no server-side idempotency, so
// re-POSTing after an unverifiable failure can create a duplicate puzzle.
// These tests verify that a verification GET failure aborts the retry loop
// instead of silently re-POSTing.

const originalFetch = globalThis.fetch;
const originalSleep = retryConfig.sleepFn;

describe('uploadWithRetry', () => {
	beforeEach(() => {
		retryConfig.sleepFn = async () => {};
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		retryConfig.sleepFn = originalSleep;
	});

	it('aborts retries when verification GET fails (does not re-POST)', async () => {
		const callLog: string[] = [];
		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			callLog.push(`${method} ${String(url)}`);
			if (method === 'POST') {
				return new Response('Internal Server Error', { status: 500 });
			}
			// GET verification — simulate server unavailable
			return new Response('Service Unavailable', { status: 503 });
		}) as unknown as typeof fetch;

		await expect(
			uploadWithRetry(
				'http://localhost:3000',
				{},
				'session=abc',
				new FormData(),
				'test-puzzle',
				'test-puzzle\u000048\u00001:1'
			)
		).rejects.toThrow('Could not fetch existing puzzles');

		// Only one POST should have been sent — no retry after GET failure
		const posts = callLog.filter((c) => c.startsWith('POST'));
		expect(posts.length).toBe(1);
	});

	it('returns synthetic OK when verification GET finds the dedup key', async () => {
		const callLog: string[] = [];
		globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			callLog.push(`${method} ${String(url)}`);
			if (method === 'POST') {
				return new Response('Internal Server Error', { status: 500 });
			}
			// GET verification — puzzle already exists server-side
			return new Response(
				JSON.stringify({
					puzzles: [{ name: 'test-puzzle', pieceCount: 48, aspectRatio: '1:1', status: 'ready' }]
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			);
		}) as unknown as typeof fetch;

		const res = await uploadWithRetry(
			'http://localhost:3000',
			{},
			'session=abc',
			new FormData(),
			'test-puzzle',
			'test-puzzle\u000048\u00001:1'
		);
		expect(res.ok).toBe(true);
		// Only one POST — the retry was skipped because verification found it
		const posts = callLog.filter((c) => c.startsWith('POST'));
		expect(posts.length).toBe(1);
	});
});

// ─── JPEG integration: detectImageType → parseImageDimensions → aspectRatiosMatch ──
// End-to-end test threading a crafted JPEG through the same chain cmdUpload uses
// (upload.ts:364-367). The shared-lib JPEG tests (packages/shared/src/__tests__)
// test parseImageDimensions in isolation; this test verifies the CLI's
// detectImageType → parse → aspect-ratio pipeline works together with a real
// JPEG buffer, including the mislabeled-extension case (JPEG content with a
// .png path) that motivated switching from mimeForPath to detectImageType.

// Build a minimal JPEG buffer with SOI + APP0/JFIF + SOF0 carrying the given
// width/height. Mirrors jpegHeaderBytes in packages/shared/src/__tests__/image.test.ts.
function jpegHeaderBytes(width: number, height: number): Uint8Array {
	const app0 = [
		0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01,
		0x00, 0x00
	];
	const sof0 = [
		0xff,
		0xc0,
		0x00,
		0x11,
		0x08,
		(height >> 8) & 0xff,
		height & 0xff,
		(width >> 8) & 0xff,
		width & 0xff,
		0x03,
		0x01,
		0x22,
		0x00,
		0x02,
		0x11,
		0x01,
		0x03,
		0x11,
		0x01
	];
	return new Uint8Array([0xff, 0xd8, ...app0, ...sof0]);
}

function makeBlob(bytes: Uint8Array): BlobLike {
	return new Blob([bytes]) as unknown as BlobLike;
}

describe('JPEG integration: detect → parse → aspect-ratio (cmdUpload pipeline)', () => {
	it('detects JPEG, parses 400x400 dimensions, and matches 1:1 aspect ratio', async () => {
		const blob = makeBlob(jpegHeaderBytes(400, 400));
		const mime = await detectImageType(blob);
		expect(mime).toBe('image/jpeg');
		const dims = await parseImageDimensions(blob, mime!);
		expect(dims).toEqual({ width: 400, height: 400 });
		expect(aspectRatiosMatch(dims!.width, dims!.height, '1:1')).toBe(true);
	});

	it('detects JPEG, parses 800x600 dimensions, and matches 4:3 aspect ratio', async () => {
		const blob = makeBlob(jpegHeaderBytes(800, 600));
		const mime = await detectImageType(blob);
		expect(mime).toBe('image/jpeg');
		const dims = await parseImageDimensions(blob, mime!);
		expect(dims).toEqual({ width: 800, height: 600 });
		expect(aspectRatiosMatch(dims!.width, dims!.height, '4:3')).toBe(true);
	});

	it('rejects 800x600 JPEG as not matching 1:1 aspect ratio', async () => {
		const blob = makeBlob(jpegHeaderBytes(800, 600));
		const mime = await detectImageType(blob);
		const dims = await parseImageDimensions(blob, mime!);
		expect(aspectRatiosMatch(dims!.width, dims!.height, '1:1')).toBe(false);
	});

	// Critical regression test: a file with JPEG magic bytes but a .png
	// extension must be detected as JPEG by detectImageType (magic bytes),
	// not as PNG by mimeForPath (extension). Before the fix, the CLI used
	// mimeForPath which would return 'image/png', causing parseImageDimensions
	// to try PNG parsing on JPEG bytes → garbage/null → aspect-ratio check
	// silently skipped. Now detectImageType ensures the correct decoder runs.
	it('detects JPEG from magic bytes even if extension says .png (mislabeled file)', async () => {
		const blob = makeBlob(jpegHeaderBytes(400, 400));
		const mime = await detectImageType(blob);
		expect(mime).toBe('image/jpeg');
		expect(mime).not.toBe('image/png');
		const dims = await parseImageDimensions(blob, mime!);
		expect(dims).toEqual({ width: 400, height: 400 });
		expect(aspectRatiosMatch(dims!.width, dims!.height, '1:1')).toBe(true);
	});
});
