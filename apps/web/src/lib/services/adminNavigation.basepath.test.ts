import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/paths', () => ({
	// kit 3 no longer types `base`; adminNavigation derives it from resolve('/'),
	// so the mock reproduces a prefixed resolver instead.
	resolve: (path: string, params?: Record<string, string>) => {
		const resolved = params ? path.replace(/\[(\w+)\]/g, (_, key) => params[key] ?? '') : path;
		return `/myapp${resolved}`;
	}
}));

import { buildAdminDocumentHref, isClientRoutedAdminPath, stripBase } from './adminNavigation';

describe('admin navigation with non-empty base path', () => {
	describe('stripBase', () => {
		it('strips the configured base prefix', () => {
			expect(stripBase('/myapp/admin')).toBe('/admin');
			expect(stripBase('/myapp/admin/puzzles')).toBe('/admin/puzzles');
			expect(stripBase('/myapp/puzzle/abc')).toBe('/puzzle/abc');
		});

		it('returns root when pathname equals base', () => {
			expect(stripBase('/myapp')).toBe('/');
		});

		it('returns pathname unchanged when it does not start with base', () => {
			expect(stripBase('/admin')).toBe('/admin');
			expect(stripBase('/puzzle/abc')).toBe('/puzzle/abc');
			expect(stripBase('/')).toBe('/');
		});
	});

	describe('isClientRoutedAdminPath', () => {
		it('detects admin paths with base prefix', () => {
			expect(isClientRoutedAdminPath('/myapp/admin', '/myapp/gallery')).toBe(true);
			expect(isClientRoutedAdminPath('/myapp/admin/settings', '/myapp/puzzle/abc')).toBe(true);
		});

		it('does not force reloads for intra-admin navigation with base prefix', () => {
			expect(isClientRoutedAdminPath('/myapp/admin', '/myapp/admin')).toBe(false);
			expect(isClientRoutedAdminPath('/myapp/admin/settings', '/myapp/admin')).toBe(false);
			expect(isClientRoutedAdminPath('/myapp/admin/settings', '/myapp/admin/puzzles')).toBe(false);
		});

		it('does not treat non-admin paths with base prefix as admin routes', () => {
			expect(isClientRoutedAdminPath('/myapp/administer', '/myapp/gallery')).toBe(false);
			expect(isClientRoutedAdminPath('/myapp/puzzle/admin', '/myapp/gallery')).toBe(false);
		});
	});

	describe('buildAdminDocumentHref', () => {
		it('avoids double-base when pathname already contains base', () => {
			expect(
				buildAdminDocumentHref({
					pathname: '/myapp/admin',
					search: '?next=%2Fadmin%2Fsettings',
					hash: '#panel'
				})
			).toBe('/myapp/admin?next=%2Fadmin%2Fsettings#panel');
		});

		it('prepends base when pathname does not contain base', () => {
			expect(
				buildAdminDocumentHref({
					pathname: '/admin',
					search: '?next=%2Fadmin%2Fsettings',
					hash: '#panel'
				})
			).toBe('/myapp/admin?next=%2Fadmin%2Fsettings#panel');
		});

		it('does not double-prefix when pathname equals base exactly', () => {
			expect(buildAdminDocumentHref({ pathname: '/myapp' })).toBe('/myapp');
		});
	});
});
