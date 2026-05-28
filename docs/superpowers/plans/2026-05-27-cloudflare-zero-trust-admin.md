# Cloudflare Zero Trust Admin Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Cloudflare Zero Trust Access protection for the production Perseus admin UI and admin API paths, with identity and device serials supplied through secrets.

**Architecture:** Add a focused infrastructure module that parses secret config, builds path-scoped Access destinations, creates the serial-number list, creates the WARP device posture rule, and creates the Access application with an embedded allow policy. Keep the existing Worker and admin passkey/session code unchanged. Wire the new Pulumi config through GitHub Actions and document the operator setup.

**Tech Stack:** Pulumi TypeScript, `@pulumi/cloudflare` v6, Cloudflare Zero Trust Access, Vitest, Bun, GitHub Actions.

---

## File Structure

- Create `packages/infrastructure/src/admin-access.ts`
  - Owns all Cloudflare Zero Trust Access resource creation for Perseus admin protection.
  - Exports pure helpers for parsing `adminDeviceSerials`, building destination URIs, and building policy objects so tests do not need real Cloudflare credentials.
  - Exports `createAdminAccessResources` for `src/index.ts`.

- Create `packages/infrastructure/src/admin-access.test.ts`
  - Covers secret serial parsing, destination path scoping, application argument construction, and policy shape.

- Create `packages/infrastructure/src/deploy-workflow.test.ts`
  - Reads `.github/workflows/deploy-infrastructure.yml` and verifies both preview and deploy pass `adminAccessEmail` and `adminDeviceSerials` from GitHub secrets.

- Create `packages/infrastructure/vitest.config.ts`
  - Adds a Node Vitest config for infrastructure-only tests.

- Modify `packages/infrastructure/package.json`
  - Adds `test`, `test:unit`, and `test:watch` scripts.
  - Adds `vitest` as a dev dependency.

- Modify `packages/infrastructure/tsconfig.json`
  - Excludes `src/**/*.test.ts` from build output while keeping production sources in `dist`.

- Modify `packages/infrastructure/src/index.ts`
  - Reads `adminAccessEmail`, `adminDeviceSerials`, and optional `adminAccessSessionDuration`.
  - Creates the Zero Trust resources.
  - Exports Access resource IDs.

- Modify `.github/workflows/deploy-infrastructure.yml`
  - Passes `ADMIN_ACCESS_EMAIL` and `ADMIN_DEVICE_SERIALS` GitHub secrets into Pulumi preview and deploy config.

- Modify `packages/infrastructure/README.md`
  - Documents secret config commands, GitHub secret names, deploy expectations, and manual verification.

---

### Task 1: Add Infrastructure Test Harness And Failing Zero Trust Tests

**Files:**

- Modify: `packages/infrastructure/package.json`
- Modify: `packages/infrastructure/tsconfig.json`
- Create: `packages/infrastructure/vitest.config.ts`
- Create: `packages/infrastructure/src/admin-access.test.ts`

- [ ] **Step 1: Add infrastructure test scripts**

Replace `packages/infrastructure/package.json` with:

```json
{
	"name": "@perseus/infrastructure",
	"version": "0.0.1",
	"private": true,
	"type": "module",
	"scripts": {
		"build": "tsc",
		"postinstall": "echo 'Skipping automatic pulumi install during dependency install'",
		"pulumi:install": "command -v pulumi > /dev/null 2>&1 && pulumi install || echo 'Skipping pulumi install: Pulumi CLI not found. Install from https://pulumi.com/docs/get-started/install'",
		"pulumi:preview": "pulumi preview",
		"pulumi:up": "pulumi up --yes",
		"pulumi:destroy": "pulumi destroy",
		"pulumi:refresh": "pulumi refresh",
		"check": "tsc --noEmit",
		"test": "vitest run",
		"test:unit": "vitest run",
		"test:watch": "vitest"
	},
	"dependencies": {
		"@pulumi/pulumi": "^3.144.0",
		"@pulumi/cloudflare": "^6.13.0"
	},
	"devDependencies": {
		"@types/node": "^22.10.0",
		"typescript": "^5.9.0",
		"vitest": "^4.0.18"
	}
}
```

- [ ] **Step 2: Keep test files out of the production TypeScript build**

