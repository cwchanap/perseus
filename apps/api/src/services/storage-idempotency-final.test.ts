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

describe('filesystem idempotency error branches', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fsMocks.mkdir.mockResolvedValue(undefined);
		fsMocks.writeFile.mockResolvedValue(undefined);
		fsMocks.rm.mockResolvedValue(undefined);
		fsMocks.readdir.mockResolvedValue([]);
	});

	it('surfaces a non-ENOENT reservation read failure', async () => {
		fsMocks.readFile.mockRejectedValue(
			Object.assign(new Error('reservation unreadable'), { code: 'EACCES' })
		);

		await expect(reserveIdempotencyKey('read-error-key', 'puzzle-1')).rejects.toThrow(
			'reservation unreadable'
		);
		expect(fsMocks.link).not.toHaveBeenCalled();
	});

	it('removes a reservation owned by the requested puzzle', async () => {
		fsMocks.readFile.mockResolvedValue('puzzle-1');

		await releaseIdempotencyKey('release-key', 'puzzle-1');

		expect(fsMocks.rm).toHaveBeenCalledWith(expect.stringContaining('release-key'), {
			force: true
		});
	});

	it('logs and rethrows a non-ENOENT reservation release failure', async () => {
		fsMocks.readFile.mockRejectedValue(
			Object.assign(new Error('release unreadable'), { code: 'EACCES' })
		);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(releaseIdempotencyKey('release-error-key', 'puzzle-1')).rejects.toThrow(
			'release unreadable'
		);
		expect(consoleSpy).toHaveBeenCalledWith(
			"Failed to release idempotency key 'release-error-key':",
			expect.any(Error)
		);
	});
});
