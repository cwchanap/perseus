import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(__dirname, '../../../.github/workflows/deploy-infrastructure.yml');
const workflow = readFileSync(workflowPath, 'utf8');

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

// Asserts a Pulumi config-map secret block appears exactly twice (preview + deploy):
//   <key>:
//     value: ${{ secrets.<NAME> }}
//     secret: true
// Handles both quoted ('${{ ... }}') and unquoted value forms.
function expectSecretBlock(key: string, secretName: string): void {
	const unquoted = new RegExp(
		`${key}:\\s*\\n\\s*value:\\s*\\$\\{\\{\\s*secrets\\.${secretName}\\s*\\}\\}\\s*\\n\\s*secret:\\s*true`,
		'g'
	);
	const quoted = new RegExp(
		`${key}:\\s*\\n\\s*value:\\s*'\\$\\{\\{\\s*secrets\\.${secretName}\\s*\\}\\}'\\s*\\n\\s*secret:\\s*true`,
		'g'
	);
	const matches = [...(workflow.match(unquoted) ?? []), ...(workflow.match(quoted) ?? [])];
	expect(matches).toHaveLength(2);
}

// Asserts a Pulumi config-map non-secret var block appears exactly twice:
//   <key>:
//     value: ${{ vars.<NAME> }}
// The negative lookahead confirms no `secret: true` follows — catching the
// 8a7e3e0-class regression where a value is swapped between vars/secrets.
function expectVarBlock(key: string, varName: string): void {
	const pattern = new RegExp(
		`${key}:\\s*\\n\\s*value:\\s*\\$\\{\\{\\s*vars\\.${varName}\\s*\\}\\}\\s*\\n(?!\\s*secret:)`,
		'g'
	);
	const matches = workflow.match(pattern) ?? [];
	expect(matches).toHaveLength(2);
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
		// Every secrets.* reference must be part of a block with secret: true.
		// Find all secrets.* references and confirm each is followed by secret: true
		// within the same config block.
		const secretRefPattern =
			/value:\s*'?\$\{\{\s*secrets\.(\w+)\s*\}\}'?\s*\n\s*(secret:\s*true)?/g;
		let match: RegExpExecArray | null;
		while ((match = secretRefPattern.exec(workflow)) !== null) {
			expect(match[2], `secrets.${match[1]} block missing secret: true`).toBeDefined();
		}
	});

	it('does not reference d1DatabaseImportId (removed after import completed)', () => {
		expect(countOccurrences(workflow, 'd1DatabaseImportId')).toBe(0);
	});
});
