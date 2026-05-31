import { describe, expect, it, vi } from 'vitest';
import {
	buildAdminDocumentHref,
	forceAdminDocumentNavigation,
	getInitialDocumentPathname,
	isClientRoutedAdminPath,
	stripBase
} from './adminNavigation';

describe('admin navigation guard', () => {
	it('detects a client-side transition from a public document into admin', () => {
		expect(isClientRoutedAdminPath('/admin', '/')).toBe(true);
		expect(isClientRoutedAdminPath('/admin/settings', '/puzzle/abc')).toBe(true);
	});

	it('does not force reloads for direct admin document requests or intra-admin navigation', () => {
		expect(isClientRoutedAdminPath('/admin', '/admin')).toBe(false);
		expect(isClientRoutedAdminPath('/admin/settings', '/admin')).toBe(false);
		expect(isClientRoutedAdminPath('/admin/settings', '/admin/login')).toBe(false);
	});

	it('does not treat non-admin paths as admin routes', () => {
		expect(isClientRoutedAdminPath('/administer', '/')).toBe(false);
		expect(isClientRoutedAdminPath('/puzzle/admin', '/')).toBe(false);
	});

	it('leaves detection off when the document path is unavailable', () => {
		expect(isClientRoutedAdminPath('/admin', null)).toBe(false);
	});

	it('builds a document navigation href with query and hash intact', () => {
		expect(
			buildAdminDocumentHref({
				pathname: '/admin',
				search: '?next=%2Fadmin%2Fsettings',
				hash: '#panel'
			})
		).toBe('/admin?next=%2Fadmin%2Fsettings#panel');
	});

	it('builds a document navigation href without optional parts', () => {
		expect(buildAdminDocumentHref({ pathname: '/admin' })).toBe('/admin');
	});

	it('reads the initial browser document pathname from the navigation entry', () => {
		const navigationEntry = {
			name: 'https://perseus.cwchanap.dev/gallery?filter=all'
		} as PerformanceNavigationTiming;
		const spy = vi.spyOn(window.performance, 'getEntriesByType').mockReturnValue([navigationEntry]);

		expect(getInitialDocumentPathname()).toBe('/gallery');

		spy.mockRestore();
	});

	it('returns null when the navigation entry URL is unavailable or invalid', () => {
		const spy = vi
			.spyOn(window.performance, 'getEntriesByType')
			.mockReturnValue([{ name: 'not a valid url' } as PerformanceNavigationTiming]);

		expect(getInitialDocumentPathname()).toBeNull();

		spy.mockRestore();
	});

	it('forces a full document navigation for admin routes', () => {
		const assignMock = vi.fn();
		forceAdminDocumentNavigation(
			{ pathname: '/admin', search: '?next=1', hash: '#tab' },
			assignMock
		);
		expect(assignMock).toHaveBeenCalledWith('/admin?next=1#tab');
	});

	it('returns null when performance entries are unavailable', () => {
		const spy = vi.spyOn(window.performance, 'getEntriesByType').mockReturnValue([]);
		expect(getInitialDocumentPathname()).toBeNull();
		spy.mockRestore();
	});

	it('returns null when performance API is absent', () => {
		// @ts-expect-error testing undefined return from getEntriesByType
		const spy = vi.spyOn(window.performance, 'getEntriesByType').mockReturnValue(undefined);
		expect(getInitialDocumentPathname()).toBeNull();
		spy.mockRestore();
	});

	describe('stripBase (no base configured)', () => {
		it('returns pathname unchanged when no base is configured', () => {
			expect(stripBase('/admin')).toBe('/admin');
			expect(stripBase('/admin/login')).toBe('/admin/login');
			expect(stripBase('/')).toBe('/');
		});
	});
});
