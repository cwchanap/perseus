import { base } from '$app/paths';

interface AdminNavigationUrl {
	pathname: string;
	search?: string;
	hash?: string;
}

function isAdminPath(pathname: string): boolean {
	return pathname === '/admin' || pathname.startsWith('/admin/');
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

export function isClientRoutedAdminPath(
	currentPathname: string,
	initialDocumentPathname = getInitialDocumentPathname()
): boolean {
	if (!isAdminPath(currentPathname) || !initialDocumentPathname) return false;

	return !isAdminPath(initialDocumentPathname);
}

export function buildAdminDocumentHref(url: AdminNavigationUrl): string {
	return `${base}${url.pathname}${url.search ?? ''}${url.hash ?? ''}`;
}

export function forceAdminDocumentNavigation(url: AdminNavigationUrl): void {
	window.location.assign(buildAdminDocumentHref(url));
}
