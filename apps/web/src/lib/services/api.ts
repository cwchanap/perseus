// API client service for Jigsaw Puzzle Web App
import type {
	Puzzle,
	PuzzleMetadata,
	PuzzleSummary,
	LoginResponse,
	SessionResponse,
	DeletePuzzleResponse,
	PuzzleCategory,
	PlayerSessionResponse,
	PlayerAllowlistEntry,
	PlayerAllowlistResponse,
	PlayerAllowlistMutationResponse,
	PlayerProfile,
	PlayerProfileUpdate,
	PlayerPuzzleSummary,
	PlayerStatRow
} from '$lib/types/puzzle';
import type { PuzzleAspectRatio } from '@perseus/types';
import type { RecordPuzzleCompletionV1 } from '@perseus/types';
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

// Puzzle endpoints
export async function fetchPuzzles(params?: {
	q?: string;
	category?: PuzzleCategory;
	offset?: number;
	limit?: number;
	cursor?: string;
	signal?: AbortSignal;
}): Promise<{
	puzzles: PuzzleSummary[];
	total: number;
	offset: number;
	limit: number;
	nextCursor?: string;
}> {
	const searchParams = new URLSearchParams();
	if (params?.q) searchParams.set('q', params.q);
	if (params?.category) searchParams.set('category', params.category);
	if (params?.cursor) searchParams.set('cursor', params.cursor);
	if (!params?.cursor && params?.offset && params.offset > 0)
		searchParams.set('offset', String(params.offset));
	if (params?.limit && params.limit !== 20) searchParams.set('limit', String(params.limit));
	const query = searchParams.toString();
	const url = query ? `${API_BASE}/api/puzzles?${query}` : `${API_BASE}/api/puzzles`;
	const response = params?.signal ? await fetch(url, { signal: params.signal }) : await fetch(url);
	return handleResponse<{
		puzzles: PuzzleSummary[];
		total: number;
		offset: number;
		limit: number;
		nextCursor?: string;
	}>(response);
}

export async function fetchPuzzle(id: string): Promise<Puzzle> {
	const response = await fetch(`${API_BASE}/api/puzzles/${id}`);
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

// Admin auth endpoints
export async function login(passkey: string): Promise<LoginResponse> {
	const response = await fetch(`${API_BASE}/api/admin/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ passkey })
	});
	return handleResponse<LoginResponse>(response);
}

export async function logout(): Promise<void> {
	const response = await fetch(`${API_BASE}/api/admin/logout`, {
		method: 'POST',
		credentials: 'include'
	});

	await handleVoidResponse(response);
}

export async function checkSession(): Promise<boolean> {
	try {
		const response = await fetch(`${API_BASE}/api/admin/session`, {
			credentials: 'include'
		});
		if (!response.ok) return false;
		const data = await handleResponse<SessionResponse>(response);
		return data.authenticated;
	} catch {
		return false;
	}
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

// Admin puzzle management
export async function fetchAdminPuzzles(): Promise<PuzzleSummary[]> {
	const response = await fetch(`${API_BASE}/api/admin/puzzles`, {
		credentials: 'include'
	});
	const data = await handleResponse<{ puzzles: PuzzleSummary[] }>(response);
	return data.puzzles;
}

export async function createPuzzle(
	name: string,
	pieceCount: number,
	image: File,
	category?: PuzzleCategory,
	aspectRatio?: PuzzleAspectRatio
): Promise<PuzzleMetadata> {
	const formData = new FormData();
	formData.append('name', name);
	formData.append('pieceCount', pieceCount.toString());
	if (aspectRatio) {
		formData.append('aspectRatio', aspectRatio);
	}
	formData.append('image', image);
	if (category) {
		formData.append('category', category);
	}

	const response = await fetch(`${API_BASE}/api/admin/puzzles`, {
		method: 'POST',
		credentials: 'include',
		body: formData
	});
	return handleResponse<PuzzleMetadata>(response);
}

export async function createPlayerPuzzle(
	name: string,
	pieceCount: number,
	image: File,
	category?: PuzzleCategory,
	aspectRatio?: PuzzleAspectRatio
): Promise<PuzzleMetadata> {
	const formData = new FormData();
	formData.append('name', name);
	formData.append('pieceCount', pieceCount.toString());
	if (aspectRatio) {
		formData.append('aspectRatio', aspectRatio);
	}
	formData.append('image', image);
	if (category) {
		formData.append('category', category);
	}

	const response = await fetch(`${API_BASE}/api/puzzles`, {
		method: 'POST',
		credentials: 'include',
		body: formData
	});
	return handleResponse<PuzzleMetadata>(response);
}

export async function deletePuzzle(
	id: string,
	options?: { force?: boolean }
): Promise<DeletePuzzleResponse | null> {
	// Build URL as string to avoid new URL() throwing when API_BASE is empty.
	// Uses POST /api/admin/puzzle-delete/:id (not DELETE /api/admin/puzzles/:id)
	// so the delete route is NOT a sub-path of the narrow CLI Access app's
	// '/api/admin/puzzles' exact path — a service-token holder cannot reach it
	// at the Access gate even after obtaining a session cookie.
	let urlString = `${API_BASE}/api/admin/puzzle-delete/${id}`;
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
}): Promise<{ puzzles: PlayerPuzzleSummary[]; nextCursor?: string }> {
	const searchParams = new URLSearchParams();
	if (params?.limit !== undefined) searchParams.set('limit', String(params.limit));
	if (params?.cursor !== undefined) searchParams.set('cursor', params.cursor);
	const query = searchParams.toString();
	const url = query ? `${API_BASE}/api/player/puzzles?${query}` : `${API_BASE}/api/player/puzzles`;
	const response = await fetch(url, { credentials: 'include', signal: params?.signal });
	return handleResponse<{ puzzles: PlayerPuzzleSummary[]; nextCursor?: string }>(response);
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

export async function recordCompletion(
	puzzleId: string,
	request: RecordPuzzleCompletionV1
): Promise<void> {
	const response = await fetch(`${API_BASE}/api/puzzles/${puzzleId}/complete`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify(request)
	});
	await handleVoidResponse(response);
}

/**
 * @deprecated Legacy `{ timeSeconds }` caller retained until the puzzle route
 * migrates to the sealed v1 request (HPA-372 Tasks 10/11).
 */
export async function recordCompletionLegacy(puzzleId: string, timeSeconds: number): Promise<void> {
	const response = await fetch(`${API_BASE}/api/puzzles/${puzzleId}/complete`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ timeSeconds })
	});
	await handleVoidResponse(response);
}
