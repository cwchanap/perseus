import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertNoE2EHarness } from './assert-no-e2e-harness';

const SENTINELS = [
	'__PERSEUS_E2E_GAMEPLAY_V1__',
	'e2e-square-4',
	'PERSEUS_E2E_CONFIG:',
	'e2e-gameplay-runtime.ts'
] as const;

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'perseus-scanner-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeNested(relativePath: string, content: string): Promise<string> {
	const abs = join(dir, relativePath);
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, content, 'utf8');
	return abs;
}

async function rejectionMessage(buildDirectory: string): Promise<string> {
	try {
		await assertNoE2EHarness(buildDirectory);
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
	throw new Error('expected assertNoE2EHarness to reject, but it resolved');
}

describe('assertNoE2EHarness', () => {
	it('rejects when the build directory does not exist', async () => {
		const missing = join(dir, 'does-not-exist');
		await expect(assertNoE2EHarness(missing)).rejects.toThrow();
	});

	it('rejects when the build directory is empty', async () => {
		await expect(assertNoE2EHarness(dir)).rejects.toThrow();
	});

	it('rejects when the build directory has no JavaScript files', async () => {
		await writeNested('index.html', '<html></html>');
		await writeNested('style.css', 'body { color: red; }');
		await expect(assertNoE2EHarness(dir)).rejects.toThrow();
	});

	it('rejects when a JavaScript file is unreadable', async () => {
		const abs = await writeNested('locked.js', 'console.log("hi");\n');
		await chmod(abs, 0o000);
		try {
			await expect(assertNoE2EHarness(dir)).rejects.toThrow();
		} finally {
			await chmod(abs, 0o644);
		}
	});

	it('rejects when a nested directory is unreadable, naming the directory', async () => {
		const locked = join(dir, 'locked');
		await mkdir(locked);
		await writeFile(join(locked, 'chunk.js'), 'export const x = 1;\n', 'utf8');
		await chmod(locked, 0o000);
		try {
			const message = await rejectionMessage(dir);
			expect(message).toContain('unreadable directory');
			expect(message).toContain('locked');
		} finally {
			await chmod(locked, 0o755);
		}
	});

	it('rejects when total bytes scanned is zero (empty js file)', async () => {
		await writeNested('empty.js', '');
		await expect(assertNoE2EHarness(dir)).rejects.toThrow();
	});

	it.each(SENTINELS)('rejects when output contains sentinel %s', async (sentinel) => {
		await writeNested('nested/app.js', `var x = ${JSON.stringify(sentinel)};\n`);
		const message = await rejectionMessage(dir);
		expect(message).toContain(sentinel);
		expect(message).toContain('app.js');
	});

	it('reports every sentinel match across files', async () => {
		await writeNested('a.js', `var a = ${JSON.stringify(SENTINELS[0])};\n`);
		await writeNested('nested/b.js', `var b = ${JSON.stringify(SENTINELS[2])};\n`);
		const message = await rejectionMessage(dir);
		expect(message).toContain(SENTINELS[0]);
		expect(message).toContain(SENTINELS[2]);
		expect(message).toContain('a.js');
		expect(message).toContain('b.js');
	});

	it('passes and returns positive counts for clean nested JavaScript', async () => {
		const a = 'export const meaning = 42;\n';
		const b = 'export function add(n, m) { return n + m; }\n';
		await writeNested('entry.js', a);
		await writeNested('nested/chunk.js', b);
		const result = await assertNoE2EHarness(dir);
		expect(result.filesScanned).toBe(2);
		expect(result.bytesScanned).toBe(Buffer.byteLength(a, 'utf8') + Buffer.byteLength(b, 'utf8'));
	});
});
