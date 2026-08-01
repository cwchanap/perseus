import { describe, expect, it } from 'bun:test';
import { assertBrowserInstall } from './assert-browser-install';

/**
 * Realistic synthetic `playwright install --dry-run --only-shell chromium webkit`
 * output, modelled on the actual Playwright 1.57 format. Version numbers and
 * URLs are intentionally varied across fixtures to verify the parser tolerates
 * changes in those fields (it should only key off the `browser:` token).
 */
function dryRun(browsers: string[]): string {
	return browsers
		.map((name, i) => {
			const build = 1200 + i * 10;
			const version = `${140 + i}.0.0.0`;
			if (name === 'ffmpeg') {
				return (
					`browser: ffmpeg\n` +
					`  Install location:    /users/x/Library/Caches/ms-playwright/ffmpeg-${build}\n` +
					`  Download url:        https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/${build}/ffmpeg-mac-arm64.zip\n`
				);
			}
			return (
				`browser: ${name} version ${version}\n` +
				`  Install location:    /users/x/Library/Caches/ms-playwright/${name.replace(/-/g, '_')}-${build}\n` +
				`  Download url:        https://cdn.playwright.dev/dbazure/download/playwright/builds/${name}/${build}/${name}-mac-arm64.zip\n` +
				`  Download fallback 1: https://playwright.download.prss.microsoft.com/dbazure/download/playwright/builds/${name}/${build}/${name}-mac-arm64.zip\n`
			);
		})
		.join('\n');
}

const SHELL_AND_WEBKIT = dryRun(['chromium-headless-shell', 'ffmpeg', 'webkit']);

async function rejectionMessage(output: string): Promise<string> {
	try {
		assertBrowserInstall(output);
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
	throw new Error('expected assertBrowserInstall to throw, but it did not');
}

describe('assertBrowserInstall', () => {
	it('passes when chromium-headless-shell and webkit are present', () => {
		const result = assertBrowserInstall(SHELL_AND_WEBKIT);
		expect(result.browsers).toContain('chromium-headless-shell');
		expect(result.browsers).toContain('webkit');
	});

	it('passes with different versions and download urls (tolerance)', () => {
		const variant = dryRun(['chromium-headless-shell', 'webkit'])
			.replace(/version \d+\.\d+\.\d+\.\d+/g, 'version 999.0.0.0')
			.replace(/builds\/\w+\//g, 'builds/9999/');
		const result = assertBrowserInstall(variant);
		expect(result.browsers).toContain('chromium-headless-shell');
		expect(result.browsers).toContain('webkit');
	});

	it('fails when a full chromium browser entry is present alongside headless shell', async () => {
		const output = `${SHELL_AND_WEBKIT}\nbrowser: chromium version 143.0.7499.4\n  Install location: /x/chromium-1200\n`;
		const message = await rejectionMessage(output);
		expect(message).toContain('chromium');
	});

	it('fails when only a full chromium entry exists (no headless shell)', async () => {
		const output = dryRun(['chromium', 'webkit']);
		await expect(() => assertBrowserInstall(output)).toThrow();
	});

	it('fails when webkit is missing', async () => {
		const output = dryRun(['chromium-headless-shell', 'ffmpeg']);
		const message = await rejectionMessage(output);
		expect(message).toContain('webkit');
	});

	it('fails when chromium-headless-shell is missing', async () => {
		const output = dryRun(['webkit', 'ffmpeg']);
		const message = await rejectionMessage(output);
		expect(message).toContain('chromium-headless-shell');
	});

	it('fails when output is empty', () => {
		expect(() => assertBrowserInstall('')).toThrow();
	});

	it('fails when output has no browser entries', () => {
		expect(() => assertBrowserInstall('playwright: no browsers to install\n')).toThrow();
	});

	it('does not treat chromium-headless-shell as a full chromium entry', () => {
		const result = assertBrowserInstall(SHELL_AND_WEBKIT);
		expect(result.browsers).not.toContain('chromium');
	});
});
