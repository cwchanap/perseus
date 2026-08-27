// API client service for Jigsaw Puzzle Web App
import type {
	Puzzle,
	DeletePuzzleResponse,
	PuzzleCategory,
	PlayerSessionResponse,
	PlayerAllowlistEntry,
	PlayerAllowlistResponse,
	PlayerAllowlistMutationResponse,
	PlayerProfile,
	PlayerProfileUpdate,
	PlayerOwnedFamilySummary,
	PlayerStatRow,
	PuzzleFamilyListResponse,
	PuzzleFamilyMetadata
} from '$lib/types/puzzle';
import type { PuzzleAspectRatio, PuzzleFamilySummary, PuzzleDifficulty } from '@perseus/types';
import type {
	RecordPuzzleCompletionV2,
	PlayerProgressionSummary,
	PuzzleLeaderboardResponse,
	OverallLeaderboardResponse,
	CompletionAwards,
	RecordPuzzleCompletionResponse
} from '@perseus/types';
// NOTE: This app is built with adapter-static, so public env vars are embedded at build time.
// Set PUBLIC_API_BASE before building to target a different API.
import { PUBLIC_API_BASE } from '$env/static/public';

// Use empty string (same-origin) as default for Workers deployment.
// In local dev, explicitly set PUBLIC_API_BASE to 'http://localhost:4690'.
const API_BASE = PUBLIC_API_BASE || '';

class ApiError extends Error {
	constructor(
		public status: number,
		public error: string,
		message: string
	) {
		super(message);
		this.name = 'ApiError';
	}
}

function parseJsonSafely(response: Response): Promise<unknown> {
	return response
		.clone()
		.json()
		.catch(() => null);
}

function normalizeErrorPayload(
	payload: unknown,
	fallbackMessage: string
): { error: string; message: string } {
	if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
		const record = payload as Record<string, unknown>;
		const error = typeof record.error === 'string' ? record.error : undefined;
		const message = typeof record.message === 'string' ? record.message : undefined;

		return {
			error: error ?? 'Unknown error',
			message: message ?? fallbackMessage
		};
	}

	return {
		error: 'Unknown error',
		message: fallbackMessage
	};
}

async function handleResponse<T>(response: Response): Promise<T> {
	if (!response.ok) {
		const parsedError = await parseJsonSafely(response);
		const { error, message } = normalizeErrorPayload(parsedError, response.statusText);
		throw new ApiError(response.status, error, message);
	}

	let parsedBody: unknown;
	try {
		parsedBody = await response.json();
	} catch {
		throw new Error(`Invalid JSON response (${response.status} ${response.statusText})`);
	}

	if (parsedBody === null || parsedBody === undefined) {
		throw new Error(`Invalid JSON response (${response.status} ${response.statusText})`);
	}

	if (typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
		throw new Error(
			`Unexpected response format (${response.status} ${response.statusText}): expected object`
		);
	}

	return parsedBody as T;
}

async function handleVoidResponse(response: Response): Promise<void> {
	if (!response.ok) {
		const parsedError = await parseJsonSafely(response);
		const { error, message } = normalizeErrorPayload(parsedError, response.statusText);
		throw new ApiError(response.status, error, message);
	}

	if (response.status === 204) {
		return;
	}

	const contentLength = response.headers.get('content-length');
	const contentType = response.headers.get('content-type')?.toLowerCase();

	if (contentLength === '0' || !contentType) {
		return;
	}

	if (!contentType.includes('application/json')) {
		return;
	}

	// Best-effort parse to surface malformed JSON responses
	await parseJsonSafely(response);
}

