/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The admin D1 ownership row is a mirror used only to name admin puzzles in
 * player stats; KV metadata is the source of truth for admin puzzle existence
 * (matching the Bun admin path, which treats the mirror as best-effort). When
 * the D1 insert fails (outage / missing binding), the upload must still
 * succeed so a transient D1 issue doesn't take admin puzzle creation down.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../services/storage.worker', () => ({
	getPuzzle: vi.fn(),
	deletePuzzleAssets: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	createPuzzleMetadata: vi.fn().mockResolvedValue(undefined),
	uploadOriginalImage: vi.fn().mockResolvedValue(undefined),
	deleteOriginalImage: vi.fn().mockResolvedValue({ success: true }),
	listPuzzles: vi.fn()
}));

vi.mock('../../db.worker', () => ({
	getWorkerDb: vi.fn(() => ({}))
}));

vi.mock('@perseus/shared', () => ({
	insertPuzzleOwnership: vi.fn().mockResolvedValue(undefined),
	deletePuzzleOwnership: vi.fn().mockResolvedValue(undefined),
	deletePuzzleStats: vi.fn().mockResolvedValue(undefined),
	SYSTEM_OWNER_ID: 'system'
}));

vi.mock('../../middleware/auth.worker', () => ({
	verifySession: vi.fn(),
	requireAuth: async (c: any, next: any) => {
		c.set('session', { userId: 'admin', username: 'admin', role: 'admin' });
		return next();
	},
	createSession: vi.fn(),
	setSessionCookie: vi.fn(),
	clearSessionCookie: vi.fn(),
	getSessionToken: vi.fn(() => 'valid-token'),
	revokeSession: vi.fn()
}));

import admin from '../admin.worker';
import { insertPuzzleOwnership } from '@perseus/shared';
import { __resetRateLimitStore } from '../../middleware/rate-limit.worker';

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);

const baseEnv = {
	ADMIN_PASSKEY: 'test-passkey',
	JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
	PUZZLE_METADATA: {} as KVNamespace,
	PUZZLES_BUCKET: {} as R2Bucket,
	PUZZLE_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) }
};

function buildFormData(): FormData {
	const formData = new FormData();
	formData.append('name', 'Mirror Puzzle');
	formData.append('pieceCount', '225');
	const blob = new Blob([PNG_HEADER], { type: 'image/png' });
	formData.append('image', blob, 'test.png');
	return formData;
}

describe('Admin Worker - POST /puzzles D1 ownership mirror is best-effort', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('succeeds (201) when the D1 ownership mirror insert fails', async () => {
		vi.mocked(insertPuzzleOwnership).mockRejectedValueOnce(new Error('D1 unavailable'));

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: buildFormData()
		});

		const res = await admin.fetch(req, baseEnv as any);

		// Upload must still succeed: KV metadata is the source of truth for
		// admin puzzles, and the D1 row is only a naming mirror.
		expect(res.status).toBe(201);
		expect(insertPuzzleOwnership).toHaveBeenCalledTimes(1);
		// The workflow still kicks off despite the mirror failure.
		expect(baseEnv.PUZZLE_WORKFLOW.create).toHaveBeenCalledTimes(1);
	});
});
