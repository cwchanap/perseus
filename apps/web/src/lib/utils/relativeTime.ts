const relativeFormatter =
	typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl
		? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
		: null;

/** Human "time ago" label for a past epoch-ms timestamp, e.g. "2 hours ago". */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
	const ms = now - timestamp;
	const minutes = Math.round(ms / 60_000);
	const hours = Math.round(ms / 3_600_000);
	const days = Math.round(ms / 86_400_000);

	if (!relativeFormatter) {
		if (days >= 1) return `${days}d ago`;
		if (hours >= 1) return `${hours}h ago`;
		return `${Math.max(1, minutes)}m ago`;
	}

	if (days >= 1) return relativeFormatter.format(-days, 'day');
	if (hours >= 1) return relativeFormatter.format(-hours, 'hour');
	return relativeFormatter.format(-Math.max(1, minutes), 'minute');
}
