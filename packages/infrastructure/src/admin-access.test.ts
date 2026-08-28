import { describe, expect, it } from 'vitest';
import {
	ADMIN_ACCESS_PATHS,
	CLI_ACCESS_PATHS,
	DEFAULT_ADMIN_ACCESS_SESSION_DURATION,
	DEFAULT_ADMIN_CLI_SERVICE_TOKEN_DURATION,
	buildAdminAccessApplicationArgs,
	buildAdminAccessDestinations,
	buildAdminAccessPolicy,
	buildAdminCliServiceAuthPolicy,
	buildCliAccessApplicationArgs,
	buildCliAccessDestinations,
	buildAdminDeviceSerialItems,
	buildCliServiceTokenArgs,
	normalizeAdminAccessEmail,
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

	it('normalizes serials to uppercase for consistent matching with WARP', () => {
		expect(parseAdminDeviceSerials('["c02abc123456"]')).toEqual(['C02ABC123456']);
	});
});

describe('normalizeAdminAccessHostname', () => {
	it('accepts a bare hostname', () => {
		expect(normalizeAdminAccessHostname('perseus.cwchanap.dev')).toBe('perseus.cwchanap.dev');
	});

	it('extracts host from an HTTPS URL without path', () => {
		expect(normalizeAdminAccessHostname('https://perseus.cwchanap.dev')).toBe(
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

	it('rejects a URL with a path', () => {
		expect(() => normalizeAdminAccessHostname('https://perseus.cwchanap.dev/login')).toThrow(
			/adminAccessHostname must not include a path/
		);
	});

	it('rejects a URL with a query string', () => {
		expect(() => normalizeAdminAccessHostname('perseus.cwchanap.dev?foo=bar')).toThrow(
			/adminAccessHostname must not include a query string/
		);
	});

	it('rejects a URL with a fragment', () => {
		expect(() => normalizeAdminAccessHostname('perseus.cwchanap.dev#section')).toThrow(
			/adminAccessHostname must not include a fragment/
		);
	});

	it('rejects a URL with userinfo', () => {
		expect(() => normalizeAdminAccessHostname('https://user:pass@perseus.cwchanap.dev')).toThrow(
			/adminAccessHostname must not include userinfo/
		);
	});

	it('rejects a blank hostname', () => {
		expect(() => normalizeAdminAccessHostname('   ')).toThrow(
			/adminAccessHostname must not be empty/
		);
	});

	it('rejects an IPv6 address with an explicit port', () => {
		expect(() => normalizeAdminAccessHostname('https://[::1]:8443')).toThrow(
			/adminAccessHostname must not include a port/
		);
	});

	it('rejects an IPv6 address with explicit default port', () => {
		expect(() => normalizeAdminAccessHostname('https://[::1]:443')).toThrow(
			/adminAccessHostname must not include a port/
		);
	});
});

describe('buildAdminAccessDestinations', () => {
	it('builds exactly the admin UI and admin API destinations', () => {
		expect(ADMIN_ACCESS_PATHS).toEqual(['/admin', '/admin/*', '/api/admin', '/api/admin/*']);
		expect(buildAdminAccessDestinations('perseus.cwchanap.dev')).toEqual([
			{ type: 'public', uri: 'perseus.cwchanap.dev/admin' },
			{ type: 'public', uri: 'perseus.cwchanap.dev/admin/*' },
			{ type: 'public', uri: 'perseus.cwchanap.dev/api/admin' },
			{ type: 'public', uri: 'perseus.cwchanap.dev/api/admin/*' }
		]);
	});
});

describe('buildCliAccessDestinations', () => {
	it('builds only the exact puzzle list/create path needed by the CLI', () => {
		expect(CLI_ACCESS_PATHS).toEqual(['/api/admin/puzzles']);
		expect(buildCliAccessDestinations('perseus.cwchanap.dev')).toEqual([
			{ type: 'public', uri: 'perseus.cwchanap.dev/api/admin/puzzles' }
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

describe('normalizeAdminAccessEmail', () => {
	it('trims a configured email address', () => {
		expect(normalizeAdminAccessEmail(' admin@example.com ')).toBe('admin@example.com');
	});

	it('rejects a blank email address', () => {
		expect(() => normalizeAdminAccessEmail('   ')).toThrow(/adminAccessEmail must not be empty/);
	});

	it('rejects a malformed email address', () => {
		expect(() => normalizeAdminAccessEmail('not-an-email')).toThrow(
			/adminAccessEmail must be a single email address/
		);
	});

	it('rejects multiple email addresses', () => {
		expect(() => normalizeAdminAccessEmail('admin@example.com,other@example.com')).toThrow(
			/adminAccessEmail must be a single email address/
		);
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

	it('uses a normalized admin email in the Access policy', () => {
		const args = buildAdminAccessApplicationArgs({
			accountId: 'account-id',
			hostname: 'https://perseus.cwchanap.dev',
			adminEmail: ' admin@example.com ',
			postureRuleId: 'posture-rule-id'
		});

		expect(args.policies).toEqual([
			expect.objectContaining({
				includes: [{ email: { email: 'admin@example.com' } }]
			})
		]);
	});
});

describe('buildAdminCliServiceAuthPolicy', () => {
	it('uses non_identity decision for service token auth', () => {
		expect(buildAdminCliServiceAuthPolicy('service-token-id')).toEqual({
			name: 'Service token for admin CLI uploads',
			decision: 'non_identity',
			precedence: 2,
			includes: [{ serviceToken: { tokenId: 'service-token-id' } }]
		});
	});
});

describe('buildCliServiceTokenArgs', () => {
	it('uses the default duration when cliServiceTokenDuration is not provided', () => {
		expect(buildCliServiceTokenArgs({ accountId: 'account-id' })).toEqual({
			accountId: 'account-id',
			name: 'Perseus Admin CLI',
			duration: DEFAULT_ADMIN_CLI_SERVICE_TOKEN_DURATION
		});
	});

	it('passes a configured cliServiceTokenDuration through to the token resource', () => {
		expect(
			buildCliServiceTokenArgs({
				accountId: 'account-id',
				cliServiceTokenDuration: '720h'
			})
		).toEqual({
			accountId: 'account-id',
			name: 'Perseus Admin CLI',
			duration: '720h'
		});
	});

	it('uses the default duration when cliServiceTokenDuration is undefined', () => {
		expect(
			buildCliServiceTokenArgs({
				accountId: 'account-id',
				cliServiceTokenDuration: undefined
			})
		).toEqual({
			accountId: 'account-id',
			name: 'Perseus Admin CLI',
			duration: DEFAULT_ADMIN_CLI_SERVICE_TOKEN_DURATION
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
				{ type: 'public', uri: 'perseus.cwchanap.dev/admin' },
				{ type: 'public', uri: 'perseus.cwchanap.dev/admin/*' },
				{ type: 'public', uri: 'perseus.cwchanap.dev/api/admin' },
				{ type: 'public', uri: 'perseus.cwchanap.dev/api/admin/*' }
			],
			sessionDuration: DEFAULT_ADMIN_ACCESS_SESSION_DURATION,
			appLauncherVisible: false,
			allowAuthenticateViaWarp: false,
			enableBindingCookie: true,
			httpOnlyCookieAttribute: true,
			pathCookieAttribute: false,
			sameSiteCookieAttribute: 'lax',
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

	it('does not include a Service Auth policy (CLI token is scoped to the narrow app)', () => {
		const args = buildAdminAccessApplicationArgs({
			accountId: 'account-id',
			hostname: 'perseus.cwchanap.dev',
			adminEmail: 'admin@example.com',
			postureRuleId: 'posture-rule-id'
		});

		expect(args.policies).toHaveLength(1);
		expect(args.policies?.[0]?.decision).toBe('allow');
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

	it('derives path-scoped destinations from the production redirect origin', () => {
		const args = buildAdminAccessApplicationArgs({
			accountId: 'account-id',
			hostname: 'https://perseus.cwchanap.dev',
			adminEmail: 'admin@example.com',
			postureRuleId: 'posture-rule-id'
		});

		expect(args.domain).toBe('perseus.cwchanap.dev/admin');
		expect(args.destinations).toEqual([
			{ type: 'public', uri: 'perseus.cwchanap.dev/admin' },
			{ type: 'public', uri: 'perseus.cwchanap.dev/admin/*' },
			{ type: 'public', uri: 'perseus.cwchanap.dev/api/admin' },
			{ type: 'public', uri: 'perseus.cwchanap.dev/api/admin/*' }
		]);
	});
});

describe('buildCliAccessApplicationArgs', () => {
	it('builds a narrow app scoped to CLI paths with both policies', () => {
		const args = buildCliAccessApplicationArgs({
			accountId: 'account-id',
			hostname: 'https://perseus.cwchanap.dev',
			adminEmail: 'admin@example.com',
			postureRuleId: 'posture-rule-id',
			cliServiceTokenId: 'cli-token-id'
		});

		expect(args.name).toBe('Perseus Admin CLI');
		expect(args.domain).toBe('perseus.cwchanap.dev/api/admin/puzzles');
		expect(args.destinations).toEqual([
			{ type: 'public', uri: 'perseus.cwchanap.dev/api/admin/puzzles' }
		]);
		expect(args.sameSiteCookieAttribute).toBe('lax');
		expect(args.policies).toHaveLength(2);
		// Policy 1: email + posture (browser admin still works on these paths)
		expect(args.policies?.[0]).toEqual(
			expect.objectContaining({
				decision: 'allow',
				includes: [{ email: { email: 'admin@example.com' } }]
			})
		);
		// Policy 2: Service Auth (CLI service token)
		expect(args.policies?.[1]).toEqual({
			name: 'Service token for admin CLI uploads',
			decision: 'non_identity',
			precedence: 2,
			includes: [{ serviceToken: { tokenId: 'cli-token-id' } }]
		});
	});

	it('uses a configured session duration when provided', () => {
		const args = buildCliAccessApplicationArgs({
			accountId: 'account-id',
			hostname: 'perseus.cwchanap.dev',
			adminEmail: 'admin@example.com',
			postureRuleId: 'posture-rule-id',
			cliServiceTokenId: 'cli-token-id',
			sessionDuration: '4h'
		});

		expect(args.sessionDuration).toBe('4h');
	});
});
