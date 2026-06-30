/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage tests for puzzles.worker.ts:
 * - Workflow trigger failure cleanup with ownership delete rejection (line 483)
 * - Metadata cleanup failure log on workflow trigger failure (line 487)
 * - Image cleanup failure log on workflow trigger failure (line 494)
 * - Outer catch block for unexpected errors (lines 504-505)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../db.worker', () => ({
	getWorkerDb: vi.fn(() => ({}))
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	return {
		...actual,
		insertPuzzleOwnership: vi.fn().mockResolvedValue(undefined),
		deletePuzzleOwnership: vi.fn().mockResolvedValue(undefined)
	};
});

vi.mock('../../services/storage.worker');
vi.mock('../../services/player-auth.worker', () => ({
	getPlayerSession: vi.fn()
}));

import puzzles from '../puzzles.worker';
import * as storage from '../../services/storage.worker';
import * as playerAuth from '../../services/player-auth.worker';
import { deletePuzzleOwnership, insertPuzzleOwnership } from '@perseus/shared';

// Minimal valid PNG (3:4 ratio)
const PNG_HEADER = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x08, 0x02, 0x00, 0x00, 0x00, 0x45, 0x48, 0xcc,
	0x42
]);

const mockEnv = {
	PUZZLE_METADATA: {} as KVNamespace,
	PUZZLES_BUCKET: {} as R2Bucket,
	PUZZLE_WORKFLOW: {
		create: vi.fn().mockResolvedValue({ id: 'workflow-id' })
	}
};

function buildForm(): FormData {
	const fd = new FormData();
	fd.append('name', 'Coverage Puzzle');
	fd.append('pieceCount', '48');
	fd.append('aspectRatio', '3:4');
	fd.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'test.png');
	return fd;
}

async function post(fd: FormData, env: any = mockEnv): Promise<Response> {
	return puzzles.fetch(
		new Request('http://localhost/', {
			method: 'POST',
			headers: { Cookie: 'perseus_player_session=player-token' },
			body: fd
		}),
		env as any
	);
}

function mockSession() {
	vi.mocked(playerAuth.getPlayerSession).mockResolvedValue({
		sessionHash: 'session-hash',
		user: {
			id: 'player-1',
			email: 'player@example.com',
			createdAt: 1000,
			lastLoginAt: 2000
		},
		createdAt: 2000,
		expiresAt: Date.now() + 1000
	});
}

describe('POST / - workflow trigger failure cleanup logs', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSession();
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true });
		vi.mocked(storage.deleteOriginalImage).mockResolvedValue({ success: true });
		mockEnv.PUZZLE_WORKFLOW.create = vi.fn().mockRejectedValue(new Error('workflow down'));
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('logs when ownership delete rejects during workflow-trigger cleanup (line 483)', async () => {
		vi.mocked(deletePuzzleOwnership).mockRejectedValueOnce(new Error('D1 delete failed'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await post(buildForm());

		expect(res.status).toBe(500);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Failed to cleanup ownership after workflow trigger failure:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('logs when metadata cleanup fails during workflow-trigger cleanup (line 487)', async () => {
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({
			success: false,
			error: new Error('KV delete failed')
		} as any);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await post(buildForm());

		expect(res.status).toBe(500);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Failed to cleanup puzzle metadata after workflow trigger failure:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('logs when image cleanup fails during workflow-trigger cleanup (line 494)', async () => {
		vi.mocked(storage.deleteOriginalImage).mockResolvedValue({
			success: false,
			error: new Error('R2 delete failed')
		} as any);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await post(buildForm());

		expect(res.status).toBe(500);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Failed to cleanup original image after workflow trigger failure:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});
});

describe('POST / - ownership insert failure cleanup logs (lines 433, 440)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSession();
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true });
		vi.mocked(storage.deleteOriginalImage).mockResolvedValue({ success: true });
		vi.mocked(deletePuzzleOwnership).mockResolvedValue(undefined);
		mockEnv.PUZZLE_WORKFLOW.create = vi.fn().mockResolvedValue({ id: 'workflow-id' });
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('logs when metadata cleanup fails after ownership insert failure (line 433)', async () => {
		vi.mocked(insertPuzzleOwnership).mockRejectedValueOnce(new Error('D1 down'));
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({
			success: false,
			error: new Error('KV delete failed')
		} as any);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await post(buildForm());

		expect(res.status).toBe(500);
		expect(((await res.json()) as any).message).toBe('Failed to record puzzle ownership');
		expect(consoleSpy).toHaveBeenCalledWith(
			'Failed to cleanup puzzle metadata after ownership insert failure:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('logs when image cleanup fails after ownership insert failure (line 440)', async () => {
		vi.mocked(insertPuzzleOwnership).mockRejectedValueOnce(new Error('D1 down'));
		vi.mocked(storage.deleteOriginalImage).mockResolvedValue({
			success: false,
			error: new Error('R2 delete failed')
		} as any);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await post(buildForm());

		expect(res.status).toBe(500);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Failed to cleanup original image after ownership insert failure:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});
});

describe('POST / - missing workflow binding cleanup logs (lines 450, 454, 461)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSession();
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true });
		vi.mocked(storage.deleteOriginalImage).mockResolvedValue({ success: true });
		vi.mocked(deletePuzzleOwnership).mockResolvedValue(undefined);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('logs when ownership cleanup rejects after missing workflow binding (line 450)', async () => {
		vi.mocked(deletePuzzleOwnership).mockRejectedValueOnce(new Error('D1 down'));
		const envWithoutWorkflow = {
			PUZZLE_METADATA: mockEnv.PUZZLE_METADATA,
			PUZZLES_BUCKET: mockEnv.PUZZLES_BUCKET
		};
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await post(buildForm(), envWithoutWorkflow);

		expect(res.status).toBe(503);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Failed to cleanup ownership after missing workflow binding:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('logs when metadata cleanup fails after missing workflow binding (line 454)', async () => {
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({
			success: false,
			error: new Error('KV delete failed')
		} as any);
		const envWithoutWorkflow = {
			PUZZLE_METADATA: mockEnv.PUZZLE_METADATA,
			PUZZLES_BUCKET: mockEnv.PUZZLES_BUCKET
		};
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await post(buildForm(), envWithoutWorkflow);

		expect(res.status).toBe(503);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Failed to cleanup puzzle metadata after missing workflow binding:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('logs when image cleanup fails after missing workflow binding (line 461)', async () => {
		vi.mocked(storage.deleteOriginalImage).mockResolvedValue({
			success: false,
			error: new Error('R2 delete failed')
		} as any);
		const envWithoutWorkflow = {
			PUZZLE_METADATA: mockEnv.PUZZLE_METADATA,
			PUZZLES_BUCKET: mockEnv.PUZZLES_BUCKET
		};
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await post(buildForm(), envWithoutWorkflow);

		expect(res.status).toBe(503);
		expect(consoleSpy).toHaveBeenCalledWith(
			'Failed to cleanup original image after missing workflow binding:',
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});
});

describe('POST / - outer catch block (lines 504-505)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSession();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns 500 when crypto.randomUUID throws (outer catch)', async () => {
		// crypto.randomUUID() is called at line 367, outside all inner
		// try-catch blocks. If it throws, the outer catch fires.
		const uuidSpy = vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(() => {
			throw new Error('UUID generation failed');
		});

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await post(buildForm());

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Failed to create puzzle');
		expect(consoleSpy).toHaveBeenCalledWith('Error creating puzzle:', expect.any(Error));
		consoleSpy.mockRestore();
		uuidSpy.mockRestore();
	});
});
