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

describe('deploy-infrastructure workflow', () => {
	it('passes Zero Trust admin config to both Pulumi preview and deploy', () => {
		expect(countOccurrences(workflow, 'adminAccessEmail:')).toBe(2);
		expect(countOccurrences(workflow, 'value: ${{ vars.ADMIN_ACCESS_EMAIL }}')).toBe(2);
		const adminEmailMatches =
			workflow.match(
				/adminAccessEmail:\s*\n\s*value:\s*\$\{\{\s*vars\.ADMIN_ACCESS_EMAIL\s*\}\}\s*\n\s*secret:\s*true/g
			) ?? [];
		expect(adminEmailMatches).toHaveLength(2);

		expect(countOccurrences(workflow, 'adminDeviceSerials:')).toBe(2);
		expect(countOccurrences(workflow, "value: '${{ vars.ADMIN_DEVICE_SERIALS }}'")).toBe(2);
		const deviceSerialMatches =
			workflow.match(
				/adminDeviceSerials:\s*\n\s*value:\s*'\$\{\{\s*vars\.ADMIN_DEVICE_SERIALS\s*\}\}'\s*\n\s*secret:\s*true/g
			) ?? [];
		expect(deviceSerialMatches).toHaveLength(2);
	});
});