Replace `packages/infrastructure/tsconfig.json` with:

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "NodeNext",
		"moduleResolution": "NodeNext",
		"strict": true,
		"esModuleInterop": true,
		"skipLibCheck": true,
		"forceConsistentCasingInFileNames": true,
		"outDir": "./dist",
		"rootDir": "./src",
		"declaration": true,
		"declarationMap": true,
		"sourceMap": true,
		"resolveJsonModule": true
	},
	"include": ["src/**/*"],
	"exclude": ["node_modules", "dist", "src/**/*.test.ts"]
}
```

- [ ] **Step 3: Add the Vitest config**

Create `packages/infrastructure/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
		requireAssertions: true
	}
});
```

- [ ] **Step 4: Add failing admin access unit tests**

Create `packages/infrastructure/src/admin-access.test.ts`:

```typescript
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
```

- [ ] **Step 5: Run the failing admin access tests**

Run:

```bash
cd packages/infrastructure && bun run test:unit -- src/admin-access.test.ts
```

Expected: FAIL because `packages/infrastructure/src/admin-access.ts` does not exist.

---

### Task 2: Implement The Admin Access Infrastructure Module

**Files:**

- Create: `packages/infrastructure/src/admin-access.ts`
- Test: `packages/infrastructure/src/admin-access.test.ts`

- [ ] **Step 1: Create the admin access module**

Create `packages/infrastructure/src/admin-access.ts`:

```typescript
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

	if (url.port) {
		throw new Error('adminAccessHostname must not include a port');
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
		allowAuthenticateViaWarp: false,
		enableBindingCookie: true,
		httpOnlyCookieAttribute: true,
		pathCookieAttribute: false,
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
			allowAuthenticateViaWarp: false,
			enableBindingCookie: true,
			httpOnlyCookieAttribute: true,
			pathCookieAttribute: false,
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
```

- [ ] **Step 2: Run the admin access tests**

Run:

```bash
cd packages/infrastructure && bun run test:unit -- src/admin-access.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the infrastructure build**

Run:

```bash
bun run build --filter=@perseus/infrastructure
```

Expected: PASS with TypeScript emitting `packages/infrastructure/dist/**`.

- [ ] **Step 4: Commit the infrastructure module and test harness**

Run:

```bash
git add packages/infrastructure/package.json \
	packages/infrastructure/tsconfig.json \
	packages/infrastructure/vitest.config.ts \
	packages/infrastructure/src/admin-access.ts \
	packages/infrastructure/src/admin-access.test.ts \
	bun.lock
git commit -m "feat(infra): add zero trust admin access module"
```

---

### Task 3: Wire Zero Trust Resources Into The Pulumi Stack

**Files:**

- Modify: `packages/infrastructure/src/index.ts`
- Test: `packages/infrastructure/src/admin-access.test.ts`

- [ ] **Step 1: Add a test for app args with the production redirect origin**

Append this test to `packages/infrastructure/src/admin-access.test.ts` inside the existing
`describe('buildAdminAccessApplicationArgs', () => {` block, after the test named
`uses a configured session duration when provided`:

```typescript
it('derives path-scoped destinations from the production redirect origin', () => {
	const args = buildAdminAccessApplicationArgs({
		accountId: 'account-id',
		hostname: 'https://perseus.cwchanap.dev',
		adminEmail: 'admin@example.com',
		postureRuleId: 'posture-rule-id'
	});

	expect(args.domain).toBe('perseus.cwchanap.dev/admin');
	expect(args.destinations).toEqual([
		{ type: 'public', uri: 'https://perseus.cwchanap.dev/admin' },
		{ type: 'public', uri: 'https://perseus.cwchanap.dev/admin/*' },
		{ type: 'public', uri: 'https://perseus.cwchanap.dev/api/admin' },
		{ type: 'public', uri: 'https://perseus.cwchanap.dev/api/admin/*' }
	]);
});
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
cd packages/infrastructure && bun run test:unit -- src/admin-access.test.ts
```

Expected: PASS.

- [ ] **Step 3: Wire the resources into the Pulumi entrypoint**

Replace `packages/infrastructure/src/index.ts` with:

```typescript
import * as pulumi from '@pulumi/pulumi';
import { createR2Bucket, createKVNamespace } from './resources.js';
import { createWorkflowsWorker, createApiWorker } from './workers.js';
import { naming, paths, accountId } from './config.js';
import {
	DEFAULT_ADMIN_ACCESS_SESSION_DURATION,
	createAdminAccessResources
} from './admin-access.js';

const config = new pulumi.Config();
const r2Bucket = createR2Bucket();
const kvNamespace = createKVNamespace();

const commonBindings = {
	kvNamespaces: [
		{
			binding: 'PUZZLE_METADATA',
			namespaceId: kvNamespace.id
		}
	],
	r2Buckets: [
		{
			binding: 'PUZZLES_BUCKET',
			bucketName: r2Bucket.name
		}
	],
	envVars: {
		NODE_ENV: 'production'
	}
};

const apiBindings = {
	envVars: {
		...commonBindings.envVars,
		ALLOWED_ORIGINS: config.require('ALLOWED_ORIGINS'),
		AUTH_REDIRECT_BASE_URL: config.require('AUTH_REDIRECT_BASE_URL')
	},
	secretVars: {
		JWT_SECRET: config.requireSecret('jwtSecret'),
		ADMIN_PASSKEY: config.requireSecret('adminPasskey'),
		GOOGLE_CLIENT_ID: config.requireSecret('googleClientId'),
		GOOGLE_CLIENT_SECRET: config.requireSecret('googleClientSecret')
	}
};

const workflowsWorker = createWorkflowsWorker({
	...commonBindings,
	durableObjects: [
		{
			binding: 'PUZZLE_METADATA_DO',
			className: 'PuzzleMetadataDO'
		}
	],
	workflows: [
		{
			binding: 'PUZZLE_WORKFLOW',
			workflowName: naming.workflow,
			className: 'PerseusWorkflow'
		}
	]
});

const apiWorker = createApiWorker(
	{
		...commonBindings,
		envVars: apiBindings.envVars,
		secretVars: apiBindings.secretVars
	},
	{
		directory: paths.webAssets
	},
	workflowsWorker
);

const adminAccess = createAdminAccessResources({
	accountId,
	hostname: config.require('AUTH_REDIRECT_BASE_URL'),
	adminEmail: config.requireSecret('adminAccessEmail'),
	deviceSerialsJson: config.requireSecret('adminDeviceSerials'),
	sessionDuration: config.get('adminAccessSessionDuration') ?? DEFAULT_ADMIN_ACCESS_SESSION_DURATION
});

export const r2BucketName = r2Bucket.name;
export const kvNamespaceId = kvNamespace.id;
export const workflowsWorkerName = workflowsWorker.workerName;
export const apiWorkerName = apiWorker.workerName;
export const adminAccessApplicationId = adminAccess.application.id;
export const adminAccessDevicePostureRuleId = adminAccess.devicePostureRule.id;
export const adminAccessDeviceSerialListId = adminAccess.deviceSerialList.id;
```

- [ ] **Step 4: Run infrastructure tests and build**

Run:

```bash
cd packages/infrastructure && bun run test:unit
bun run build --filter=@perseus/infrastructure
```

Expected: both commands PASS.

- [ ] **Step 5: Commit the Pulumi stack wiring**

Run:

```bash
git add packages/infrastructure/src/index.ts packages/infrastructure/src/admin-access.test.ts
git commit -m "feat(infra): wire zero trust admin access resources"
```

---

### Task 4: Wire GitHub Actions Secret Config

**Files:**

- Modify: `.github/workflows/deploy-infrastructure.yml`
- Create: `packages/infrastructure/src/deploy-workflow.test.ts`

- [ ] **Step 1: Add the failing workflow test**

Create `packages/infrastructure/src/deploy-workflow.test.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = resolve(process.cwd(), '../../.github/workflows/deploy-infrastructure.yml');
const workflow = readFileSync(workflowPath, 'utf8');

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe('deploy-infrastructure workflow', () => {
	it('passes Zero Trust admin secrets to both Pulumi preview and deploy', () => {
		expect(countOccurrences(workflow, 'adminAccessEmail:')).toBe(2);
		expect(countOccurrences(workflow, 'value: ${{ secrets.ADMIN_ACCESS_EMAIL }}')).toBe(2);
		expect(countOccurrences(workflow, 'secret: true')).toBeGreaterThanOrEqual(10);

		expect(countOccurrences(workflow, 'adminDeviceSerials:')).toBe(2);
		expect(countOccurrences(workflow, 'value: ${{ secrets.ADMIN_DEVICE_SERIALS }}')).toBe(2);
	});
});
```

- [ ] **Step 2: Run the workflow test and verify it fails**

Run:

```bash
cd packages/infrastructure && bun run test:unit -- src/deploy-workflow.test.ts
```

Expected: FAIL because the workflow does not yet contain `adminAccessEmail` or `adminDeviceSerials`.

- [ ] **Step 3: Add the new config to the preview job**

In `.github/workflows/deploy-infrastructure.yml`, inside the preview job `config-map`, immediately after `AUTH_REDIRECT_BASE_URL`, add:

```yaml
adminAccessEmail:
  value: ${{ secrets.ADMIN_ACCESS_EMAIL }}
  secret: true
adminDeviceSerials:
  value: ${{ secrets.ADMIN_DEVICE_SERIALS }}
  secret: true
```

The preview `config-map` block should contain this sequence:

```yaml
ALLOWED_ORIGINS:
  value: ${{ secrets.ALLOWED_ORIGINS }}
AUTH_REDIRECT_BASE_URL:
  value: ${{ secrets.AUTH_REDIRECT_BASE_URL }}
adminAccessEmail:
  value: ${{ secrets.ADMIN_ACCESS_EMAIL }}
  secret: true
adminDeviceSerials:
  value: ${{ secrets.ADMIN_DEVICE_SERIALS }}
  secret: true
jwtSecret:
  value: ${{ secrets.JWT_SECRET }}
  secret: true
```

- [ ] **Step 4: Add the new config to the deploy job**

In `.github/workflows/deploy-infrastructure.yml`, inside the deploy job `config-map`, immediately after `AUTH_REDIRECT_BASE_URL`, add:

```yaml
adminAccessEmail:
  value: ${{ secrets.ADMIN_ACCESS_EMAIL }}
  secret: true
adminDeviceSerials:
  value: ${{ secrets.ADMIN_DEVICE_SERIALS }}
  secret: true
```

The deploy `config-map` block should contain this sequence:

```yaml
ALLOWED_ORIGINS:
  value: ${{ secrets.ALLOWED_ORIGINS }}
AUTH_REDIRECT_BASE_URL:
  value: ${{ secrets.AUTH_REDIRECT_BASE_URL }}
adminAccessEmail:
  value: ${{ secrets.ADMIN_ACCESS_EMAIL }}
  secret: true
adminDeviceSerials:
  value: ${{ secrets.ADMIN_DEVICE_SERIALS }}
  secret: true
jwtSecret:
  value: ${{ secrets.JWT_SECRET }}
  secret: true
```

- [ ] **Step 5: Run the workflow test**

Run:

```bash
cd packages/infrastructure && bun run test:unit -- src/deploy-workflow.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run all infrastructure tests and build**

Run:

```bash
cd packages/infrastructure && bun run test:unit
bun run build --filter=@perseus/infrastructure
```

Expected: both commands PASS.

- [ ] **Step 7: Commit the workflow wiring**

Run:

```bash
git add .github/workflows/deploy-infrastructure.yml \
	packages/infrastructure/src/deploy-workflow.test.ts
git commit -m "ci: pass zero trust admin secrets to pulumi"
```

---

### Task 5: Document Configuration And Verification

**Files:**

- Modify: `packages/infrastructure/README.md`

- [ ] **Step 1: Add Zero Trust config documentation**

In `packages/infrastructure/README.md`, after the existing secrets configuration block, add:

````markdown
### Zero Trust Admin Protection

The production admin portal is protected by a Cloudflare Zero Trust Access application
managed by Pulumi. The Access app covers only:

- `https://perseus.cwchanap.dev/admin`
- `https://perseus.cwchanap.dev/admin/*`
- `https://perseus.cwchanap.dev/api/admin`
- `https://perseus.cwchanap.dev/api/admin/*`

The public puzzle routes and player auth routes remain outside this Access app.

Configure the required admin Access values as Pulumi secrets:

```bash
cd packages/infrastructure
pulumi config set --secret adminAccessEmail "you@example.com"
pulumi config set --secret adminDeviceSerials '["DEVICE_SERIAL_1","DEVICE_SERIAL_2"]'
```

`adminDeviceSerials` must be a JSON array string. To add or remove a trusted device,
update that secret value and redeploy infrastructure.

The Access session duration defaults to `12h`. To change it:

```bash
cd packages/infrastructure
pulumi config set adminAccessSessionDuration 4h
```

GitHub Actions deploys require these repository secrets:

- `ADMIN_ACCESS_EMAIL`
- `ADMIN_DEVICE_SERIALS`

`ADMIN_DEVICE_SERIALS` must use the same JSON array string format.

Manual verification after deploy:

- From the allowed WARP-enrolled device and matching identity, `/admin` reaches the existing
  Perseus passkey page.
- From a device without a passing serial-number posture check, `/admin` is denied by
  Cloudflare Access before Perseus loads.
- `/`, `/api/puzzles`, and `/api/auth/session` remain reachable without Cloudflare Access.
- After Cloudflare Access allows the request, the existing Perseus admin passkey still
  rejects invalid login attempts.
````

- [ ] **Step 2: Run formatting**

Run:

```bash
bun run format -- packages/infrastructure/README.md docs/superpowers/plans/2026-05-27-cloudflare-zero-trust-admin.md
```

Expected: PASS and Markdown remains readable.

- [ ] **Step 3: Run infrastructure tests and build**

Run:

```bash
cd packages/infrastructure && bun run test:unit
bun run build --filter=@perseus/infrastructure
```

Expected: both commands PASS.

- [ ] **Step 4: Commit the documentation**

Run:

```bash
git add packages/infrastructure/README.md
git commit -m "docs(infra): document zero trust admin config"
```

---

### Task 6: Final Verification And Deployment Preview

**Files:**

- No source changes expected.

- [ ] **Step 1: Run repository checks that cover touched areas**

Run:

```bash
cd packages/infrastructure && bun run test:unit
bun run build --filter=@perseus/infrastructure
bun run check --filter=@perseus/infrastructure
```

Expected: all commands PASS.

- [ ] **Step 2: Confirm no personal identifiers are committed**

Run:

```bash
rg -n "ADMIN_ACCESS_EMAIL|ADMIN_DEVICE_SERIALS|adminAccessEmail|adminDeviceSerials|DEVICE_SERIAL|you@example.com" \
	packages/infrastructure .github docs/superpowers/plans/2026-05-27-cloudflare-zero-trust-admin.md
```

Expected: output contains only config key names, GitHub secret names, README examples, and plan text. It must not contain a real email address or a real device serial number.

- [ ] **Step 3: Configure local Pulumi secrets before preview**

Run these commands with the real values:

```bash
cd packages/infrastructure
pulumi config set --secret adminAccessEmail "REAL_ADMIN_EMAIL"
pulumi config set --secret adminDeviceSerials '["REAL_DEVICE_SERIAL"]'
```

Expected: Pulumi stores both values as encrypted secrets in the selected stack.

- [ ] **Step 4: Run Pulumi preview**

Run:

```bash
cd packages/infrastructure
pulumi preview
```

Expected: preview shows creation or update of only the expected Zero Trust resources plus any unchanged existing resources:

- `cloudflare:index/zeroTrustList:ZeroTrustList`
- `cloudflare:index/zeroTrustDevicePostureRule:ZeroTrustDevicePostureRule`
- `cloudflare:index/zeroTrustAccessApplication:ZeroTrustAccessApplication`

If preview proposes deleting or replacing existing Worker, KV, R2, or workflow resources, stop and inspect the diff before deploying.

- [ ] **Step 5: Commit any final verification-only fixes**

If Step 1 or Step 4 required fixes, commit them:

```bash
git add packages/infrastructure .github/workflows/deploy-infrastructure.yml
git commit -m "fix(infra): finalize zero trust admin protection"
```

If no fixes were needed, do not create an empty commit.

---

## Manual Post-Deploy Verification

After a successful production deploy:

- Open `https://perseus.cwchanap.dev/admin` from the allowed WARP-enrolled device and matching identity.
- Confirm Cloudflare Access completes first and the existing Perseus passkey page appears.
- Enter an invalid Perseus admin passkey and confirm the app still returns the existing invalid-passkey behavior.
- Open `https://perseus.cwchanap.dev/`, `https://perseus.cwchanap.dev/api/puzzles`, and `https://perseus.cwchanap.dev/api/auth/session` without an Access session and confirm they are not protected by Cloudflare Access.
- Attempt `/admin` from a device that does not pass the serial-number posture check and confirm Cloudflare Access denies the request before the Perseus app loads.