// Puzzle family catalog (public gallery)
export async function fetchPuzzles(params?: {
	q?: string;
	category?: PuzzleCategory;
	offset?: number;
	limit?: number;
	cursor?: string;
	signal?: AbortSignal;
}): Promise<PuzzleFamilyListResponse> {
	const searchParams = new URLSearchParams();
	if (params?.q) searchParams.set('q', params.q);
	if (params?.category) searchParams.set('category', params.category);
	if (params?.cursor) searchParams.set('cursor', params.cursor);
	if (!params?.cursor && params?.offset && params.offset > 0)
		searchParams.set('offset', String(params.offset));
	if (params?.limit && params.limit !== 20) searchParams.set('limit', String(params.limit));
	const query = searchParams.toString();
	const url = query
		? `${API_BASE}/api/puzzle-families?${query}`
		: `${API_BASE}/api/puzzle-families`;
	const response = params?.signal ? await fetch(url, { signal: params.signal }) : await fetch(url);
	return handleResponse<PuzzleFamilyListResponse>(response);
}

export async function fetchPuzzle(id: string, signal?: AbortSignal): Promise<Puzzle> {
	const response = signal
		? await fetch(`${API_BASE}/api/puzzles/${id}`, { signal })
		: await fetch(`${API_BASE}/api/puzzles/${id}`);
	return handleResponse<Puzzle>(response);
}

export function getThumbnailUrl(puzzleId: string): string {
	return `${API_BASE}/api/puzzles/${puzzleId}/thumbnail`;
}

export function getPieceImageUrl(puzzleId: string, pieceId: number): string {
	return `${API_BASE}/api/puzzles/${puzzleId}/pieces/${pieceId}/image`;
}

export function getReferenceImageUrl(puzzleId: string): string {
	return `${API_BASE}/api/puzzles/${puzzleId}/reference`;
}

export async function getPlayerSession(): Promise<PlayerSessionResponse> {
	const response = await fetch(`${API_BASE}/api/auth/session`, {
		credentials: 'include'
	});
	return handleResponse<PlayerSessionResponse>(response);
}

export async function logoutPlayer(): Promise<void> {
	const response = await fetch(`${API_BASE}/api/auth/logout`, {
		method: 'POST',
		credentials: 'include'
	});

	await handleVoidResponse(response);
}

function buildAuthReturnTo(returnTo: string): string {
	if (!API_BASE || !returnTo.startsWith('/') || returnTo.startsWith('//')) {
		return returnTo;
	}

	if (typeof window === 'undefined') {
		return returnTo;
	}

	try {
		return new URL(returnTo, window.location.origin).toString();
	} catch {
		return returnTo;
	}
}

export function getGoogleLoginUrl(returnTo = '/'): string {
	const searchParams = new URLSearchParams({ returnTo: buildAuthReturnTo(returnTo) });
	return `${API_BASE}/api/auth/google/start?${searchParams.toString()}`;
}

export async function fetchPlayerAllowlist(): Promise<PlayerAllowlistEntry[]> {
	const response = await fetch(`${API_BASE}/api/admin/player-allowlist`, {
		credentials: 'include'
	});
	const data = await handleResponse<PlayerAllowlistResponse>(response);
	return data.entries;
}

export async function addPlayerAllowlistEntry(email: string): Promise<PlayerAllowlistEntry> {
	const response = await fetch(`${API_BASE}/api/admin/player-allowlist`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ email })
	});
	const data = await handleResponse<PlayerAllowlistMutationResponse>(response);
	return data.entry;
}

export async function removePlayerAllowlistEntry(email: string): Promise<void> {
	const response = await fetch(
		`${API_BASE}/api/admin/player-allowlist/${encodeURIComponent(email)}`,
		{
			method: 'DELETE',
			credentials: 'include'
		}
	);

	await handleVoidResponse(response);
}

export function getFamilyThumbnailUrl(familyId: string): string {
	return `${API_BASE}/api/puzzle-families/${familyId}/thumbnail`;
}

// Admin puzzle family management
export async function fetchAdminPuzzles(): Promise<PuzzleFamilySummary[]> {
	const response = await fetch(`${API_BASE}/api/admin/puzzle-families`, {
		credentials: 'include'
	});
	const data = await handleResponse<{ families: PuzzleFamilySummary[] }>(response);
	return data.families;
}

