import * as cloudflare from '@pulumi/cloudflare';
import * as pulumi from '@pulumi/pulumi';

export const ADMIN_ACCESS_PATHS = ['/admin', '/admin/*', '/api/admin', '/api/admin/*'] as const;
export const DEFAULT_ADMIN_ACCESS_SESSION_DURATION = '12h';

const ADMIN_ACCESS_APPLICATION_NAME = 'Perseus Admin';
const ADMIN_ACCESS_POLICY_NAME = 'Allow configured admin on trusted device';

type AdminAccessDestination = cloudflare.types.input.ZeroTrustAccessApplicationDestination;
type AdminAccessApplicationPolicy = cloudflare.types.input.ZeroTrustAccessApplicationPolicy;
type AdminAccessApplicationArgs = cloudflare.ZeroTrustAccessApplicationArgs;
type AdminDeviceSerialItem = cloudflare.types.input.ZeroTrustListItem;

export interface BuildAdminAccessApplicationArgs {
	accountId: pulumi.Input<string>;
	hostname: string;
	adminEmail: pulumi.Input<string>;
	postureRuleId: pulumi.Input<string>;
	sessionDuration?: pulumi.Input<string>;
}

export interface CreateAdminAccessResourcesArgs {
	accountId: pulumi.Input<string>;
	hostname: pulumi.Input<string>;
	adminEmail: pulumi.Input<string>;
	deviceSerialsJson: pulumi.Input<string>;
	sessionDuration?: pulumi.Input<string>;
}

export interface AdminAccessResources {
	deviceSerialList: cloudflare.ZeroTrustList;
	devicePostureRule: cloudflare.ZeroTrustDevicePostureRule;
	application: cloudflare.ZeroTrustAccessApplication;
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
		return trimmed;
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

	const valueWithScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	const url = new URL(valueWithScheme);

	if (!url.hostname) {
		throw new Error('adminAccessHostname must include a hostname');
	}

	return url.host;
}

export function buildAdminAccessDestinations(hostname: string): AdminAccessDestination[] {
	const normalizedHostname = normalizeAdminAccessHostname(hostname);
	return ADMIN_ACCESS_PATHS.map((path) => ({
		type: 'public',
		uri: `https://${normalizedHostname}${path}`
	}));
}

export function buildAdminDeviceSerialItems(serials: string[]): AdminDeviceSerialItem[] {
	return serials.map((serial, index) => ({
		value: serial,
		description: `Perseus admin device ${index + 1}`
	}));
}

export function buildAdminAccessPolicy(
	adminEmail: pulumi.Input<string>,
	postureRuleId: pulumi.Input<string>
): AdminAccessApplicationPolicy {
	return {
		name: ADMIN_ACCESS_POLICY_NAME,
		decision: 'allow',
		precedence: 1,
		includes: [{ email: { email: adminEmail } }],
		requires: [{ devicePosture: { integrationUid: postureRuleId } }]
	};
}

export function buildAdminAccessApplicationArgs(
	args: BuildAdminAccessApplicationArgs
): AdminAccessApplicationArgs {
	const hostname = normalizeAdminAccessHostname(args.hostname);

	return {
		accountId: args.accountId,
		name: ADMIN_ACCESS_APPLICATION_NAME,
		type: 'self_hosted',
		domain: `${hostname}/admin`,
		destinations: buildAdminAccessDestinations(hostname),
		sessionDuration: args.sessionDuration ?? DEFAULT_ADMIN_ACCESS_SESSION_DURATION,
		appLauncherVisible: false,
		allowAuthenticateViaWarp: true,
		enableBindingCookie: true,
		httpOnlyCookieAttribute: true,
		pathCookieAttribute: true,
		policies: [buildAdminAccessPolicy(args.adminEmail, args.postureRuleId)]
	};
}

export function createAdminAccessResources(
	args: CreateAdminAccessResourcesArgs
): AdminAccessResources {
	const serials = pulumi.output(args.deviceSerialsJson).apply(parseAdminDeviceSerials);
	const hostname = pulumi.output(args.hostname).apply(normalizeAdminAccessHostname);

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

	const application = new cloudflare.ZeroTrustAccessApplication(
		'admin-access-application',
		{
			accountId: args.accountId,
			name: ADMIN_ACCESS_APPLICATION_NAME,
			type: 'self_hosted',
			domain: hostname.apply((value) => `${value}/admin`),
			destinations: hostname.apply(buildAdminAccessDestinations),
			sessionDuration: args.sessionDuration ?? DEFAULT_ADMIN_ACCESS_SESSION_DURATION,
			appLauncherVisible: false,
			allowAuthenticateViaWarp: true,
			enableBindingCookie: true,
			httpOnlyCookieAttribute: true,
			pathCookieAttribute: true,
			policies: [buildAdminAccessPolicy(args.adminEmail, devicePostureRule.id)]
		},
		{ dependsOn: devicePostureRule }
	);

	return {
		deviceSerialList,
		devicePostureRule,
		application
	};
}
