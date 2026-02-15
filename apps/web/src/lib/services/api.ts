// API client service for Jigsaw Puzzle Web App
import type {
	Puzzle,
	PuzzleMetadata,
	PuzzleSummary,
	PuzzleListResponse,
	LoginResponse,
	SessionResponse,
	DeletePuzzleResponse
} from '$lib/types/puzzle';
// NOTE: This app is built with adapter-static, so public env vars are embedded at build time.
// Set PUBLIC_API_BASE before building to target a different API.
import { PUBLIC_API_BASE } from '$env/static/public';

// Use empty string (same-origin) as default for Workers deployment.
// In dev, explicitly set PUBLIC_API_BASE to 'http://localhost:3000'.
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
export async function fetchPuzzles(): Promise<PuzzleSummary[]> {
	const response = await fetch(`${API_BASE}/api/puzzles`);
	const data = await handleResponse<PuzzleListResponse>(response);
	return data.puzzles;
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

// Admin puzzle management
export async function fetchAdminPuzzles(): Promise<PuzzleSummary[]> {
	const response = await fetch(`${API_BASE}/api/admin/puzzles`, {
		credentials: 'include'
	});
	const data = await handleResponse<PuzzleListResponse>(response);
	return data.puzzles;
}

export async function createPuzzle(
	name: string,
	pieceCount: number,
	image: File
): Promise<PuzzleMetadata> {
	const formData = new FormData();
	formData.append('name', name);
	formData.append('pieceCount', pieceCount.toString());
	formData.append('image', image);

	const response = await fetch(`${API_BASE}/api/admin/puzzles`, {
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
	// Build URL as string to avoid new URL() throwing when API_BASE is empty
	let urlString = `${API_BASE}/api/admin/puzzles/${id}`;
	if (options?.force) {
		urlString += '?force=true';
	}

	const response = await fetch(urlString, {
		method: 'DELETE',
		credentials: 'include'
	});

	if (response.status === 207) {
		return handleResponse<DeletePuzzleResponse>(response);
	}

	await handleVoidResponse(response);
	return null;
}

export { ApiError };
