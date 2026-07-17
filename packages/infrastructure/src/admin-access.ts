import * as cloudflare from '@pulumi/cloudflare';
import * as pulumi from '@pulumi/pulumi';

export const ADMIN_ACCESS_PATHS = ['/admin', '/admin/*', '/api/admin', '/api/admin/*'] as const;
/**
 * Path prefixes the narrow CLI Access application protects. This is a
 * defense-in-depth FIRST layer: it limits which paths a service-token holder
 * can reach at the Cloudflare Access (network) gate. It is NOT the
 * authorization boundary — the Worker's app-layer authz enforces what a
 * service-token (non_identity) caller may actually do (login + puzzle
 * list/create). Do not rely on Access path matching alone to scope the token;
 * Cloudflare Access path semantics (prefix vs exact) should be confirmed
 * before treating this list as authoritative.
 */
export const CLI_ACCESS_PATHS = ['/api/admin/login', '/api/admin/puzzles'] as const;
export const DEFAULT_ADMIN_ACCESS_SESSION_DURATION = '12h';
/** Default lifetime for the non-interactive CLI service token (1 year). */
export const DEFAULT_ADMIN_CLI_SERVICE_TOKEN_DURATION = '8760h';

const ADMIN_ACCESS_APPLICATION_NAME = 'Perseus Admin';
const CLI_ACCESS_APPLICATION_NAME = 'Perseus Admin CLI';
const ADMIN_ACCESS_POLICY_NAME = 'Allow configured admin on trusted device';
const ADMIN_ACCESS_SERVICE_AUTH_POLICY_NAME = 'Service token for admin CLI uploads';
const ADMIN_ACCESS_EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const ADMIN_ACCESS_APP_FLAGS = {
	appLauncherVisible: false,
	allowAuthenticateViaWarp: false,
	enableBindingCookie: true,
	httpOnlyCookieAttribute: true,
	pathCookieAttribute: false
} as const;

type AdminAccessDestination = cloudflare.types.input.ZeroTrustAccessApplicationDestination;
type AdminAccessApplicationPolicy = cloudflare.types.input.ZeroTrustAccessApplicationPolicy;
type AdminAccessApplicationArgs = cloudflare.ZeroTrustAccessApplicationArgs;
type AdminDeviceSerialItem = cloudflare.types.input.ZeroTrustListItem;
type CliServiceTokenArgs = cloudflare.ZeroTrustAccessServiceTokenArgs;

export interface BuildAdminAccessApplicationArgs {
	accountId: pulumi.Input<string>;
	hostname: string;
	adminEmail: pulumi.Input<string>;
	postureRuleId: pulumi.Input<string>;
	sessionDuration?: pulumi.Input<string>;
}

export interface CreateAdminAccessResourcesArgs {
	accountId: pulumi.Input<string>;
	hostname: string;
	adminEmail: pulumi.Input<string>;
	deviceSerialsJson: pulumi.Input<string>;
	sessionDuration?: pulumi.Input<string>;
	cliServiceTokenDuration?: pulumi.Input<string>;
}

export interface AdminAccessResources {
	deviceSerialList: cloudflare.ZeroTrustList;
	devicePostureRule: cloudflare.ZeroTrustDevicePostureRule;
	application: cloudflare.ZeroTrustAccessApplication;
	/** Narrow Access app for CLI paths (login + puzzle list/create) with Service Auth. */
	cliApplication: cloudflare.ZeroTrustAccessApplication;
	/** Non-interactive service token for CLI/admin automation (client_id + client_secret). */
	cliServiceToken: cloudflare.ZeroTrustAccessServiceToken;
}

export function parseAdminDeviceSerials(rawValue: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawValue);
	} catch {
		throw new Error('adminDeviceSerials must be a JSON array string');
	}

	if (!Array.isArray(parsed)) {
		throw new Error('adminDeviceSerials must be a JSON array');
	}

	if (parsed.length === 0) {
		throw new Error('adminDeviceSerials must include at least one serial number');
	}

	const serials = parsed.map((entry) => {
		if (typeof entry !== 'string') {
			throw new Error('adminDeviceSerials entries must be non-empty strings');
		}
		const trimmed = entry.trim();
		if (!trimmed) {
			throw new Error('adminDeviceSerials entries must be non-empty strings');
		}
		return trimmed.toUpperCase();
	});

	if (new Set(serials).size !== serials.length) {
		throw new Error('adminDeviceSerials must not contain duplicate serial numbers');
	}

	return serials;
}

