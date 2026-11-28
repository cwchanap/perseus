import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from '../relativeTime';

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);
const HOUR = 3_600_000;

describe('formatRelativeTime', () => {
	it('reports hours for logins earlier the same day instead of rounding up to a day', () => {
		expect(formatRelativeTime(NOW - 12 * HOUR, NOW)).toMatch(/12 hours ago/);
		expect(formatRelativeTime(NOW - 23 * HOUR, NOW)).toMatch(/23 hours ago/);
	});

	it('reports days once a full day has passed', () => {
		expect(formatRelativeTime(NOW - 24 * HOUR, NOW)).toMatch(/yesterday/);
		expect(formatRelativeTime(NOW - 72 * HOUR, NOW)).toMatch(/3 days ago/);
	});

	it('reports whole minutes and never less than one', () => {
		expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toMatch(/5 minutes ago/);
		expect(formatRelativeTime(NOW, NOW)).toMatch(/1 minute ago/);
	});
});
