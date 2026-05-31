import { base } from '$app/paths';

interface AdminNavigationUrl {
	pathname: string;
	search?: string;
	hash?: string;
}

export function stripBase(pathname: string): string {
	if (base && pathname.startsWith(base)) {
		return pathname.slice(base.length) || '/';
	}
	return pathname;
}

function isAdminPath(pathname: string): boolean {
	const stripped = stripBase(pathname);
	return stripped === '/admin' || stripped.startsWith('/admin/');
}

export function getInitialDocumentPathname(): string | null {
	if (typeof window === 'undefined') return null;

	const [entry] = window.performance?.getEntriesByType?.('navigation') ?? [];
	const initialDocumentUrl = (entry as PerformanceNavigationTiming | undefined)?.name;
	if (!initialDocumentUrl) return null;

	try {
		return new URL(initialDocumentUrl).pathname;
	} catch {
		return null;
	}
}

// Best-effort UX guard to trigger Cloudflare Access edge challenge on SPA navigations
// into /admin. This is NOT the security boundary — the Access policy on /admin* and
// /api/admin* edge requests (plus app-level auth in auth.worker.ts) enforce access.
// If performance.getEntriesByType('navigation') is unavailable, this returns false and
// the SPA navigation proceeds without a reload; the edge will still challenge any
// subsequent API or document request.
export function isClientRoutedAdminPath(
	currentPathname: string,
	initialDocumentPathname = getInitialDocumentPathname()
): boolean {
	if (!isAdminPath(currentPathname) || !initialDocumentPathname) return false;

	return !isAdminPath(initialDocumentPathname);
}

export function buildAdminDocumentHref(url: AdminNavigationUrl): string {
	const pathname =
		base && (url.pathname.startsWith(base + '/') || url.pathname === base)
			? url.pathname
			: `${base}${url.pathname}`;
	return `${pathname}${url.search ?? ''}${url.hash ?? ''}`;
}

export function forceAdminDocumentNavigation(
	url: AdminNavigationUrl,
	assign: (href: string) => void = (href) => window.location.assign(href)
): void {
	assign(buildAdminDocumentHref(url));
}
