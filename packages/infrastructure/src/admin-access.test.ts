import { describe, expect, it } from 'vitest';
import {
	ADMIN_ACCESS_PATHS,
	DEFAULT_ADMIN_ACCESS_SESSION_DURATION,
	buildAdminAccessApplicationArgs,
	buildAdminAccessDestinations,
	buildAdminAccessPolicy,
	buildAdminDeviceSerialItems,
	normalizeAdminAccessHostname,
	parseAdminDeviceSerials
} from './admin-access.js';

describe('parseAdminDeviceSerials', () => {
	it('parses a JSON array of serial strings and trims entries', () => {
		expect(parseAdminDeviceSerials('[" C02ABC123456 ", "FVF987654321"]')).toEqual([
			'C02ABC123456',
			'FVF987654321'
		]);
	});

	it('rejects invalid JSON', () => {
		expect(() => parseAdminDeviceSerials('C02ABC123456')).toThrow(
			/adminDeviceSerials must be a JSON array string/
		);
	});

	it('rejects non-array JSON', () => {
		expect(() => parseAdminDeviceSerials('"C02ABC123456"')).toThrow(
			/adminDeviceSerials must be a JSON array/
		);
	});

	it('rejects an empty serial list', () => {
		expect(() => parseAdminDeviceSerials('[]')).toThrow(
			/adminDeviceSerials must include at least one serial number/
		);
	});

	it('rejects blank serial entries', () => {
		expect(() => parseAdminDeviceSerials('["C02ABC123456", " "]')).toThrow(
			/adminDeviceSerials entries must be non-empty strings/
		);
	});

	it('rejects duplicate serial entries after trimming', () => {
		expect(() => parseAdminDeviceSerials('["C02ABC123456", " C02ABC123456 "]')).toThrow(
			/adminDeviceSerials must not contain duplicate serial numbers/
		);
	});
});

describe('normalizeAdminAccessHostname', () => {
	it('accepts a bare hostname', () => {
		expect(normalizeAdminAccessHostname('perseus.cwchanap.dev')).toBe('perseus.cwchanap.dev');
	});

	it('extracts host from an HTTPS URL', () => {
		expect(normalizeAdminAccessHostname('https://perseus.cwchanap.dev/login')).toBe(
			'perseus.cwchanap.dev'
		);
	});

	it('rejects a configured port', () => {
		expect(() => normalizeAdminAccessHostname('https://perseus.cwchanap.dev:8443')).toThrow(
			/adminAccessHostname must not include a port/
		);
	});

	it('rejects an explicit default HTTPS port', () => {
		expect(() => normalizeAdminAccessHostname('https://perseus.cwchanap.dev:443')).toThrow(
			/adminAccessHostname must not include a port/
		);
	});

	it('rejects an explicit default HTTP port', () => {
		expect(() => normalizeAdminAccessHostname('http://perseus.cwchanap.dev:80')).toThrow(
			/adminAccessHostname must not include a port/
		);
	});

	it('rejects an explicit port on a bare hostname', () => {
		expect(() => normalizeAdminAccessHostname('perseus.cwchanap.dev:443')).toThrow(
			/adminAccessHostname must not include a port/
		);
	});

	it('does not treat path or query colons as ports', () => {
		expect(normalizeAdminAccessHostname('https://perseus.cwchanap.dev/admin:443?next=:80')).toBe(
			'perseus.cwchanap.dev'
		);
	});

	it('rejects a blank hostname', () => {
		expect(() => normalizeAdminAccessHostname('   ')).toThrow(
			/adminAccessHostname must not be empty/
		);
	});
});

describe('buildAdminAccessDestinations', () => {
	it('builds exactly the admin UI and admin API destinations', () => {
		expect(ADMIN_ACCESS_PATHS).toEqual(['/admin', '/admin/*', '/api/admin', '/api/admin/*']);
		expect(buildAdminAccessDestinations('perseus.cwchanap.dev')).toEqual([
			{ type: 'public', uri: 'https://perseus.cwchanap.dev/admin' },
			{ type: 'public', uri: 'https://perseus.cwchanap.dev/admin/*' },
			{ type: 'public', uri: 'https://perseus.cwchanap.dev/api/admin' },
			{ type: 'public', uri: 'https://perseus.cwchanap.dev/api/admin/*' }
		]);
	});
});

describe('buildAdminDeviceSerialItems', () => {
	it('maps serials to Cloudflare Zero Trust list items without exposing emails', () => {
		expect(buildAdminDeviceSerialItems(['C02ABC123456', 'FVF987654321'])).toEqual([
			{ value: 'C02ABC123456', description: 'Perseus admin device 1' },
			{ value: 'FVF987654321', description: 'Perseus admin device 2' }
		]);
	});
});

describe('buildAdminAccessPolicy', () => {
	it('allows only the configured email and requires the posture rule', () => {
		expect(buildAdminAccessPolicy('admin@example.com', 'posture-rule-id')).toEqual({
			name: 'Allow configured admin on trusted device',
			decision: 'allow',
			precedence: 1,
			includes: [{ email: { email: 'admin@example.com' } }],
			requires: [{ devicePosture: { integrationUid: 'posture-rule-id' } }]
		});
	});
});

describe('buildAdminAccessApplicationArgs', () => {
	it('builds a path-scoped self-hosted Access app', () => {
		expect(
			buildAdminAccessApplicationArgs({
				accountId: 'account-id',
				hostname: 'https://perseus.cwchanap.dev',
				adminEmail: 'admin@example.com',
				postureRuleId: 'posture-rule-id'
			})
		).toEqual({
			accountId: 'account-id',
			name: 'Perseus Admin',
			type: 'self_hosted',
			domain: 'perseus.cwchanap.dev/admin',
			destinations: [
				{ type: 'public', uri: 'https://perseus.cwchanap.dev/admin' },
				{ type: 'public', uri: 'https://perseus.cwchanap.dev/admin/*' },
				{ type: 'public', uri: 'https://perseus.cwchanap.dev/api/admin' },
				{ type: 'public', uri: 'https://perseus.cwchanap.dev/api/admin/*' }
			],
			sessionDuration: DEFAULT_ADMIN_ACCESS_SESSION_DURATION,
			appLauncherVisible: false,
			allowAuthenticateViaWarp: false,
			enableBindingCookie: true,
			httpOnlyCookieAttribute: true,
			pathCookieAttribute: false,
			policies: [
				{
					name: 'Allow configured admin on trusted device',
					decision: 'allow',
					precedence: 1,
					includes: [{ email: { email: 'admin@example.com' } }],
					requires: [{ devicePosture: { integrationUid: 'posture-rule-id' } }]
				}
			]
		});
	});

	it('uses a configured session duration when provided', () => {
		const args = buildAdminAccessApplicationArgs({
			accountId: 'account-id',
			hostname: 'perseus.cwchanap.dev',
			adminEmail: 'admin@example.com',
			postureRuleId: 'posture-rule-id',
			sessionDuration: '4h'
		});

		expect(args.sessionDuration).toBe('4h');
	});
});
