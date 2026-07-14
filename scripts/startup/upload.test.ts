import { describe, it, expect } from 'bun:test';
import { accessHeaders, hasAccessCredentials, readError } from './upload';
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

	it('includes both JWT and service token headers when all are set', () => {
		const jwt = 'aaaa.bbbb.cccc';
		const headers = accessHeaders(
			makeOptions({
				skipAccess: false,
				cfAccessToken: jwt,
				cfClientId: 'cid',
				cfClientSecret: 'csec'
			})
		);
		expect(headers['cf-access-token']).toBe(jwt);
		expect(headers['Cookie']).toBe(`CF_Authorization=${jwt}`);
		expect(headers['CF-Access-Client-Id']).toBe('cid');
		expect(headers['CF-Access-Client-Secret']).toBe('csec');
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
