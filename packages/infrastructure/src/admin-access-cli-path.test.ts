import { describe, expect, it } from 'vitest';
import {
	ADMIN_ACCESS_PATHS,
	CLI_ACCESS_PATHS,
	buildCliAccessApplicationArgs
} from './admin-access.js';

describe('admin CLI Access path isolation', () => {
	it('uses a dedicated CLI alias instead of the browser admin endpoint', () => {
		expect(CLI_ACCESS_PATHS).toEqual(['/api/admin/cli/puzzle-families']);
		expect(ADMIN_ACCESS_PATHS).toContain('/api/admin/*');

		const args = buildCliAccessApplicationArgs({
			accountId: 'account-id',
			hostname: 'https://perseus.cwchanap.dev',
			adminEmail: 'admin@example.com',
			postureRuleId: 'posture-rule-id',
			cliServiceTokenId: 'cli-token-id'
		});

		expect(args.domain).toBe('perseus.cwchanap.dev/api/admin/cli/puzzle-families');
		expect(args.destinations).toEqual([
			{ type: 'public', uri: 'perseus.cwchanap.dev/api/admin/cli/puzzle-families' }
		]);
	});
});