export function normalizeAdminAccessHostname(rawValue: string): string {
	const trimmed = rawValue.trim();
	if (!trimmed) {
		throw new Error('adminAccessHostname must not be empty');
	}

	const valueWithScheme = URL_SCHEME_PATTERN.test(trimmed) ? trimmed : `https://${trimmed}`;
	if (hasExplicitAuthorityPort(valueWithScheme)) {
		throw new Error('adminAccessHostname must not include a port');
	}

	const url = new URL(valueWithScheme);

	if (!url.hostname) {
		throw new Error('adminAccessHostname must include a hostname');
	}

	if (url.port) {
		throw new Error('adminAccessHostname must not include a port');
	}

	if (url.username || url.password) {
		throw new Error('adminAccessHostname must not include userinfo');
	}

	if (url.pathname !== '/') {
		throw new Error('adminAccessHostname must not include a path');
	}

	if (url.search) {
		throw new Error('adminAccessHostname must not include a query string');
	}

	if (url.hash) {
		throw new Error('adminAccessHostname must not include a fragment');
	}

	return url.hostname;
}

function hasExplicitAuthorityPort(valueWithScheme: string): boolean {
	// Caller guarantees valueWithScheme always has a scheme (normalizeAdminAccessHostname
	// prepends https:// if missing).
	const authority = valueWithScheme.slice(valueWithScheme.indexOf('//') + 2).split(/[/?#]/, 1)[0];
	const hostAuthority = authority.slice(authority.lastIndexOf('@') + 1);

	if (hostAuthority.startsWith('[')) {
		return /^\[[^\]]+\]:\d+$/.test(hostAuthority);
	}

	return /:\d+$/.test(hostAuthority);
}

export function buildAdminAccessDestinations(hostname: string): AdminAccessDestination[] {
	const normalizedHostname = normalizeAdminAccessHostname(hostname);
	return ADMIN_ACCESS_PATHS.map((path) => ({
		type: 'public',
		uri: `${normalizedHostname}${path}`
	}));
}

export function buildCliAccessDestinations(hostname: string): AdminAccessDestination[] {
	const normalizedHostname = normalizeAdminAccessHostname(hostname);
	return CLI_ACCESS_PATHS.map((path) => ({
		type: 'public',
		uri: `${normalizedHostname}${path}`
	}));
}

export function buildAdminDeviceSerialItems(serials: string[]): AdminDeviceSerialItem[] {
	return serials.map((serial, index) => ({
		value: serial,
		description: `Perseus admin device ${index + 1}`
	}));
}

export function normalizeAdminAccessEmail(rawValue: string): string {
	const trimmed = rawValue.trim();
	if (!trimmed) {
		throw new Error('adminAccessEmail must not be empty');
	}

	if (!ADMIN_ACCESS_EMAIL_PATTERN.test(trimmed)) {
		throw new Error('adminAccessEmail must be a single email address');
	}

	return trimmed;
}

function normalizeAdminAccessEmailInput(adminEmail: pulumi.Input<string>): pulumi.Input<string> {
	return typeof adminEmail === 'string'
		? normalizeAdminAccessEmail(adminEmail)
		: pulumi.output(adminEmail).apply(normalizeAdminAccessEmail);
}

export function buildAdminAccessPolicy(
	adminEmail: pulumi.Input<string>,
	postureRuleId: pulumi.Input<string>
): AdminAccessApplicationPolicy {
	const normalizedAdminEmail = normalizeAdminAccessEmailInput(adminEmail);

	return {
		name: ADMIN_ACCESS_POLICY_NAME,
		decision: 'allow',
		precedence: 1,
		includes: [{ email: { email: normalizedAdminEmail } }],
		requires: [{ devicePosture: { integrationUid: postureRuleId } }]
	};
}

/**
 * Service Auth policy for non-browser clients (scripts, CI).
 * Must use decision `non_identity` — embedding a service token in an `allow`
 * policy does not work (Cloudflare requires a separate Service Auth policy).
 * @see https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
 */
export function buildAdminCliServiceAuthPolicy(
	serviceTokenId: pulumi.Input<string>
): AdminAccessApplicationPolicy {
	return {
		name: ADMIN_ACCESS_SERVICE_AUTH_POLICY_NAME,
		decision: 'non_identity',
		precedence: 2,
		includes: [{ serviceToken: { tokenId: serviceTokenId } }]
	};
}

export function buildAdminAccessApplicationArgs(
	args: BuildAdminAccessApplicationArgs
): AdminAccessApplicationArgs {
	const hostname = normalizeAdminAccessHostname(args.hostname);
	const policies: AdminAccessApplicationPolicy[] = [
		buildAdminAccessPolicy(args.adminEmail, args.postureRuleId)
	];

	return {
		accountId: args.accountId,
		name: ADMIN_ACCESS_APPLICATION_NAME,
		type: 'self_hosted',
		domain: `${hostname}/admin`,
		destinations: buildAdminAccessDestinations(hostname),
		sessionDuration: args.sessionDuration ?? DEFAULT_ADMIN_ACCESS_SESSION_DURATION,
		...ADMIN_ACCESS_APP_FLAGS,
		policies
	};
}

/**
 * Args for the narrow CLI Access application. Includes both the email+posture
 * policy (so browser admin still works on these paths) and the Service Auth
 * policy (for the CLI service token).
 */
export interface BuildCliAccessApplicationArgs {
	accountId: pulumi.Input<string>;
	hostname: string;
	adminEmail: pulumi.Input<string>;
	postureRuleId: pulumi.Input<string>;
	cliServiceTokenId: pulumi.Input<string>;
	sessionDuration?: pulumi.Input<string>;
}

export function buildCliAccessApplicationArgs(
	args: BuildCliAccessApplicationArgs
): AdminAccessApplicationArgs {
	const hostname = normalizeAdminAccessHostname(args.hostname);
	const policies: AdminAccessApplicationPolicy[] = [
		buildAdminAccessPolicy(args.adminEmail, args.postureRuleId),
		buildAdminCliServiceAuthPolicy(args.cliServiceTokenId)
	];

	return {
		accountId: args.accountId,
		name: CLI_ACCESS_APPLICATION_NAME,
		type: 'self_hosted',
		domain: `${hostname}/api/admin/puzzles`,
		destinations: buildCliAccessDestinations(hostname),
		sessionDuration: args.sessionDuration ?? DEFAULT_ADMIN_ACCESS_SESSION_DURATION,
		...ADMIN_ACCESS_APP_FLAGS,
		policies
	};
}

export function buildCliServiceTokenArgs(args: {
	accountId: pulumi.Input<string>;
	cliServiceTokenDuration?: pulumi.Input<string>;
}): CliServiceTokenArgs {
	return {
		accountId: args.accountId,
		name: 'Perseus Admin CLI',
		duration: args.cliServiceTokenDuration ?? DEFAULT_ADMIN_CLI_SERVICE_TOKEN_DURATION
	};
}

export function createAdminAccessResources(
	args: CreateAdminAccessResourcesArgs
): AdminAccessResources {
	const serials = pulumi.output(args.deviceSerialsJson).apply(parseAdminDeviceSerials);
	const hostname = normalizeAdminAccessHostname(args.hostname);

	const deviceSerialList = new cloudflare.ZeroTrustList('admin-access-device-serials', {
		accountId: args.accountId,
		name: 'Perseus Admin Device Serials',
		type: 'SERIAL',
		description: 'Device serial numbers allowed to access Perseus admin routes',
		items: serials.apply(buildAdminDeviceSerialItems)
	});

	const devicePostureRule = new cloudflare.ZeroTrustDevicePostureRule(
		'admin-access-device-posture-rule',
		{
			accountId: args.accountId,
			name: 'Perseus Admin Device Serial Check',
			type: 'serial_number',
			description: 'Requires a device serial number from the Perseus admin device list',
			input: {
				id: deviceSerialList.id
			},
			schedule: '5m',
			expiration: '1h'
		},
		{ dependsOn: deviceSerialList }
	);

	// Non-interactive Access credentials for admin CLI / scripts (service token).
	// Browser admin still uses email + device posture; this token is Service Auth only.
	const cliServiceToken = new cloudflare.ZeroTrustAccessServiceToken(
		'admin-access-cli-service-token',
		buildCliServiceTokenArgs({
			accountId: args.accountId,
			cliServiceTokenDuration: args.cliServiceTokenDuration
		})
	);

	// Broad app: covers all admin paths with email+posture only (browser admin).
	const application = new cloudflare.ZeroTrustAccessApplication(
		'admin-access-application',
		buildAdminAccessApplicationArgs({
			accountId: args.accountId,
			hostname,
			adminEmail: args.adminEmail,
			postureRuleId: devicePostureRule.id,
			sessionDuration: args.sessionDuration
		}),
		{ dependsOn: [devicePostureRule] }
	);

	// Narrow app: protects CLI path prefixes (login + puzzle list/create) with
	// both email+posture (browser admin still works) and Service Auth (CLI
	// token). This is a defense-in-depth network gate only — the authoritative
	// authorization is enforced in the Worker (app-layer authz), which gates
	// what a service-token caller may actually perform. More specific Access
	// paths take precedence over the broad admin app, but the Access path list
	// is not the security boundary.
	const cliApplication = new cloudflare.ZeroTrustAccessApplication(
		'admin-access-cli-application',
		buildCliAccessApplicationArgs({
			accountId: args.accountId,
			hostname,
			adminEmail: args.adminEmail,
			postureRuleId: devicePostureRule.id,
			cliServiceTokenId: cliServiceToken.id,
			sessionDuration: args.sessionDuration
		}),
		{ dependsOn: [devicePostureRule, cliServiceToken] }
	);

	return {
		deviceSerialList,
		devicePostureRule,
		application,
		cliApplication,
		cliServiceToken
	};
}
