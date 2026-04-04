/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Extra coverage tests for admin.worker.ts.
 * Covers cleanup failure branches in POST /puzzles:
 * - image cleanup failure when workflow trigger fails
 * - metadata + image cleanup failures when workflow binding is missing
 * - metadata cleanup failure when metadata creation itself fails
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../services/storage.worker', () => ({
	getPuzzle: vi.fn(),
	deletePuzzleAssets: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	createPuzzleMetadata: vi.fn(),
	uploadOriginalImage: vi.fn(),
	deleteOriginalImage: vi.fn(),
	listPuzzles: vi.fn()
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
import * as storage from '../../services/storage.worker';
import { __resetRateLimitStore } from '../../middleware/rate-limit.worker';

// Valid PNG magic bytes
const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);

const baseEnv = {
	ADMIN_PASSKEY: 'test-passkey',
	JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
	PUZZLE_METADATA: {} as KVNamespace,
	PUZZLES_BUCKET: {} as R2Bucket
};

function buildFormData(): FormData {
	const formData = new FormData();
	formData.append('name', 'Test Puzzle');
	formData.append('pieceCount', '225');
	const blob = new Blob([PNG_HEADER], { type: 'image/png' });
	formData.append('image', blob, 'test.png');
	return formData;
}

import * as authWorker from '../../middleware/auth.worker';

describe('Admin Worker - GET /session error catch (lines 204-205)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns 500 when verifySession throws unexpectedly', async () => {
		vi.mocked(authWorker.verifySession).mockRejectedValue(new Error('JWT_SECRET misconfigured'));

		const mockEnv = {
			...baseEnv,
			PUZZLE_WORKFLOW: { create: vi.fn() }
		};

		const req = new Request('http://localhost/session', {
			method: 'GET',
			headers: { cookie: 'session=valid.token' }
		});

		const res = await admin.fetch(req, mockEnv as any);
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Session verification failed');
	});
});

describe('Admin Worker - POST /login error catch (lines 153-154)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns 500 when createSession throws unexpectedly after valid passkey', async () => {
		vi.mocked(authWorker.createSession).mockRejectedValue(new Error('KV write failed'));

		const mockEnv = {
			...baseEnv,
			PUZZLE_WORKFLOW: { create: vi.fn() }
		};

		const req = new Request('http://localhost/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ passkey: 'test-passkey' })
		});

		const res = await admin.fetch(req, mockEnv as any);
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Failed to process login');
	});
});

