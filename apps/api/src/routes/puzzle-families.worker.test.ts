/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import puzzleFamilies from './puzzle-families.worker';
import * as storage from '../services/storage.worker';
import * as playerAuth from '../services/player-auth.worker';
import { insertPuzzleFamilyOwnership, validateImageEndMarker } from '@perseus/shared';
import { MAX_FILE_SIZE, MAX_IMAGE_DIMENSION, PUZZLE_CATEGORIES } from '@perseus/types';
import { makeFamilyMetadata } from './__tests__/helpers/family-fixtures';

const dbContextMock = vi.hoisted(() => ({
	db: {},
	completionWrites: {
		isPuzzleTombstoned: vi.fn().mockResolvedValue(false)
	}
}));

const leaderboardMocks = vi.hoisted(() => ({
	listPuzzleLeaderboard: vi.fn(),
	resolveLeaderboardIdentities: vi.fn()
}));

vi.mock('../db.worker', () => ({
	getWorkerDb: vi.fn(() => dbContextMock.db),
	getWorkerDbContext: vi.fn(() => dbContextMock)
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	return {
		...actual,
		validateImageEndMarker: vi.fn().mockResolvedValue(true),
		insertPuzzleFamilyOwnership: vi.fn().mockResolvedValue(undefined),
		deletePuzzleFamilyOwnership: vi.fn().mockResolvedValue(undefined),
		listPuzzleLeaderboard: leaderboardMocks.listPuzzleLeaderboard,
		resolveLeaderboardIdentities: leaderboardMocks.resolveLeaderboardIdentities
	};
});

vi.mock('../services/storage.worker', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../services/storage.worker')>();
	return {
		...actual,
		uploadOriginalImage: vi.fn(),
		createFamilyMetadata: vi.fn(),
		createPuzzleMetadata: vi.fn(),
		deleteFamilyMetadata: vi.fn(),
		deletePuzzleMetadata: vi.fn(),
		deleteOriginalImage: vi.fn(),
		getFamily: vi.fn(),
		listFamiliesPage: vi.fn(),
		enrichFamilySummary: vi.fn(),
		getImage: vi.fn()
	};
});

vi.mock('../services/player-auth.worker', () => ({
	getPlayerSession: vi.fn()
}));

const PNG_HEADER = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00
]);

const FAMILY_ID = '550e8400-e29b-41d4-a716-446655440000';

