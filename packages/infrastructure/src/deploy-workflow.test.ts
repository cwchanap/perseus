import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(__dirname, '../../../.github/workflows/deploy-infrastructure.yml');
const workflow = readFileSync(workflowPath, 'utf8');

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

interface ConfigEntry {
	value: string;
	secret?: boolean;
}
type ConfigMap = Record<string, ConfigEntry>;

interface WorkflowStep {
	name?: string;
	uses?: string;
	with?: Record<string, string>;
}
interface WorkflowJob {
	name?: string;
	steps: WorkflowStep[];
}
interface WorkflowDoc {
	jobs: Record<string, WorkflowJob>;
}

// Parse the workflow YAML once. The config-map is a block scalar containing
// nested YAML, so each job's config-map is parsed a second time to inspect
// its structure. This is robust against indentation/quote-style changes that
// would break regex-based assertions.
const workflowDoc = parse(workflow) as WorkflowDoc;

function getConfigMap(jobName: string): ConfigMap {
	const job = workflowDoc.jobs[jobName];
	if (!job) throw new Error(`job '${jobName}' not found in workflow`);
	const step = job.steps.find((s) => s.uses?.startsWith('pulumi/actions'));
	if (!step) throw new Error(`pulumi/actions step not found in job '${jobName}'`);
	const raw = step.with?.['config-map'];
	if (!raw) throw new Error(`config-map not found in pulumi/actions step of job '${jobName}'`);
	return parse(raw) as ConfigMap;
}

const previewConfig = getConfigMap('preview');
const deployConfig = getConfigMap('deploy');
const bothConfigs: Array<[string, ConfigMap]> = [
	['preview', previewConfig],
	['deploy', deployConfig]
];

// Asserts a key is present in both preview and deploy config-maps with a
// value referencing the given secret and `secret: true` set.
function expectSecretBlock(key: string, secretName: string): void {
	const valueRe = new RegExp(`\\$\\{\\{\\s*secrets\\.${secretName}\\s*\\}\\}`);
	for (const [jobName, cfg] of bothConfigs) {
		const entry = cfg[key];
		expect(entry, `${jobName}: config key '${key}' missing`).toBeDefined();
		expect(entry.value, `${jobName}: '${key}' value`).toMatch(valueRe);
		expect(entry.secret, `${jobName}: '${key}' must set secret: true`).toBe(true);
	}
}

// Asserts a key is present in both config-maps with a value referencing the
// given var and NO `secret: true` flag — catching the 8a7e3e0-class
// regression where a value is swapped between vars/secrets.
function expectVarBlock(key: string, varName: string): void {
	const valueRe = new RegExp(`\\$\\{\\{\\s*vars\\.${varName}\\s*\\}\\}`);
	for (const [jobName, cfg] of bothConfigs) {
		const entry = cfg[key];
		expect(entry, `${jobName}: config key '${key}' missing`).toBeDefined();
		expect(entry.value, `${jobName}: '${key}' value`).toMatch(valueRe);
		expect(entry.secret, `${jobName}: '${key}' must NOT set secret: true`).toBeUndefined();
	}
}

describe('deploy-infrastructure workflow', () => {
	describe('secret config values (secrets.* + secret: true)', () => {
		it('passes adminAccessEmail as a secret to both preview and deploy', () => {
			expectSecretBlock('adminAccessEmail', 'ADMIN_ACCESS_EMAIL');
		});

		it('passes adminDeviceSerials as a secret to both preview and deploy', () => {
			expectSecretBlock('adminDeviceSerials', 'ADMIN_DEVICE_SERIALS');
		});

		it('passes jwtSecret as a secret to both preview and deploy', () => {
			expectSecretBlock('jwtSecret', 'JWT_SECRET');
		});

		it('passes adminPasskey as a secret to both preview and deploy', () => {
			expectSecretBlock('adminPasskey', 'ADMIN_PASSKEY');
		});

		it('passes googleClientSecret as a secret to both preview and deploy', () => {
			expectSecretBlock('googleClientSecret', 'GOOGLE_CLIENT_SECRET');
		});
	});

	describe('non-secret var config values (vars.*, no secret: true)', () => {
		it('passes cloudflareAccountId as a var to both preview and deploy', () => {
			expectVarBlock('cloudflareAccountId', 'CLOUDFLARE_ACCOUNT_ID');
		});

		it('passes ALLOWED_ORIGINS as a var to both preview and deploy', () => {
			expectVarBlock('ALLOWED_ORIGINS', 'ALLOWED_ORIGINS');
		});

		it('passes AUTH_REDIRECT_BASE_URL as a var to both preview and deploy', () => {
			expectVarBlock('AUTH_REDIRECT_BASE_URL', 'AUTH_REDIRECT_BASE_URL');
		});

		it('passes googleClientId as a var to both preview and deploy', () => {
			expectVarBlock('googleClientId', 'GOOGLE_CLIENT_ID');
		});
	});

	it('does not reference any secrets.* without a corresponding secret: true', () => {
		// Every config-map entry whose value references secrets.* must have
		// secret: true set.
		const secretRefRe = /\$\{\{\s*secrets\.(\w+)\s*\}\}/;
		for (const [jobName, cfg] of bothConfigs) {
			for (const [key, entry] of Object.entries(cfg)) {
				const match = entry.value.match(secretRefRe);
				if (match) {
					expect(
						entry.secret,
						`${jobName}: '${key}' references secrets.${match[1]} but missing secret: true`
					).toBe(true);
				}
			}
		}
	});

	it('does not reference d1DatabaseImportId (removed after import completed)', () => {
		// Raw-text scan: the import ID could appear in comments or any field,
		// not just the YAML structure, so check the original file text.
		expect(countOccurrences(workflow, 'd1DatabaseImportId')).toBe(0);
	});

	it('preview and deploy config-maps have identical key sets', () => {
		// Catches drift where a config key is added to one job but not the
		// other (e.g. a new secret wired into deploy but forgotten in preview).
		expect(Object.keys(previewConfig).sort()).toEqual(Object.keys(deployConfig).sort());
	});
});
