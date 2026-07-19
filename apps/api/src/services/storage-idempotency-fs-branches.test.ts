/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
	link: vi.fn(),
	mkdir: vi.fn(),
	readFile: vi.fn(),
	readdir: vi.fn(),
	rm: vi.fn(),
	writeFile: vi.fn()
}));

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		link: fsMocks.link,
		mkdir: fsMocks.mkdir,
		readFile: fsMocks.readFile,
		readdir: fsMocks.readdir,
		rm: fsMocks.rm,
		writeFile: fsMocks.writeFile
	};
});

import { releaseIdempotencyKey, reserveIdempotencyKey } from './storage';

describe('filesystem idempotency atomic publish branches', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fsMocks.mkdir.mockResolvedValue(undefined);
		fsMocks.writeFile.mockResolvedValue(undefined);
		fsMocks.rm.mockResolvedValue(undefined);
		fsMocks.readdir.mockResolvedValue([]);
	});

	it('fails after reclaiming two consecutive empty reservation files', async () => {
		fsMocks.readFile.mockResolvedValue('');
		fsMocks.link.mockRejectedValue(
			Object.assign(new Error('already exists'), { code: 'EEXIST' })
		);

		await expect(reserveIdempotencyKey('empty-key', 'puzzle-1')).rejects.toThrow(
			'Idempotency reservation file is empty after reclaim'
		);
		expect(fsMocks.link).toHaveBeenCalledTimes(2);
		expect(fsMocks.rm).toHaveBeenCalledTimes(4);
	});

	it('surfaces a non-EEXIST atomic publish failure', async () => {
		fsMocks.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
		fsMocks.link.mockRejectedValue(
			Object.assign(new Error('permission denied'), { code: 'EACCES' })
		);

		await expect(reserveIdempotencyKey('publish-key', 'puzzle-1')).rejects.toThrow(
			'permission denied'
		);
		expect(fsMocks.rm).toHaveBeenCalledWith(expect.stringContaining('.tmp'), { force: true });
	});

	it('does not release a reservation owned by a different puzzle', async () => {
		fsMocks.readFile.mockResolvedValue('winner-puzzle');

		await releaseIdempotencyKey('owner-key', 'other-puzzle');

		expect(fsMocks.rm).not.toHaveBeenCalled();
	});
});