function makePngHeader(width: number, height: number): Uint8Array {
	const header = new Uint8Array(PNG_HEADER);
	const view = new DataView(header.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return header;
}

function mockSignedInSession() {
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

function signedInPostRequest(formData: FormData): Request {
	return new Request('http://localhost/', {
		method: 'POST',
		headers: { Cookie: 'perseus_player_session=player-token' },
		body: formData
	});
}

function familyForm(image = new Blob([PNG_HEADER], { type: 'image/png' })): FormData {
	const formData = new FormData();
	formData.append('name', 'Player Family');
	formData.append('image', image, 'test.png');
	return formData;
}

describe('Puzzle Family Routes', () => {
	const mockEnv = {
		PUZZLE_METADATA: {} as KVNamespace,
		PUZZLES_BUCKET: {} as R2Bucket,
		PUZZLE_WORKFLOW: {
			create: vi.fn().mockResolvedValue({ id: 'workflow-id' })
		}
	};

	beforeEach(() => {
		vi.clearAllMocks();
		dbContextMock.completionWrites.isPuzzleTombstoned.mockResolvedValue(false);
	});

	describe('GET /', () => {
		it('returns ready families with pagination', async () => {
			const familySummary = {
				id: FAMILY_ID,
				name: 'Test Family',
				aspectRatio: '1:1' as const,
				status: 'ready' as const,
				createdAt: 1000,
				variants: {
					easy: {
						id: 'v-e',
						difficulty: 'easy' as const,
						pieceCount: 16,
						status: 'ready' as const
					},
					normal: {
						id: 'v-n',
						difficulty: 'normal' as const,
						pieceCount: 49,
						status: 'ready' as const
					},
					hard: {
						id: 'v-h',
						difficulty: 'hard' as const,
						pieceCount: 100,
						status: 'ready' as const
					}
				}
			};
			vi.mocked(storage.listFamiliesPage).mockResolvedValue({
				families: [familySummary],
				total: 1,
				offset: 0,
				limit: 20
			});

			const res = await puzzleFamilies.fetch(new Request('http://localhost/'), mockEnv as any);

			expect(res.status).toBe(200);
			const body = (await res.json()) as any;
			expect(body.families).toEqual([familySummary]);
			expect(storage.listFamiliesPage).toHaveBeenCalledWith(mockEnv.PUZZLE_METADATA, {
				q: undefined,
				category: undefined,
				offset: 0,
				limit: 20,
				cursor: undefined,
				readyOnly: true
			});
		});
		it.each([
			{ query: 'offset=abc', offset: 0, limit: 20 },
			{ query: 'offset=-5', offset: 0, limit: 20 },
			{ query: 'limit=abc', offset: 0, limit: 20 },
			{ query: 'limit=0', offset: 0, limit: 20 },
			{ query: 'limit=999', offset: 0, limit: 20 }
		])(
			'falls back to defaults for invalid pagination query $query',
			async ({ query, offset, limit }) => {
				vi.mocked(storage.listFamiliesPage).mockResolvedValue({
					families: [],
					total: 0,
					offset,
					limit
				});

				const res = await puzzleFamilies.fetch(
					new Request(`http://localhost/?${query}`),
					mockEnv as any
				);

				expect(res.status).toBe(200);
				expect(storage.listFamiliesPage).toHaveBeenCalledWith(mockEnv.PUZZLE_METADATA, {
					q: undefined,
					category: undefined,
					offset,
					limit,
					cursor: undefined,
					readyOnly: true
				});
			}
		);

		it('passes undefined category for an invalid category query', async () => {
			vi.mocked(storage.listFamiliesPage).mockResolvedValue({
				families: [],
				total: 0,
				offset: 0,
				limit: 20
			});

			const res = await puzzleFamilies.fetch(
				new Request('http://localhost/?category=not-a-category'),
				mockEnv as any
			);

			expect(res.status).toBe(200);
			expect(storage.listFamiliesPage).toHaveBeenCalledWith(
				mockEnv.PUZZLE_METADATA,
				expect.objectContaining({ category: undefined })
			);
		});

		it('returns 500 when listing families fails', async () => {
			vi.mocked(storage.listFamiliesPage).mockRejectedValue(new Error('KV unavailable'));

			const res = await puzzleFamilies.fetch(new Request('http://localhost/'), mockEnv as any);

			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({
				error: 'internal_error',
				message: 'Failed to list puzzle families'
			});
		});
	});

	describe('GET /:familyId', () => {
		it('returns family detail with three variant summaries', async () => {
			const family = makeFamilyMetadata(FAMILY_ID, 'ready');
			const enriched = {
				id: family.id,
				name: family.name,
				aspectRatio: family.aspectRatio,
				status: family.status,
				createdAt: family.createdAt,
				variants: {
					easy: {
						id: family.variants.easy,
						difficulty: 'easy' as const,
						pieceCount: 16,
						status: 'ready' as const
					},
					normal: {
						id: family.variants.normal,
						difficulty: 'normal' as const,
						pieceCount: 49,
						status: 'ready' as const
					},
					hard: {
						id: family.variants.hard,
						difficulty: 'hard' as const,
						pieceCount: 100,
						status: 'ready' as const
					}
				}
			};
			vi.mocked(storage.getFamily).mockResolvedValue(family);
			vi.mocked(storage.enrichFamilySummary).mockResolvedValue(enriched);

			const res = await puzzleFamilies.fetch(
				new Request(`http://localhost/${FAMILY_ID}`),
				mockEnv as any
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as any;
			expect(body).toEqual(enriched);
			expect(Object.keys(body.variants)).toEqual(['easy', 'normal', 'hard']);
		});

		it('returns 404 when family is not ready', async () => {
			vi.mocked(storage.getFamily).mockResolvedValue(makeFamilyMetadata(FAMILY_ID, 'processing'));

			const res = await puzzleFamilies.fetch(
				new Request(`http://localhost/${FAMILY_ID}`),
				mockEnv as any
			);

			expect(res.status).toBe(404);
		});

		it('returns 400 for an invalid family ID', async () => {
			const res = await puzzleFamilies.fetch(
				new Request('http://localhost/not-a-uuid'),
				mockEnv as any
			);

			expect(res.status).toBe(400);
		});

		it('returns 500 when retrieving a family fails', async () => {
			vi.mocked(storage.getFamily).mockRejectedValue(new Error('KV unavailable'));

			const res = await puzzleFamilies.fetch(
				new Request(`http://localhost/${FAMILY_ID}`),
				mockEnv as any
			);

			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({
				error: 'internal_error',
				message: 'Failed to retrieve puzzle family'
			});
		});
	});

	describe('POST /', () => {
		it('returns 401 without player session', async () => {
			const formData = new FormData();
			formData.append('name', 'Player Family');
			formData.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'test.png');

			const res = await puzzleFamilies.fetch(
				new Request('http://localhost/', { method: 'POST', body: formData }),
				mockEnv as any
			);

			expect(res.status).toBe(401);
		});

		it('returns 400 when form data cannot be parsed', async () => {
			mockSignedInSession();

			const res = await puzzleFamilies.fetch(
				new Request('http://localhost/', {
					method: 'POST',
					headers: {
						Cookie: 'perseus_player_session=player-token',
						'Content-Type': 'multipart/form-data; boundary=invalid'
					},
					body: 'not multipart data'
				}),
				mockEnv as any
			);

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				error: 'bad_request',
				message: 'Invalid form data'
			});
		});

		it('returns 400 when name is missing', async () => {
			mockSignedInSession();

			const formData = new FormData();
			formData.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'test.png');
			const res = await puzzleFamilies.fetch(signedInPostRequest(formData), mockEnv as any);

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: 'bad_request', message: 'Name is required' });
		});

		it('returns 400 when name exceeds 255 characters', async () => {
			mockSignedInSession();

			const formData = familyForm();
			formData.set('name', 'A'.repeat(256));
			const res = await puzzleFamilies.fetch(signedInPostRequest(formData), mockEnv as any);

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				error: 'bad_request',
				message: 'Name must be at most 255 characters'
			});
		});

		it('returns 400 when aspect ratio is invalid', async () => {
			mockSignedInSession();

			const formData = familyForm();
			formData.set('aspectRatio', '16:9');
			const res = await puzzleFamilies.fetch(signedInPostRequest(formData), mockEnv as any);

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				error: 'bad_request',
				message: 'Invalid aspect ratio. Allowed: 1:1, 4:3, 3:4'
			});
		});

		it('returns 400 when the image file is missing', async () => {
			mockSignedInSession();

			const formData = new FormData();
			formData.append('name', 'Player Family');
			const res = await puzzleFamilies.fetch(signedInPostRequest(formData), mockEnv as any);

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: 'bad_request', message: 'Image file is required' });
		});

		it('returns 400 when category is invalid', async () => {
			mockSignedInSession();

			const formData = familyForm();
			formData.set('category', 'Invalid');
			const res = await puzzleFamilies.fetch(signedInPostRequest(formData), mockEnv as any);

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				error: 'bad_request',
				message: `Invalid category. Allowed: ${PUZZLE_CATEGORIES.join(', ')}`
			});
		});

		it('creates a family with a valid category', async () => {
			mockSignedInSession();
			vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
			vi.mocked(storage.createFamilyMetadata).mockResolvedValue(undefined);
			vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);

			const category = PUZZLE_CATEGORIES[0];
			const formData = familyForm();
			formData.set('category', category);
			const res = await puzzleFamilies.fetch(signedInPostRequest(formData), mockEnv as any);

			expect(res.status).toBe(201);
			expect(insertPuzzleFamilyOwnership).toHaveBeenCalledWith(
				dbContextMock.db,
				expect.objectContaining({ category })
			);
		});

		it('returns 400 when the image exceeds the maximum file size', async () => {
			mockSignedInSession();

			const image = new Blob([new Uint8Array(MAX_FILE_SIZE + 1)], { type: 'image/png' });
			const res = await puzzleFamilies.fetch(
				signedInPostRequest(familyForm(image)),
				mockEnv as any
			);

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				error: 'bad_request',
				message: 'File size exceeds 10MB limit'
			});
		});

		it('returns 400 when the image file type cannot be detected', async () => {
			mockSignedInSession();

			const image = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
			const res = await puzzleFamilies.fetch(
				signedInPostRequest(familyForm(image)),
				mockEnv as any
			);

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				error: 'bad_request',
				message: 'Invalid file type. Allowed: JPEG, PNG, WebP'
			});
		});

		it('returns 400 when PNG dimensions are corrupted', async () => {
			mockSignedInSession();

			const corrupted = new Blob([new Uint8Array([...PNG_HEADER.slice(0, 8), 1, 2, 3, 4])], {
				type: 'image/png'
			});
			const res = await puzzleFamilies.fetch(
				signedInPostRequest(familyForm(corrupted)),
				mockEnv as any
			);

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				error: 'bad_request',
				message: 'Image is corrupted or truncated'
			});
		});

		it('returns 400 when image aspect ratio does not match', async () => {
			mockSignedInSession();

			const formData = familyForm(new Blob([makePngHeader(4, 3)], { type: 'image/png' }));
			formData.set('aspectRatio', '1:1');
			const res = await puzzleFamilies.fetch(signedInPostRequest(formData), mockEnv as any);

			expect(res.status).toBe(400);
			expect(((await res.json()) as any).message).toContain('does not match requested ratio 1:1');
		});

		it('returns 400 when image dimensions exceed the maximum', async () => {
			mockSignedInSession();

			const image = new Blob([makePngHeader(MAX_IMAGE_DIMENSION + 1, MAX_IMAGE_DIMENSION + 1)], {
				type: 'image/png'
			});
			const res = await puzzleFamilies.fetch(
				signedInPostRequest(familyForm(image)),
				mockEnv as any
			);

			expect(res.status).toBe(400);
			expect(((await res.json()) as any).message).toContain('exceed maximum');
		});

		it('returns 400 when image end marker validation fails', async () => {
			mockSignedInSession();
			vi.mocked(validateImageEndMarker).mockResolvedValueOnce(false);

			const res = await puzzleFamilies.fetch(signedInPostRequest(familyForm()), mockEnv as any);

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				error: 'bad_request',
				message: 'Image is corrupted or truncated'
			});
		});

		it('returns 500 when the family ID is tombstoned', async () => {
			mockSignedInSession();
			dbContextMock.completionWrites.isPuzzleTombstoned.mockResolvedValue(true);

			const res = await puzzleFamilies.fetch(signedInPostRequest(familyForm()), mockEnv as any);

			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({
				error: 'internal_error',
				message: 'Failed to allocate puzzle family ID'
			});
		});

		it('returns 500 when uploading the original image fails', async () => {
			mockSignedInSession();
			vi.mocked(storage.uploadOriginalImage).mockRejectedValue(new Error('R2 unavailable'));
			vi.mocked(storage.createFamilyMetadata).mockResolvedValue(undefined);
			vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);
			vi.mocked(storage.deleteFamilyMetadata).mockResolvedValue({ success: true });
			vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true });
			vi.mocked(storage.deleteOriginalImage).mockResolvedValue({ success: true });

			const res = await puzzleFamilies.fetch(signedInPostRequest(familyForm()), mockEnv as any);

			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({
				error: 'internal_error',
				message: 'Failed to upload image'
			});
		});

		it('cleans up metadata and image when puzzle metadata creation fails', async () => {
			mockSignedInSession();
			vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
			vi.mocked(storage.createFamilyMetadata).mockResolvedValue(undefined);
			vi.mocked(storage.createPuzzleMetadata).mockRejectedValue(new Error('KV unavailable'));
			vi.mocked(storage.deleteFamilyMetadata).mockResolvedValue({ success: true });
			vi.mocked(storage.deletePuzzleMetadata).mockResolvedValue({ success: true });
			vi.mocked(storage.deleteOriginalImage).mockResolvedValue({ success: true });

			const res = await puzzleFamilies.fetch(signedInPostRequest(familyForm()), mockEnv as any);

			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({
				error: 'internal_error',
				message: 'Failed to create puzzle metadata'
			});
			expect(storage.deleteFamilyMetadata).toHaveBeenCalledTimes(1);
			expect(storage.deletePuzzleMetadata).toHaveBeenCalledTimes(3);
			expect(storage.deleteOriginalImage).toHaveBeenCalledTimes(1);
			expect(mockEnv.PUZZLE_WORKFLOW.create).not.toHaveBeenCalled();
		});

		it('creates a family with three variant UUIDs and no pieceCount', async () => {
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
			vi.mocked(storage.uploadOriginalImage).mockResolvedValue(undefined);
			vi.mocked(storage.createFamilyMetadata).mockResolvedValue(undefined);
			vi.mocked(storage.createPuzzleMetadata).mockResolvedValue(undefined);

			const formData = new FormData();
			formData.append('name', 'Player Family');
			formData.append('aspectRatio', '1:1');
			formData.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'test.png');

			const res = await puzzleFamilies.fetch(
				new Request('http://localhost/', {
					method: 'POST',
					headers: { Cookie: 'perseus_player_session=player-token' },
					body: formData
				}),
				mockEnv as any
			);

			expect(res.status).toBe(201);
			const body = (await res.json()) as any;
			expect(body.name).toBe('Player Family');
			expect(body.status).toBe('processing');
			expect(body.variants).toBeDefined();
			expect(Object.keys(body.variants)).toEqual(['easy', 'normal', 'hard']);
			expect(storage.createFamilyMetadata).toHaveBeenCalled();
			expect(storage.createPuzzleMetadata).toHaveBeenCalledTimes(3);
			expect(insertPuzzleFamilyOwnership).toHaveBeenCalled();
			expect(mockEnv.PUZZLE_WORKFLOW.create).toHaveBeenCalled();
		});

		it('rejects pieceCount in the form', async () => {
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

			const formData = new FormData();
			formData.append('name', 'Player Family');
			formData.append('pieceCount', '49');
			formData.append('image', new Blob([PNG_HEADER], { type: 'image/png' }), 'test.png');

			const res = await puzzleFamilies.fetch(
				new Request('http://localhost/', {
					method: 'POST',
					headers: { Cookie: 'perseus_player_session=player-token' },
					body: formData
				}),
				mockEnv as any
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as any;
			expect(body.message).toMatch(/pieceCount/i);
		});
	});

	describe('GET /:familyId/thumbnail', () => {
		it('returns family thumbnail for ready family', async () => {
			vi.mocked(storage.getFamily).mockResolvedValue(makeFamilyMetadata(FAMILY_ID, 'ready'));
			vi.mocked(storage.getImage).mockResolvedValue({
				data: new Uint8Array([1, 2, 3]).buffer,
				contentType: 'image/jpeg'
			});

			const res = await puzzleFamilies.fetch(
				new Request(`http://localhost/${FAMILY_ID}/thumbnail`),
				mockEnv as any
			);

			expect(res.status).toBe(200);
			expect(res.headers.get('Content-Type')).toBe('image/jpeg');
		});

		it('returns 400 for an invalid thumbnail family ID', async () => {
			const res = await puzzleFamilies.fetch(
				new Request('http://localhost/not-a-uuid/thumbnail'),
				mockEnv as any
			);

			expect(res.status).toBe(400);
			expect(storage.getFamily).not.toHaveBeenCalled();
		});

		it('returns 404 when the thumbnail family is missing or processing', async () => {
			vi.mocked(storage.getFamily)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce(makeFamilyMetadata(FAMILY_ID, 'processing'));

			const missing = await puzzleFamilies.fetch(
				new Request(`http://localhost/${FAMILY_ID}/thumbnail`),
				mockEnv as any
			);
			const processing = await puzzleFamilies.fetch(
				new Request(`http://localhost/${FAMILY_ID}/thumbnail`),
				mockEnv as any
			);

			expect(missing.status).toBe(404);
			expect(processing.status).toBe(404);
			expect(storage.getImage).not.toHaveBeenCalled();
		});

		it('returns 404 when the thumbnail image is missing', async () => {
			vi.mocked(storage.getFamily).mockResolvedValue(makeFamilyMetadata(FAMILY_ID, 'ready'));
			vi.mocked(storage.getImage).mockResolvedValue(null);

			const res = await puzzleFamilies.fetch(
				new Request(`http://localhost/${FAMILY_ID}/thumbnail`),
				mockEnv as any
			);

			expect(res.status).toBe(404);
		});

		it('returns 500 when retrieving the thumbnail family fails', async () => {
			vi.mocked(storage.getFamily).mockRejectedValue(new Error('KV unavailable'));

			const res = await puzzleFamilies.fetch(
				new Request(`http://localhost/${FAMILY_ID}/thumbnail`),
				mockEnv as any
			);

			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({
				error: 'internal_error',
				message: 'Failed to retrieve thumbnail'
			});
		});
	});

	describe('GET /:familyId/leaderboard', () => {
		beforeEach(() => {
			leaderboardMocks.listPuzzleLeaderboard.mockResolvedValue({
				entries: [
					{
						rank: 1,
						playerId: 'p1',
						bestTimeSeconds: 65,
						achievedAt: 1_000
					}
				]
			});
			leaderboardMocks.resolveLeaderboardIdentities.mockResolvedValue(
				new Map([['p1', { id: 'p1', name: 'Ace', avatarUrl: null }]])
			);
		});

		it('returns family leaderboard entries without email', async () => {
			const res = await puzzleFamilies.fetch(
				new Request(`http://localhost/${FAMILY_ID}/leaderboard?difficulty=normal&mode=standard`),
				mockEnv as any
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as any;
			expect(body.entries[0]).toEqual({
				rank: 1,
				player: { id: 'p1', name: 'Ace', avatarUrl: null },
				bestTimeSeconds: 65,
				achievedAt: 1_000
			});
			expect(body.entries[0].player.email).toBeUndefined();
			expect(leaderboardMocks.listPuzzleLeaderboard).toHaveBeenCalledWith(
				dbContextMock.db,
				expect.objectContaining({
					familyId: FAMILY_ID,
					difficulty: 'normal',
					mode: 'standard',
					viewerPlayerId: undefined
				})
			);
		});

		it('forwards viewerPlayerId from optional auth', async () => {
			vi.mocked(playerAuth.getPlayerSession).mockResolvedValue({
				sessionHash: 'session-hash',
				user: {
					id: 'viewer',
					email: 'viewer@example.com',
					name: 'Viewer',
					createdAt: 1,
					lastLoginAt: 2
				},
				createdAt: 1,
				expiresAt: Date.now() + 1000
			});
			leaderboardMocks.listPuzzleLeaderboard.mockResolvedValue({
				entries: [],
				me: {
					rank: 3,
					playerId: 'viewer',
					bestTimeSeconds: 90,
					achievedAt: 2_000
				}
			});
			leaderboardMocks.resolveLeaderboardIdentities.mockResolvedValue(
				new Map([['viewer', { id: 'viewer', name: 'Viewer', avatarUrl: null }]])
			);

			const res = await puzzleFamilies.fetch(
				new Request(`http://localhost/${FAMILY_ID}/leaderboard`, {
					headers: { Cookie: 'perseus_player_session=player-token' }
				}),
				mockEnv as any
			);
			const body = (await res.json()) as any;
			expect(body.me.rank).toBe(3);
			expect(body.me.player.email).toBeUndefined();
			expect(leaderboardMocks.listPuzzleLeaderboard).toHaveBeenCalledWith(
				dbContextMock.db,
				expect.objectContaining({ viewerPlayerId: 'viewer' })
			);
		});

		it('rejects invalid familyId, difficulty, and mode', async () => {
			const badFamily = await puzzleFamilies.fetch(
				new Request('http://localhost/not-a-uuid/leaderboard'),
				mockEnv as any
			);
			expect(badFamily.status).toBe(400);

			const badDifficulty = await puzzleFamilies.fetch(
				new Request(`http://localhost/${FAMILY_ID}/leaderboard?difficulty=extreme`),
				mockEnv as any
			);
			expect(badDifficulty.status).toBe(400);

			const badMode = await puzzleFamilies.fetch(
				new Request(`http://localhost/${FAMILY_ID}/leaderboard?mode=assisted`),
				mockEnv as any
			);
			expect(badMode.status).toBe(400);
		});

		it('returns 500 when a leaderboard entry cannot be built', async () => {
			leaderboardMocks.listPuzzleLeaderboard.mockResolvedValue({
				entries: [{ rank: 1, playerId: 'p1', bestTimeSeconds: 65, achievedAt: 1_000 }]
			});
			leaderboardMocks.resolveLeaderboardIdentities.mockResolvedValue(
				new Map([['p1', { id: 'p1', name: '', avatarUrl: null }]])
			);

			const res = await puzzleFamilies.fetch(
				new Request(`http://localhost/${FAMILY_ID}/leaderboard`),
				mockEnv as any
			);

			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({
				error: 'internal_error',
				message: 'Failed to build leaderboard'
			});
		});
	});
});
