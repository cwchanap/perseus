import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// vi.hoisted runs before vi.mock's factory, so the mock fn is available
// inside the hoisted mock factory.
const { mockLink, getLinkCallCount, resetLinkCallCount } = vi.hoisted(() => {
	let linkCallCount = 0;
	return {
		mockLink: vi.fn(async (src: string, dest: string) => {
			linkCallCount++;
			if (linkCallCount === 1) {
				// First attempt: empty file exists → EEXIST.
				const err = new Error('EEXIST') as NodeJS.ErrnoException;
				err.code = 'EEXIST';
				throw err;
			}
			// Second attempt: simulate a concurrent writer having
			// published content between the rm and our retry.
			const { writeFile: wf } = await import('node:fs/promises');
			await wf(dest, 'puzzle-concurrent-winner');
			const err = new Error('EEXIST') as NodeJS.ErrnoException;
			err.code = 'EEXIST';
			throw err;
		}),
		getLinkCallCount: () => linkCallCount,
		resetLinkCallCount: () => {
			linkCallCount = 0;
		}
	};
});

vi.mock('node:fs/promises', async (importActual) => {
	const actual = await importActual<typeof import('node:fs/promises')>();
	return {
		...actual,
		link: mockLink
	};
});

// Import the real fs functions for test setup (these go through the mock,
// but only `link` is overridden — all others delegate to the real impl).
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';

let tempDir: string;
let storageModule: typeof import('../storage');
let savedOriginalDataDir: string | undefined;

beforeAll(async () => {
	savedOriginalDataDir = process.env.DATA_DIR;
	tempDir = await mkdtemp(join(tmpdir(), 'perseus-storage-reclaim-'));
	process.env.DATA_DIR = tempDir;
	storageModule = await import('../storage');
	await storageModule.initializeStorage();
});

afterAll(async () => {
	await rm(tempDir, { recursive: true, force: true });
	if (savedOriginalDataDir === undefined) {
		delete process.env.DATA_DIR;
	} else {
		process.env.DATA_DIR = savedOriginalDataDir;
	}
});

describe('storage reclaim race — concurrent writer wins between rm and retry', () => {
	it('returns existing when a concurrent writer publishes between empty-file reclaim and retry', async () => {
		// This test deterministically covers the reclaim-race path: the
		// second atomicPublishReservation call finds a file with content
		// (published by a concurrent writer between the rm and retry),
		// reads it, and returns { existing: true, puzzleId: writer's id }.
		resetLinkCallCount();

		const reservationPath = join(tempDir, 'idempotency', 'key-reclaim-deterministic');
		await mkdir(join(tempDir, 'idempotency'), { recursive: true });
		await writeFile(reservationPath, '', { flag: 'wx' });

		const result = await storageModule.reserveIdempotencyKey(
			'key-reclaim-deterministic',
			'puzzle-reclaim-loser'
		);

		expect(result).toEqual({ existing: true, puzzleId: 'puzzle-concurrent-winner' });
		expect(getLinkCallCount()).toBe(2);
	});
});