export async function createPuzzle(
	name: string,
	image: File,
	category?: PuzzleCategory,
	aspectRatio?: PuzzleAspectRatio
): Promise<PuzzleFamilyMetadata> {
	const formData = new FormData();
	formData.append('name', name);
	if (aspectRatio) {
		formData.append('aspectRatio', aspectRatio);
	}
	formData.append('image', image);
	if (category) {
		formData.append('category', category);
	}

	const response = await fetch(`${API_BASE}/api/admin/puzzle-families`, {
		method: 'POST',
		credentials: 'include',
		body: formData
	});
	return handleResponse<PuzzleFamilyMetadata>(response);
}

export async function createPlayerPuzzle(
	name: string,
	image: File,
	category?: PuzzleCategory,
	aspectRatio?: PuzzleAspectRatio
): Promise<PuzzleFamilyMetadata> {
	const formData = new FormData();
	formData.append('name', name);
	if (aspectRatio) {
		formData.append('aspectRatio', aspectRatio);
	}
	formData.append('image', image);
	if (category) {
		formData.append('category', category);
	}

	const response = await fetch(`${API_BASE}/api/puzzle-families`, {
		method: 'POST',
		credentials: 'include',
		body: formData
	});
	return handleResponse<PuzzleFamilyMetadata>(response);
}

export async function deletePuzzle(
	id: string,
	options?: { force?: boolean }
): Promise<DeletePuzzleResponse | null> {
	// Build URL as string to avoid new URL() throwing when API_BASE is empty.
	// Uses POST /api/admin/puzzle-family-delete/:familyId (not DELETE under the collection path)
	// so the delete route is NOT a sub-path of the narrow CLI Access app's
	// '/api/admin/puzzle-families' exact path — a service-token holder cannot reach it
	// at the Access gate.
	let urlString = `${API_BASE}/api/admin/puzzle-family-delete/${id}`;
	if (options?.force) {
		urlString += '?force=true';
	}

	const response = await fetch(urlString, {
		method: 'POST',
		credentials: 'include'
	});

	if (response.status === 207) {
		return handleResponse<DeletePuzzleResponse>(response);
	}

	await handleVoidResponse(response);
	return null;
}

export { ApiError };

// Player profile endpoints
export async function getPlayerProfile(signal?: AbortSignal): Promise<PlayerProfile> {
	const response = await fetch(`${API_BASE}/api/player/profile`, {
		credentials: 'include',
		signal
	});
	const profile = await handleResponse<PlayerProfile>(response);
	// Uploaded avatars are served as origin-relative paths ("/api/player/.../avatar").
	// In local dev the web and API origins differ, so prefix API_BASE so the
	// <img src> points at the API. Absolute URLs (e.g. OAuth pictures) and null
	// pass through unchanged.
	return { ...profile, picture: resolveAssetUrl(profile.picture) };
}

export async function updatePlayerProfile(update: PlayerProfileUpdate): Promise<void> {
	const response = await fetch(`${API_BASE}/api/player/profile`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify(update)
	});
	await handleVoidResponse(response);
}

export async function uploadPlayerAvatar(file: File): Promise<{ avatarUrl: string }> {
	const formData = new FormData();
	formData.append('avatar', file);
	const response = await fetch(`${API_BASE}/api/player/avatar`, {
		method: 'POST',
		credentials: 'include',
		body: formData
	});
	return handleResponse<{ avatarUrl: string }>(response);
}

export function getAvatarUrl(playerId: string): string {
	return `${API_BASE}/api/player/${playerId}/avatar`;
}

