/**
 * Validate the output of `playwright install --dry-run --only-shell chromium webkit`.
 *
 * The `--only-shell` flag resolves `chromium` to `chromium-headless-shell`. This
 * parser asserts that resolution happened (headless shell present, full chromium
 * absent) and that `webkit` is present. Version numbers and download URLs are
 * intentionally ignored — only the `browser:` token is keyed off, so changes to
 * Playwright build numbers or CDN paths do not break the assertion.
 */

const REQUIRED = ['chromium-headless-shell', 'webkit'] as const;
/** A full Chromium download is a CI footprint we did not opt into. */
const FORBIDDEN = ['chromium'] as const;

const BROWSER_LINE = /^browser:\s+(\S+)/gm;

/** Extract the set of browser tokens declared by `playwright install --dry-run`. */
export function parseBrowsers(output: string): string[] {
	const found: string[] = [];
	for (const match of output.matchAll(BROWSER_LINE)) {
		const name = match[1];
		if (name && !found.includes(name)) {
			found.push(name);
		}
	}
	return found;
}

/**
 * Assert the dry-run output declares chromium-headless-shell + webkit and no full
 * chromium browser. Returns the parsed browser names on success; throws with a
 * diagnostic message listing every unmet expectation otherwise.
 */
export function assertBrowserInstall(output: string): { browsers: string[] } {
	const browsers = parseBrowsers(output);

	if (browsers.length === 0) {
		throw new Error(
			'assertBrowserInstall: no `browser:` entries parsed from dry-run output ' +
				'(expected chromium-headless-shell + webkit)'
		);
	}

	const problems: string[] = [];

	for (const required of REQUIRED) {
		if (!browsers.includes(required)) {
			problems.push(`missing required browser "${required}"`);
		}
	}

	for (const forbidden of FORBIDDEN) {
		if (browsers.includes(forbidden)) {
			problems.push(
				`unexpected full browser "${forbidden}" (--only-shell should resolve to ` +
					`"${forbidden}-headless-shell")`
			);
		}
	}

	if (problems.length > 0) {
		throw new Error(
			`assertBrowserInstall: dry-run output did not match contract:\n  - ` +
				`${problems.join('\n  - ')}\n  found: [${browsers.join(', ')}]`
		);
	}

	return { browsers };
}

async function readStdin(): Promise<string> {
	return await Bun.readableStreamToText(Bun.stdin.stream());
}

async function main(): Promise<void> {
	let output: string;
	if (process.argv[2]) {
		output = process.argv[2];
	} else if (!process.stdin.isTTY) {
		output = await readStdin();
	} else {
		console.error(
			'assertBrowserInstall: pipe `playwright install --dry-run` output via ' +
				'stdin or pass it as the first argument'
		);
		process.exit(2);
	}

	const result = assertBrowserInstall(output);
	console.log(`assertBrowserInstall: OK — declared browsers [${result.browsers.join(', ')}]`);
}

if (import.meta.main) {
	void main();
}