describe('Admin Worker - POST /puzzles cleanup failure branches', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetRateLimitStore();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns 400 when request body cannot be parsed as form data (lines 227-228)', async () => {
		const mockEnv = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } };

		// Send a request with Content-Type multipart/form-data but an invalid body
		// that will cause formData() to throw a parse error
		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: {
				cookie: 'session=valid.token',
				'content-type': 'multipart/form-data; boundary=xxxINVALIDxxx'
			},
			body: 'this is not valid multipart data at all'
		});

		const res = await admin.fetch(req, mockEnv as any);

		// Should return 400 for invalid form data
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.message).toBe('Invalid form data');
	});

	it('returns 400 when name is missing from form data (line 236)', async () => {
		const formData = new FormData();
		// No name field
		formData.append('pieceCount', '225');
		const blob = new Blob([PNG_HEADER], { type: 'image/png' });
		formData.append('image', blob, 'test.png');

		const mockEnv = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } };
		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.message).toBe('Name is required');
	});

	it('returns 400 when name exceeds 255 chars (line 241)', async () => {
		const formData = new FormData();
		formData.append('name', 'A'.repeat(256)); // 256 chars > 255 limit
		formData.append('pieceCount', '225');
		const blob = new Blob([PNG_HEADER], { type: 'image/png' });
		formData.append('image', blob, 'test.png');

		const mockEnv = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } };
		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.message).toBe('Name must be at most 255 characters');
	});

	it('returns 400 when pieceCount is missing from form data (line 246)', async () => {
		const formData = new FormData();
		formData.append('name', 'Test Puzzle');
		// No pieceCount field

		const mockEnv = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } };
		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.message).toBe('Piece count is required');
	});

	it('returns 400 when pieceCount is a valid integer but not DEFAULT_PIECE_COUNT (line 261)', async () => {
		const formData = new FormData();
		formData.append('name', 'Test Puzzle');
		formData.append('pieceCount', '100'); // Valid integer but not 225
		const blob = new Blob([PNG_HEADER], { type: 'image/png' });
		formData.append('image', blob, 'test.png');

		const mockEnv = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } };
		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.message).toContain('Invalid piece count');
	});

	it('returns 400 when no image is provided in form data (line 272)', async () => {
		const formData = new FormData();
		formData.append('name', 'Test Puzzle');
		formData.append('pieceCount', '225');
		// No image field

		const mockEnv = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } };
		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.message).toBe('Image file is required');
	});

	it('returns 400 when image exceeds 10MB limit (line 294)', async () => {
		const largeBuf = new Uint8Array(11 * 1024 * 1024); // 11MB
		// PNG magic bytes at the start so magic-byte detection passes if reached
		largeBuf[0] = 0x89;
		largeBuf[1] = 0x50;
		largeBuf[2] = 0x4e;
		largeBuf[3] = 0x47;

		const formData = new FormData();
		formData.append('name', 'Test Puzzle');
		formData.append('pieceCount', '225');
		const blob = new Blob([largeBuf], { type: 'image/png' });
		formData.append('image', blob, 'large.png');

		const mockEnv = { ...baseEnv, PUZZLE_WORKFLOW: { create: vi.fn() } };
		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: formData
		});

		const res = await admin.fetch(req, mockEnv as any);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.message).toBe('File size exceeds 10MB limit');
	});

	it('returns 500 when uploadOriginalImage throws (lines 319-320)', async () => {
		vi.mocked(storage.uploadOriginalImage).mockRejectedValue(new Error('R2 upload failed'));

		const mockEnv = {
			...baseEnv,
			PUZZLE_WORKFLOW: { create: vi.fn() }
		};

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: buildFormData()
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Failed to upload image');
	});

	it('logs error when metadata cleanup fails after workflow trigger failure (line 395)', async () => {
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);
		// Metadata cleanup fails, image cleanup succeeds
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({
			success: false,
			error: new Error('KV delete failed after workflow trigger')
		} as any);
		vi.mocked(storage.deleteOriginalImage).mockResolvedValue({ success: true });

		const mockEnv = {
			...baseEnv,
			PUZZLE_WORKFLOW: {
				create: vi.fn().mockRejectedValue(new Error('Workflow unavailable'))
			}
		};

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: buildFormData()
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Failed to start puzzle processing');
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledTimes(1);
	});

	it('logs error when image cleanup fails after workflow trigger failure', async () => {
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);
		// Metadata cleanup succeeds, but image cleanup fails
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true });
		vi.mocked(storage.deleteOriginalImage).mockResolvedValue({
			success: false,
			error: new Error('R2 delete failed')
		} as any);

		const mockEnv = {
			...baseEnv,
			PUZZLE_WORKFLOW: {
				create: vi.fn().mockRejectedValue(new Error('Workflow unavailable'))
			}
		};

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: buildFormData()
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Failed to start puzzle processing');
		// The image cleanup failure should have been logged
		expect(storage.deleteOriginalImage).toHaveBeenCalledTimes(1);
	});

	it('logs error when metadata cleanup fails after workflow binding is missing', async () => {
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);
		// Metadata cleanup fails
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({
			success: false,
			error: new Error('KV delete failed')
		} as any);
		vi.mocked(storage.deleteOriginalImage).mockResolvedValue({ success: true });

		const mockEnv = {
			...baseEnv
			// No PUZZLE_WORKFLOW binding
		};

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: buildFormData()
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(503);
		const body = (await res.json()) as any;
		expect(body.error).toBe('service_unavailable');
		expect(storage.deletePuzzleMetadata).toHaveBeenCalledTimes(1);
	});

	it('logs error when image cleanup fails after workflow binding is missing', async () => {
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);
		vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true });
		// Image cleanup fails
		vi.mocked(storage.deleteOriginalImage).mockResolvedValue({
			success: false,
			error: new Error('R2 unavailable')
		} as any);

		const mockEnv = {
			...baseEnv
			// No PUZZLE_WORKFLOW binding
		};

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: buildFormData()
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(503);
		expect(storage.deleteOriginalImage).toHaveBeenCalledTimes(1);
	});

	it('logs error when image cleanup fails after metadata creation failure', async () => {
		vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
		vi.mocked(storage.createPuzzleMetadata).mockRejectedValue(new Error('KV write failed'));
		// Image cleanup fails
		vi.mocked(storage.deleteOriginalImage).mockResolvedValue({
			success: false,
			error: new Error('R2 cleanup failed')
		} as any);

		const mockEnv = {
			...baseEnv,
			PUZZLE_WORKFLOW: { create: vi.fn() }
		};

		const req = new Request('http://localhost/puzzles', {
			method: 'POST',
			headers: { cookie: 'session=valid.token' },
			body: buildFormData()
		});

		const res = await admin.fetch(req, mockEnv as any);

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Failed to create puzzle metadata');
		expect(storage.deleteOriginalImage).toHaveBeenCalledTimes(1);
	});
});
