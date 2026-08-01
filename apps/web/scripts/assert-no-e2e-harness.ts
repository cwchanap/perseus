import { readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const SENTINELS = [
	'__PERSEUS_E2E_GAMEPLAY_V1__',
	'e2e-square-4',
	'PERSEUS_E2E_CONFIG:',
	'e2e-gameplay-runtime.ts'
] as const;

async function findJsFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	const stack: string[] = [dir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = resolve(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile() && entry.name.endsWith('.js')) {
				out.push(full);
			}
		}
	}
	return out.sort();
}

/**
 * Verify a production build directory contains no E2E harness code.
 *
 * Recursively scans every `.js` file under `buildDirectory` for known harness
 * sentinels and throws if any are found, or if the build is vacuous (missing,
 * empty, no JavaScript, unreadable files, or zero bytes). Returns the count of
 * files and bytes scanned on success.
 */
export async function assertNoE2EHarness(buildDirectory: string): Promise<{
	filesScanned: number;
	bytesScanned: number;
}> {
	const root = resolve(buildDirectory);

	try {
		const rootStat = await stat(root);
		if (!rootStat.isDirectory()) {
			throw new Error(`not a directory: ${root}`);
		}
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(`assertNoE2EHarness: build directory not readable: ${root} (${reason})`);
	}

	const jsFiles = await findJsFiles(root);
	if (jsFiles.length === 0) {
		throw new Error(`assertNoE2EHarness: no JavaScript files found under ${root}`);
	}

	let bytesScanned = 0;
	const matches: string[] = [];

	for (const file of jsFiles) {
		let buf;
		try {
			buf = await readFile(file);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			throw new Error(`assertNoE2EHarness: unreadable file ${relative(root, file)}: ${reason}`);
		}
		bytesScanned += buf.length;

		const contents = buf.toString('utf8');
		for (const sentinel of SENTINELS) {
			if (contents.includes(sentinel)) {
				matches.push(`${relative(root, file)} contains "${sentinel}"`);
			}
		}
	}

	if (bytesScanned === 0) {
		throw new Error(
			`assertNoE2EHarness: build is vacuous (0 bytes) across ${jsFiles.length} file(s)`
		);
	}

	if (matches.length > 0) {
		throw new Error(
			`assertNoE2EHarness: E2E harness sentinels leaked into production bundle:\n  - ${matches.join('\n  - ')}`
		);
	}

	return { filesScanned: jsFiles.length, bytesScanned };
}

async function main(): Promise<void> {
	const arg = process.argv[2];
	const buildDir = arg ?? resolve(import.meta.dir, '..', 'build');
	const result = await assertNoE2EHarness(buildDir);
	console.log(
		`assertNoE2EHarness: OK — scanned ${result.filesScanned} file(s), ` +
			`${result.bytesScanned} byte(s) under ${buildDir}`
	);
}

if (import.meta.main) {
	void main();
}