// Resolve an asset URL returned by the API into a renderable src. Origin-
// relative paths ("/api/...") are prefixed with API_BASE (needed in local dev
// where web and API origins differ); absolute URLs and null pass through.
export function resolveAssetUrl(url: string | null | undefined): string | null {
	if (!url) return null;
	if (/^https?:\/\//i.test(url)) return url;
	if (url.startsWith('/')) return `${API_BASE}${url}`;
	return url;
}

export async function getPlayerPuzzles(params?: {
	limit?: number;
	cursor?: string;
	signal?: AbortSignal;
}): Promise<{ families: PlayerOwnedFamilySummary[]; nextCursor?: string }> {
	const searchParams = new URLSearchParams();
	if (params?.limit !== undefined) searchParams.set('limit', String(params.limit));
	if (params?.cursor !== undefined) searchParams.set('cursor', params.cursor);
	const query = searchParams.toString();
	const url = query
		? `${API_BASE}/api/player/puzzle-families?${query}`
		: `${API_BASE}/api/player/puzzle-families`;
	const response = await fetch(url, { credentials: 'include', signal: params?.signal });
	return handleResponse<{ families: PlayerOwnedFamilySummary[]; nextCursor?: string }>(response);
}

export async function getPlayerStats(params?: {
	limit?: number;
	cursor?: string;
	signal?: AbortSignal;
}): Promise<{ stats: PlayerStatRow[]; nextCursor?: string }> {
	const searchParams = new URLSearchParams();
	if (params?.limit !== undefined) searchParams.set('limit', String(params.limit));
	if (params?.cursor !== undefined) searchParams.set('cursor', params.cursor);
	const query = searchParams.toString();
	const url = query ? `${API_BASE}/api/player/stats?${query}` : `${API_BASE}/api/player/stats`;
	const response = await fetch(url, { credentials: 'include', signal: params?.signal });
	return handleResponse<{ stats: PlayerStatRow[]; nextCursor?: string }>(response);
}

export async function getPlayerProgression(
	signal?: AbortSignal
): Promise<PlayerProgressionSummary> {
	const response = await fetch(`${API_BASE}/api/player/progression`, {
		credentials: 'include',
		signal
	});
	return handleResponse<PlayerProgressionSummary>(response);
}

export async function fetchOverallLeaderboard(
	signal?: AbortSignal
): Promise<OverallLeaderboardResponse> {
	const response = await fetch(`${API_BASE}/api/leaderboard`, {
		credentials: 'include',
		signal
	});
	const data = await handleResponse<OverallLeaderboardResponse>(response);
	return {
		...data,
		entries: data.entries.map((entry) => ({
			...entry,
			player: {
				...entry.player,
				avatarUrl: resolveAssetUrl(entry.player.avatarUrl)
			}
		})),
		...(data.me
			? {
					me: {
						...data.me,
						player: {
							...data.me.player,
							avatarUrl: resolveAssetUrl(data.me.player.avatarUrl)
						}
					}
				}
			: {})
	};
}

export async function fetchFamilyLeaderboard(
	familyId: string,
	params: { difficulty: PuzzleDifficulty; mode: 'standard' | 'rotation' },
	signal?: AbortSignal
): Promise<PuzzleLeaderboardResponse> {
	const searchParams = new URLSearchParams({
		difficulty: params.difficulty,
		mode: params.mode
	});
	const response = await fetch(
		`${API_BASE}/api/puzzle-families/${familyId}/leaderboard?${searchParams.toString()}`,
		{ credentials: 'include', signal }
	);
	const data = await handleResponse<PuzzleLeaderboardResponse>(response);
	return {
		...data,
		entries: data.entries.map((entry) => ({
			...entry,
			player: {
				...entry.player,
				avatarUrl: resolveAssetUrl(entry.player.avatarUrl)
			}
		})),
		...(data.me
			? {
					me: {
						...data.me,
						player: {
							...data.me.player,
							avatarUrl: resolveAssetUrl(data.me.player.avatarUrl)
						}
					}
				}
			: {})
	};
}

export async function fetchFamilyDetail(
	familyId: string,
	signal?: AbortSignal
): Promise<PuzzleFamilySummary> {
	const response = await fetch(`${API_BASE}/api/puzzle-families/${familyId}`, { signal });
	return handleResponse<PuzzleFamilySummary>(response);
}

async function postCompletion(
	puzzleId: string,
	body: unknown
): Promise<CompletionAwards | undefined> {
	const response = await fetch(`${API_BASE}/api/puzzles/${puzzleId}/complete`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify(body)
	});
	const data = await handleResponse<RecordPuzzleCompletionResponse>(response);
	if ('ok' in data && data.ok) return data.awards;
	return undefined;
}

export async function recordCompletion(
	puzzleId: string,
	request: RecordPuzzleCompletionV2
): Promise<CompletionAwards | undefined> {
	return postCompletion(puzzleId, request);
}
