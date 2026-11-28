const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** Human "time ago" label for a past epoch-ms timestamp, e.g. "2 hours ago". */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
	const ms = now - timestamp;
	const days = Math.floor(ms / 86_400_000);
	if (days >= 1) return formatter.format(-days, 'day');
	const hours = Math.floor(ms / 3_600_000);
	if (hours >= 1) return formatter.format(-hours, 'hour');
	return formatter.format(-Math.max(1, Math.floor(ms / 60_000)), 'minute');
}
