import { describe, it, expect } from 'bun:test';
import { evaluateReadiness } from './cli';

// evaluateReadiness is the pure decision function extracted from cmdStatus.
// It encodes the gate this file exists to guard: `bun run admin:startup:status`
// must never report "Ready" (exit 0) when Access credentials are present but
// rejected/expired. These cases exercise that matrix without network/probe
// mocks — the probe outcome is passed in directly.

describe('evaluateReadiness (cmdStatus gate)', () => {
	const base = {
		skipAccess: false,
		hasToken: false,
		hasServiceToken: true,
		probeResult: 'ok' as string | undefined,
		passkey: 'pk'
	};

	it('is ready when a service token probes ok and a passkey is set', () => {
		expect(evaluateReadiness(base)).toEqual({ ready: true });
	});

	it('is ready when a JWT probes ok and a passkey is set', () => {
		expect(
			evaluateReadiness({ ...base, hasServiceToken: false, hasToken: true, probeResult: 'ok' })
		).toEqual({ ready: true });
	});

	it('is ready under skipAccess with a passkey (local server, no probe)', () => {
		expect(
			evaluateReadiness({
				...base,
				skipAccess: true,
				hasServiceToken: false,
				probeResult: undefined
			})
		).toEqual({ ready: true });
	});

	// ── The gate this function protects: never "Ready" on rejected creds. ──
	it('fails on a rejected service token (blocked) — does NOT report ready', () => {
		expect(evaluateReadiness({ ...base, probeResult: 'blocked' })).toEqual({
			ready: false,
			reason: 'access-probe-failed'
		});
	});

	it('fails on a service token probe error', () => {
		expect(evaluateReadiness({ ...base, probeResult: 'error' })).toEqual({
			ready: false,
			reason: 'access-probe-failed'
		});
	});

	it('fails on a rejected JWT (blocked)', () => {
		expect(
			evaluateReadiness({
				...base,
				hasServiceToken: false,
				hasToken: true,
				probeResult: 'blocked'
			})
		).toEqual({ ready: false, reason: 'access-probe-failed' });
	});

	it('prioritizes probe failure over a missing passkey (the original bug)', () => {
		// A blocked token with ADMIN_PASSKEY unset must surface the probe failure,
		// not the passkey hint — otherwise rejected credentials appear valid.
		expect(evaluateReadiness({ ...base, probeResult: 'blocked', passkey: '' })).toEqual({
			ready: false,
			reason: 'access-probe-failed'
		});
	});

	it('reports access-missing when no credentials are present and no probe ran', () => {
		expect(
			evaluateReadiness({
				...base,
				hasServiceToken: false,
				probeResult: undefined,
				passkey: 'pk'
			})
		).toEqual({ ready: false, reason: 'access-missing' });
	});

	it('reports passkey-missing when access is ok but no passkey is set', () => {
		expect(evaluateReadiness({ ...base, passkey: '' })).toEqual({
			ready: false,
			reason: 'passkey-missing'
		});
	});

	it('reports passkey-missing under skipAccess when no passkey is set', () => {
		expect(
			evaluateReadiness({
				...base,
				skipAccess: true,
				hasServiceToken: false,
				probeResult: undefined,
				passkey: ''
			})
		).toEqual({ ready: false, reason: 'passkey-missing' });
	});
});
