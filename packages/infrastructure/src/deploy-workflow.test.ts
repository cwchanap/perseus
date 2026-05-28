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
